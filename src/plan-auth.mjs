import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { badRequest } from './store.mjs';
import { openPlanVault } from './plan-vault.mjs';

const issuer = 'https://auth.openai.com';
const tokenUrl = issuer + '/api/accounts/oauth/token';
const resource = 'https://api.openai.com/v1';
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const entryClient = 'dynamic_agent_client';
const unusableRefresh = new Set(['invalid_grant','invalid_refresh_token','token_expired',
  'refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
const fresh = () => randomBytes(32).toString('base64url');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const validToken = value => typeof value === 'string' && /^[\x21-\x7e]{1,32768}$/.test(value);
const hash = value => createHash('sha256').update(value).digest();
const planEnabled = session => Boolean(session?.scopes.includes('chatgpt.tokens.use.direct') &&
  session.scopes.includes('resource.invoke'));

function registration(state, id) {
  if (typeof id !== 'string' || !Object.hasOwn(state.accounts, id)) throw badRequest('Choose a saved ChatGPT account.', 409);
  return state.accounts[id];
}

function checkRedirect(value) {
  const uri = new URL(value);
  if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || uri.username || uri.password ||
      uri.pathname !== '/auth/callback' || uri.search || uri.hash || uri.href !== value) {
    throw new Error('Use an HTTP callback on 127.0.0.1 at /auth/callback.');
  }
  return value;
}

function parseSession(data, previous, now) {
  if (!validToken(data.access_token) || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400) {
    throw badRequest('ChatGPT returned an invalid token set. Reconnect this account.', 502);
  }
  const scopes = data.scope === undefined && previous ? previous.scopes :
    typeof data.scope === 'string' ? [...new Set(data.scope.split(/\s+/).filter(Boolean))] : [];
  if (!scopes.includes('openid')) throw badRequest('ChatGPT did not grant the requested identity scope.', 403);
  if (scopes.includes('offline_access') && !validToken(data.refresh_token)) {
    throw badRequest('ChatGPT did not supply its renewable session credential. Reconnect this account.', 502);
  }
  const earliest = typeof data.earliest_refresh_at === 'number' ? data.earliest_refresh_at * 1000 :
    Date.parse(data.earliest_refresh_at);
  return {access:data.access_token, refresh:scopes.includes('offline_access') ? data.refresh_token : null,
    idToken:data.id_token ?? previous?.idToken, scopes, expiresAt:now + data.expires_in * 1000,
    earliestRefresh:Number.isFinite(earliest) ? earliest : 0};
}

export function createPlanAuth({directory, agentId = 'personal', redirectUri, fetchImpl = fetch, now = Date.now}) {
  checkRedirect(redirectUri);
  let storage, pending, attemptNumber = 0;
  const vault = () => storage ??= openPlanVault(directory, agentId);

  async function request(url, options = {}) {
    const timeout = AbortSignal.timeout(12000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      return await fetchImpl(url, {...options, signal, redirect:'error', cache:'no-store'});
    } catch {
      throw badRequest('Could not reach ChatGPT authorization. Retry when the connection is available.', 503);
    }
  }

  async function tokenRequest(values, signal) {
    const response = await request(tokenUrl, {method:'POST',body:new URLSearchParams(values),signal});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
      const known = unusableRefresh.has(code) || code === 'invalid_client';
      const message = code === 'invalid_client' ? 'ChatGPT rejected this client registration.' :
        unusableRefresh.has(code) ? 'The ChatGPT authorization is no longer valid. Reconnect the saved account.' :
        'ChatGPT authorization could not complete. Try again.';
      throw Object.assign(badRequest(message, response.status >= 500 ? 503 : 403), {
        oauthCode:known ? code : undefined, grantRejected:response.status >= 400 && response.status <= 599
      });
    }
    if (!data || typeof data !== 'object') throw badRequest('ChatGPT authorization returned an invalid response.', 502);
    return data;
  }

  async function validateIdentity(token, client, nonce, access, refreshing = false) {
    const invalid = () => badRequest('ChatGPT identity verification failed. Start a new sign-in.', 403);
    if (!validToken(token) || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw invalid();
    const [head, payload, sig] = token.split('.');
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(head, 'base64url'));
      claims = JSON.parse(Buffer.from(payload, 'base64url'));
    } catch { throw invalid(); }
    if (!header || header.alg !== 'RS256' || !validId(header.kid) || header.crit || !claims) throw invalid();
    const res = await request(issuer + '/.well-known/jwks.json');
    if (!res.ok) throw badRequest('ChatGPT signing keys are unavailable. Retry sign-in.', 503);
    const keys = await res.json().catch(() => null);
    try {
      const matches = keys.keys.filter(k => k.kid === header.kid && k.kty === 'RSA' &&
        (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
      if (matches.length !== 1) throw invalid();
      const key = createPublicKey({key:matches[0],format:'jwk'});
      if (!verify('RSA-SHA256', Buffer.from(head + '.' + payload), key, Buffer.from(sig, 'base64url'))) throw invalid();
    } catch { throw invalid(); }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== issuer || !audience.includes(client) ||
        ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== client) ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= seconds ||
        !Number.isSafeInteger(claims.iat) || claims.iat > seconds + 60 ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) ||
        ((!refreshing || claims.nonce !== undefined) && claims.nonce !== nonce) ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 ||
        (claims.at_hash !== undefined && (!validToken(access) || claims.at_hash !== hash(access).subarray(0,16).toString('base64url')))) {
      throw invalid();
    }
    const email = typeof claims.email === 'string' && claims.email.length <= 320 && claims.email_verified !== false ? claims.email : null;
    return {subject:claims.sub,email};
  }

  function status() {
    const {activeId,accounts} = vault().load();
    const rows = Object.entries(accounts).map(([id,a]) => ({
      id, label:(a.email || (a.subject ? 'ChatGPT account' : 'Unfinished registration')) + ' · ' + id.slice(0,8),
      connected:Boolean(a.session), planEnabled:planEnabled(a.session), renewable:Boolean(a.session?.refresh),
      scopes:a.session?.scopes ?? [],
    }));
    const active = rows.find(row => row.id === activeId);
    return {activeId,accounts:rows,connected:Boolean(active?.connected),planEnabled:Boolean(active?.planEnabled)};
  }

  function cancelAttempt() { pending = null; ++attemptNumber; }
  function begin({accountId, consent = false} = {}) {
    const state = vault().load();
    const account = accountId == null ? null : registration(state, accountId);
    cancelAttempt();
    pending = {number:attemptNumber, accountId:accountId ?? null, state:fresh(),nonce:fresh(), verifier:fresh(),
      expires:now()+600000};
    const url = new URL(issuer + '/api/accounts/authorize');
    url.search = new URLSearchParams({client_id:account?.client ?? entryClient,ext_agent_host_id:state.hostId,
      response_type:'code',redirect_uri:redirectUri,scope,resource,state:pending.state,nonce:pending.nonce,
      code_challenge_method:'S256',code_challenge:hash(pending.verifier).toString('base64url')});
    if (!account) url.searchParams.set('agent_name_hint','Clockwork');
    if (account?.email) url.searchParams.set('login_hint', account.email);
    if (consent) url.searchParams.set('prompt','consent');
    return {url:url.href,state:pending.state};
  }

  async function finish(params) {
    if (!(params instanceof URLSearchParams)) throw badRequest('Invalid ChatGPT callback.');
    const attempt = pending;
    if (!attempt || now() >= attempt.expires || params.getAll('state').length !== 1 || params.get('state') !== attempt.state) {
      throw badRequest('ChatGPT sign-in state is invalid or expired. Start a new sign-in.', 403);
    }
    pending = null;
    if (params.has('error')) throw badRequest('ChatGPT sign-in or consent was declined. Reconnect when ready.', 403);
    const code = params.get('code');
    if (params.getAll('code').length !== 1 || !validToken(code) || params.getAll('client_id').length > 1) throw badRequest('Incomplete ChatGPT callback.');
    const callbackClient = params.get('client_id');
    // Registration can succeed even when code exchange expires. Retain the
    // issued client without activating it until identity has been verified.
    const {id, client, subject} = vault().update(state => {
      if (attempt.accountId) {
        const a = registration(state, attempt.accountId);
        if (callbackClient !== null && callbackClient !== a.client) throw badRequest('ChatGPT returned a different registration.', 403);
        return {id:attempt.accountId,client:a.client,subject:a.subject};
      }
      if (!validId(callbackClient) || callbackClient === entryClient) throw badRequest('ChatGPT did not issue a client registration.');
      const id = hash(callbackClient).toString('hex');
      if (Object.hasOwn(state.accounts,id)) throw badRequest('Reconnect using the existing ChatGPT registration.', 409);
      state.accounts[id] = {client:callbackClient,subject:null,email:null,session:null};
      return {id,client:callbackClient,subject:null};
    });
    const data = await tokenRequest({grant_type:'authorization_code',client_id:client,code,code_verifier:attempt.verifier,
      redirect_uri:redirectUri,resource});
    const identity = await validateIdentity(data.id_token, client, attempt.nonce, data.access_token);
    if (subject && identity.subject !== subject) throw badRequest('ChatGPT returned a different account for this registration.', 403);
    const session = parseSession(data, null, now());
    if (attempt.number !== attemptNumber) throw badRequest('A newer account selection replaced this sign-in.', 409);
    vault().update(state => {
      const a = registration(state,id);
      if (a.subject && a.subject !== identity.subject) throw badRequest('ChatGPT account identity changed.', 403);
      Object.assign(a,identity,{session:{...session,nonce:attempt.nonce}});
      state.activeId = id;
    });
    return status();
  }

  function select(id) {
    vault().update(state => { registration(state,id); state.activeId = id; });
    cancelAttempt();
    return status();
  }

  const current = (state,id) => {
    if (!id || state.activeId !== id) throw badRequest('Select or reconnect the ChatGPT account before continuing.', 409);
    return registration(state,id);
  };
  async function refresh(id, signal, force = false) {
    // A short persisted lease serializes rotating tokens across worker restarts
    // and overlapping processes sharing the same vault. Never replay a grant
    // from an abandoned exchange; its rotation may have reached the issuer.
    const lease = randomUUID();
    while (true) {
      signal?.throwIfAborted();
      const selected = vault().update(state => {
        const a = current(state,id);
        const s = a.session;
        if (!s) throw badRequest('Reconnect this ChatGPT account.', 403);
        if (s.lease && s.leaseUntil > now()) return {wait:true};
        if (s.lease) { a.session = null; return {expiredLease:true}; }
        if (!force && s.expiresAt > now() && (s.expiresAt - now() > 60000 || !s.refresh || s.earliestRefresh > now())) return {valid:true};
        if (!s.refresh) throw badRequest('Renewal access is missing. Reconnect this ChatGPT account.', 403);
        if (s.earliestRefresh > now()) throw badRequest('ChatGPT does not permit renewal yet.', 409);
        s.lease = lease;
        s.leaseUntil = now()+45000;
        return {session:s,client:a.client,subject:a.subject};
      });
      if (selected.valid) return;
      if (selected.expiredLease) throw badRequest('A ChatGPT renewal was interrupted. Reconnect this account.', 409);
      if (selected.wait) { await delay(100, undefined, {signal}); force = false; continue; }
      try {
        const data = await tokenRequest({grant_type:'refresh_token',client_id:selected.client,refresh_token:selected.session.refresh,resource},signal);
        if (data.id_token !== undefined) {
          const identity = await validateIdentity(data.id_token, selected.client, selected.session.nonce, data.access_token, true);
          if (identity.subject !== selected.subject) throw badRequest('ChatGPT renewal returned a different account.', 403);
        }
        const next = parseSession(data,selected.session,now());
        vault().update(state => {
          const a = registration(state,id);
          if (a.session?.lease !== lease) throw badRequest('ChatGPT account changed during renewal.', 409);
          a.session = {...next,nonce:selected.session.nonce};
        });
        return;
      } catch (error) {
        const uncertain = vault().update(state => {
          const a = registration(state,id);
          if (a.session?.lease !== lease) return;
          if (error.grantRejected && !unusableRefresh.has(error.oauthCode)) {
            delete a.session.lease;
            delete a.session.leaseUntil;
            return false;
          }
          // The issuer may already have spent the token, even when the response
          // never reached us. Keep the registration for a fresh sign-in.
          a.session = null;
          return !error.grantRejected;
        });
        if (uncertain) throw badRequest('ChatGPT renewal could not be confirmed. Reconnect this account.', 409);
        throw error;
      }
    }
  }

  async function credential({signal,profileId} = {}) {
    const state = vault().load(), id = profileId ?? state.activeId;
    const a = current(state,id);
    if (!a.session) throw badRequest('Reconnect this ChatGPT account.', 403);
    if (!planEnabled(a.session)) throw badRequest('ChatGPT plan usage permission is missing. Enable plan usage for this account.', 403);
    // Fast path avoids rewriting the vault on every inference.
    if (a.session.lease || a.session.expiresAt - now() <= 60000) await refresh(id,signal);
    const session = current(vault().load(),id).session;
    if (!planEnabled(session) || session.expiresAt <= now()) throw badRequest('ChatGPT plan permission is missing or expired. Reconnect.', 403);
    return {profileId:id,accessToken:session.access};
  }
  function invalidate({profileId,accessToken}) {
    vault().update(state => {
      const a = registration(state,profileId);
      if (a.session?.access === accessToken) a.session = null;
    });
  }

  async function revoke(client, refreshToken) {
    for (let i=0; i<2; ++i) {
      try {
        const meta = await request(issuer + '/.well-known/openid-configuration');
        if (meta.ok) {
          const discovery = await meta.json();
          const endpoint = new URL(discovery.revocation_endpoint);
          if (discovery.issuer !== issuer || endpoint.origin !== issuer || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
          const res = await request(endpoint.href,{method:'POST',
            body:new URLSearchParams({client_id:client,token:refreshToken,token_type_hint:'refresh_token'})});
          if (res.status === 200) return true;
          if (res.status < 500) return false;
        } else if (meta.status < 500) return false;
      } catch { /* One bounded retry while the rotating token is available. */ }
      if (i === 0) await delay(200);
    }
    return false;
  }

  async function signOut(accountId) {
    cancelAttempt();
    const id = accountId ?? vault().load().activeId;
    let removed;
    // Let an in-flight refresh rotate before revoking the renewable session.
    do {
      removed = vault().update(state => {
        const a = registration(state,id);
        if (a.session?.leaseUntil > now()) return null;
        const old = {client:a.client,token:a.session?.refresh};
        a.session = null;
        return old;
      });
      if (!removed) await delay(100);
    } while (!removed);
    const revocationConfirmed = removed.token ? await revoke(removed.client,removed.token) : false;
    return {...status(),revocationConfirmed};
  }

  return {status,begin,finish,select,signOut,credential,invalidate,
    async accessToken({accountId,signal}={}) { return (await credential({profileId:accountId,signal})).accessToken; },
    async renew(accountId) { await refresh(accountId ?? vault().load().activeId,undefined,true); return status(); },
    close() { cancelAttempt(); storage?.close(); storage = undefined; },
  };
}
