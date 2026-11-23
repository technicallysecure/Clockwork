import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanAuth } from '../src/plan-auth.mjs';
import { createPlanCallback } from '../src/plan-callback.mjs';

const issuer = 'https://auth.openai.com';
const redirectUri = 'http://127.0.0.1:12002/auth/callback';
const all = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const keys = generateKeyPairSync('rsa', {modulusLength:2048});
const jwk = {...keys.publicKey.export({format:'jwk'}),kid:'fake-1',kty:'RSA',alg:'RS256',use:'sig'};
const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
const json = (data,status=200) => Response.json(data,{status});
function jwt(claims, head = {}) {
  const payload = encode({alg:'RS256',kid:jwk.kid,...head}) + '.' + encode(claims);
  return payload + '.' + sign('RSA-SHA256',Buffer.from(payload),keys.privateKey).toString('base64url');
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'clockwork-plan-auth-'));
  const f = {clock:Date.now(),calls:[],registrations:new Map(),tokens:0,refreshes:0};
  const handles = new Set();
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect,'error');
    const form = init.body;
    f.calls.push({url,form});
    if (url === issuer + '/.well-known/jwks.json') return json({keys:[jwk]});
    if (url === issuer + '/.well-known/openid-configuration') return json({issuer,revocation_endpoint:f.revokeUrl ?? issuer + '/api/accounts/oauth/revoke'});
    if (url === issuer + '/api/accounts/oauth/revoke') return new Response(null,{status:f.revokeStatus ?? 200});
    assert.equal(url,issuer + '/api/accounts/oauth/token');
    const client = form.get('client_id');
    const auth = f.registrations.get(client);
    if (form.get('grant_type') === 'refresh_token') {
      f.refreshes++;
      assert.equal(form.has('scope'),false);
      await new Promise(resolve => setTimeout(resolve,15));
      if (f.refreshReply) return f.refreshReply();
      if (f.refreshError) return json({error:f.refreshError},400);
      return json({token_type:'Bearer',scope:f.refreshScope ?? all,expires_in:3600,
        access_token:'renewed-access-' + client,refresh_token:'rotated-refresh-' + client});
    }
    assert.equal(form.get('code'),'test-code');
    assert.equal(form.get('resource'),'https://api.openai.com/v1');
    assert.equal(form.get('redirect_uri'),redirectUri);
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),auth.url.searchParams.get('code_challenge'));
    f.tokens++;
    if (f.codeError) return json({error:f.codeError},400);
    const seconds = Math.floor(f.clock/1000);
    const claims = {iss:issuer,aud:client,sub:'verified-owner',email:'same@example.test',
      iat:seconds,exp:seconds+3600,nonce:auth.url.searchParams.get('nonce'),...auth.claims};
    const payload = jwt(claims,auth.header);
    return json({token_type:'bearer',scope:auth.scopes,expires_in:3600,
      access_token:'fake-access-' + client,refresh_token:'fake-refresh-' + client,
      id_token:auth.tamper ? payload.slice(0,-20) + '000' : payload});
  };
  f.open = (agentId = 'personal') => {
    const handle = createPlanAuth({directory,agentId,redirectUri,fetchImpl,now:() => f.clock});
    handles.add(handle);
    return handle;
  };
  f.directory = directory;
  f.auth = f.open();
  f.start = (client,opts = {}) => {
    const {url,state} = f.auth.begin({accountId:opts.accountId,consent:opts.consent});
    const registration = {url:new URL(url),scopes:all,...opts};
    f.registrations.set(client,registration);
    const cb = new URLSearchParams({state,code:'test-code'});
    if (!opts.accountId || opts.includeClient) cb.set('client_id',client);
    return {...registration,cb};
  };
  f.connect = async (client,opts) => f.auth.finish(f.start(client,opts).cb);
  t.after(() => {
    for (const handle of handles) handle.close();
    rmSync(directory,{recursive:true,force:true});
  });
  return f;
}

test('new sign-in registers a public PKCE client and persists the registration, host ID and protected credentials',async t => {
  const f = fixture(t);
  const first = f.start('oaiapp_one');
  const p = first.url.searchParams;
  assert.equal(first.url.origin,issuer);
  assert.equal(first.url.pathname,'/api/accounts/authorize');
  assert.equal(p.get('client_id'),'dynamic_agent_client');
  assert.equal(p.get('agent_name_hint'),'Clockwork');
  assert.match(p.get('ext_agent_host_id'),/^urn:uuid:[\da-f-]{36}$/);
  assert.equal(p.get('response_type'),'code');
  assert.equal(p.get('code_challenge_method'),'S256');
  assert.equal(p.get('resource'),'https://api.openai.com/v1');
  assert.equal(p.get('scope'),all);
  assert.equal(p.has('prompt'),false);
  const state = await f.auth.finish(first.cb);
  assert.equal(state.connected,true);
  assert.equal(state.planEnabled,true);
  assert.equal(state.accounts[0].renewable,true);
  assert.deepEqual(await f.auth.credential(),{accessToken:'fake-access-oaiapp_one',profileId:state.activeId});
  assert.doesNotMatch(JSON.stringify(state),/fake-access|fake-refresh|eyJhbG/);
  for (const name of readdirSync(f.directory)) {
    assert.doesNotMatch(readFileSync(join(f.directory,name)).toString('latin1'),/fake-access|fake-refresh|same@example|verified-owner/);
    if (process.platform !== 'win32') assert.equal(statSync(join(f.directory,name)).mode & 0o077,0);
  }
  const resumed = f.open();
  assert.deepEqual(resumed.status(),state);
  assert.equal(await resumed.accessToken(),'fake-access-oaiapp_one');
  const next = new URL(resumed.begin({accountId:state.activeId,consent:true}).url).searchParams;
  assert.equal(next.get('client_id'),'oaiapp_one');
  assert.equal(next.get('ext_agent_host_id'),p.get('ext_agent_host_id'));
  assert.equal(next.get('prompt'),'consent');
  assert.equal(next.has('agent_name_hint'),false);
  for (const key of ['nonce','state','code_challenge']) assert.notEqual(next.get(key),p.get(key));
  assert.throws(() => f.open('another-worker').status(),/original volume/);
});

test('identity-only or a partial plan grant cannot obtain a bearer for inference',async t => {
  const f = fixture(t);
  for (const [i,scopes] of ['openid email profile','openid resource.invoke','openid chatgpt.tokens.use.direct'].entries()) {
    const first = f.start('oaiapp_' + i,{scopes});
    first.cb.set('scope',all); // the browser callback is never authoritative.
    const state = await f.auth.finish(first.cb);
    assert.equal(state.connected,true);
    assert.equal(state.planEnabled,false);
    await assert.rejects(f.auth.credential(),/permission is missing/);
  }
});

test('rejects expired, missing, mismatched and reused state, duplicate fields and consent denials',async t => {
  const f = fixture(t);
  const {cb} = f.start('oaiapp_a');
  await assert.rejects(f.auth.finish(new URLSearchParams({state:'wrong'})),/state/);
  const bad = new URLSearchParams(cb);
  bad.append('state',cb.get('state'));
  await assert.rejects(f.auth.finish(bad),/state/);
  cb.set('error','access_denied');
  await assert.rejects(f.auth.finish(cb),/declined/);
  await assert.rejects(f.auth.finish(cb),/state/);
  const expired = f.start('oaiapp_b');
  f.clock += 600001;
  await assert.rejects(f.auth.finish(expired.cb),/state/);
  const duplicate = f.start('oaiapp_c');
  duplicate.cb.append('code','another');
  await assert.rejects(f.auth.finish(duplicate.cb),/callback/);
  const noClient = f.start('oaiapp_d');
  noClient.cb.delete('client_id');
  await assert.rejects(f.auth.finish(noClient.cb),/issue a client/);
  assert.equal(f.tokens,0);
});

test('verifies signatures, RS256, key id, issuer, audience, expiration, not-before, nonce and subject',async t => {
  const f = fixture(t);
  const invalid = [{tamper:true},{header:{alg:'none'}},{header:{kid:'untrusted'}},{claims:{iss:'untrusted'}},
    {claims:{aud:'another'}},{claims:{exp:0}},{claims:{nbf:Math.ceil(f.clock/1000)+1000}},
    {claims:{nonce:'another'}},{claims:{sub:''}},{claims:{at_hash:'wrong'}}];
  for (const [i,opts] of invalid.entries()) {
    await assert.rejects(f.connect('oaiapp_bad_' + i,opts),/identity verification/);
    assert.equal(f.auth.status().activeId,null);
  }
});

test('failed code exchange retains issued registration and sign-out retains only its mapping',async t => {
  const f = fixture(t);
  f.codeError = 'invalid_grant';
  await assert.rejects(f.connect('oaiapp_1'),/Reconnect/);
  const draft = f.auth.status();
  assert.equal(draft.accounts[0].connected,false);
  assert.equal(draft.activeId,null);
  f.codeError = null;
  const {activeId} = await f.connect('oaiapp_1',{accountId:draft.accounts[0].id});
  const result = await f.auth.signOut();
  assert.equal(result.revocationConfirmed,true);
  assert.equal(result.connected,false);
  assert.equal(result.activeId,activeId);
  assert.equal(f.calls.at(-1).form.get('client_id'),'oaiapp_1');
  assert.equal(f.calls.at(-1).form.get('token_type_hint'),'refresh_token');
  await assert.rejects(f.auth.credential(),/Reconnect/);
  const next = f.start('oaiapp_1',{accountId:activeId}).url;
  assert.equal(next.searchParams.get('client_id'),'oaiapp_1');
  assert.equal(next.searchParams.has('id_token_hint'),false);
});

test('pins reconnects, renewable sessions and bearer tokens to the selected account and workspace',async t => {
  const f = fixture(t);
  const a = (await f.connect('oaiapp_a')).activeId;
  const b = (await f.connect('oaiapp_b')).activeId;
  assert.notEqual(a,b);
  assert.equal(new Set(f.auth.status().accounts.map(row => row.label)).size,2);
  await assert.rejects(f.auth.credential({profileId:a}),/Select or reconnect/);
  const wrong = f.start('oaiapp_b',{accountId:a,includeClient:true});
  await assert.rejects(f.auth.finish(wrong.cb),/different registration/);
  await assert.rejects(f.connect('oaiapp_a',{accountId:a,claims:{sub:'another-user'}}),/different account/);
  assert.equal(f.auth.status().activeId,b);
  f.auth.select(a);
  assert.equal(await f.auth.accessToken(),'fake-access-oaiapp_a');
  await f.auth.signOut(b);
  assert.equal(await f.auth.accessToken(),'fake-access-oaiapp_a');
});

test('two workers concurrently renew once, atomically rotate, and invalidate a confirmed revoked grant',async t => {
  const f = fixture(t);
  const {activeId} = await f.connect('oaiapp_a');
  const second = f.open();
  f.clock += 3600_000;
  assert.deepEqual(await Promise.all([f.auth.accessToken(),second.accessToken()]),['renewed-access-oaiapp_a','renewed-access-oaiapp_a']);
  assert.equal(f.refreshes,1);
  second.invalidate({profileId:activeId,accessToken:'fake-access-oaiapp_a'}); // delayed error from old credential
  assert.equal(f.auth.status().connected,true);
  f.refreshError = 'invalid_grant';
  await assert.rejects(f.auth.renew(),/Reconnect/);
  assert.equal(f.calls.at(-1).form.get('refresh_token'),'rotated-refresh-oaiapp_a');
  assert.equal(second.status().connected,false);
  assert.equal(second.status().activeId,activeId);
  await assert.rejects(second.credential(),/Reconnect/);
});

test('renewal honors scope reduction, transient errors preserve credentials, sign-out never posts to an untrusted discovery URL',async t => {
  const f = fixture(t);
  await f.connect('oaiapp_a');
  f.refreshError = 'temporarily_unavailable';
  await assert.rejects(f.auth.renew(),/Try again/);
  assert.equal(f.auth.status().planEnabled,true);
  f.refreshError = null;
  f.refreshScope = 'openid profile email offline_access';
  await f.auth.renew();
  await assert.rejects(f.auth.credential(),/permission/);
  f.revokeUrl = 'https://example.org/revoke';
  const result = await f.auth.signOut();
  assert.equal(result.revocationConfirmed,false);
  assert.equal(result.connected,false);
  assert.equal(f.calls.some(c => c.url.includes('example.org')),false);
});

test('callback configuration accepts only the fixed loopback host and registered path', () => {
  for (const uri of ['http://localhost:12002/auth/callback','https://127.0.0.1/auth/callback','http://127.0.0.1:12002/callback','http://user@127.0.0.1/auth/callback','http://127.0.0.1/auth/callback?a=1']) {
    assert.throws(() => createPlanAuth({redirectUri:uri}),/callback/);
  }
});

test('lost or unusable successful rotation responses permanently retire the old token', async t => {
  const f = fixture(t);
  const replies = [
    () => { throw new TypeError('mock connection lost after issuer received the request'); },
    () => new Response(null,{status:200}),
    () => json(null),
    () => json({token_type:'Bearer', scope:all, expires_in:3600, access_token:'replacement',
      refresh_token:'rotated', id_token:'malformed'})
  ];
  for (const [i,reply] of replies.entries()) {
    const {activeId} = await f.connect('oaiapp_uncertain_' + i);
    f.refreshReply = reply;
    const before = f.refreshes;
    await assert.rejects(f.auth.renew(activeId), /Reconnect/);
    const resumed = f.open();
    assert.equal(resumed.status().activeId, activeId);
    assert.equal(resumed.status().connected, false);
    await assert.rejects(resumed.credential({profileId:activeId}), /Reconnect/);
    assert.equal(f.refreshes, before + 1);
  }
});

test('an explicit transient rejection or pre-dispatch cancellation leaves renewal available', async t => {
  const f = fixture(t);
  const {activeId} = await f.connect('oaiapp_retry');
  f.clock += 3600_000;
  await assert.rejects(f.auth.credential({signal:AbortSignal.abort()}), {name:'AbortError'});
  assert.equal(f.refreshes, 0);
  f.refreshReply = () => json({error:'temporarily_unavailable'}, 503);
  await assert.rejects(f.auth.renew(activeId), /Try again/);
  assert.equal(f.auth.status().connected, true);
  f.refreshReply = null;
  assert.equal(await f.open().accessToken({accountId:activeId}), 'renewed-access-oaiapp_retry');
  assert.equal(f.refreshes, 2);
});

test('native gateway callback only listens on loopback even with a network-facing web UI', async t => {
  const relay = createPlanCallback('http://127.0.0.1:0/auth/callback');
  await relay.listen({role:'gateway', env:{CLOCKWORK_BIND:'0.0.0.0'}});
  t.after(() => new Promise(resolve => relay.server.close(resolve)));
  assert.equal(relay.server.address().address, '127.0.0.1');
  const port = relay.server.address().port;
  const response = await fetch('http://127.0.0.1:' + port + '/auth/callback?state=unknown');
  assert.equal(response.status, 400);
});
