import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGatewayServer } from '../src/gateway.mjs';
import { createHttpServer } from '../src/http.mjs';
import { createPlanAuth } from '../src/plan-auth.mjs';
import { createPlanCallback } from '../src/plan-callback.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { openStore } from '../src/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const issuer = 'https://auth.openai.com';
const redirectUri = 'http://127.0.0.1:1455/auth/callback';
const model = {slug:'fixture-model',display_name:'Fixture model',visibility:'list'};
const bearer = 'FAKE-SMOKE-OAUTH-ACCESS';
const refreshToken = 'FAKE-SMOKE-OAUTH-REFRESH';
const key = 'FAKE-SMOKE-API-KEY';
const privateText = 'PRIVATE-LM-STUDIO-PREFERENCE';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('gateway, browser callback relay and isolated worker complete a plan-backed tool round trip using a fake issuer and Responses stream', async t => {
  const temp = mkdtempSync(join(tmpdir(),'clockwork-plan-http-'));
  const db = openStore(':memory:');
  let authorization, idToken, limitReached = false;
  const {privateKey, publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const payloads = [], destinations = [];
  const complete = output => new Response('data: ' + JSON.stringify({type:'response.completed',
    response:{status:'completed',output}}) + '\n\n', {headers:{'content-type':'text/event-stream'}});
  async function openai(url, options) {
    destinations.push(url);
    if (url === issuer + '/.well-known/jwks.json') {
      return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'smoke',alg:'RS256'}]});
    }
    if (url === issuer + '/api/accounts/oauth/token') {
      const seconds = Math.floor(Date.now()/1000);
      const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const claims = encode({alg:'RS256',kid:'smoke'}) + '.' + encode({sub:'smoke-owner',iss:issuer,
        iat:seconds,exp:seconds+3600,aud:options.body.get('client_id'),nonce:authorization.get('nonce')});
      idToken = claims + '.' + sign('RSA-SHA256',Buffer.from(claims),privateKey).toString('base64url');
      return Response.json({access_token:bearer,refresh_token:refreshToken,id_token:idToken,token_type:'Bearer',
        expires_in:3600,scope:authorization.get('scope')});
    }
    assert.equal(new Headers(options.headers).get('authorization'),'Bearer ' + bearer);
    if (url === 'https://api.openai.com/v1/models') return Response.json({models:[model]});
    assert.equal(url,'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    payloads.push(body);
    if (limitReached) return Response.json({error:{code:'subscription_sharing_usage_limit_exceeded'}},{status:429});
    if (payloads.length === 1) return complete([{type:'function_call',namespace:'clockwork',
      name:'estimate_blocks',call_id:'call_estimate',arguments:'{"minutes":95,"blockMinutes":30}'}]);
    return complete([{type:'message',role:'assistant',content:[{type:'output_text',text:'Three blocks, five minutes remaining.'}]}]);
  }
  const planAuth = createPlanAuth({directory:join(temp,'secrets'),redirectUri,fetchImpl:openai});
  t.after(() => { planAuth.close(); db.close(); rmSync(temp,{recursive:true,force:true}); });
  const runtime = await createRuntime({db,root,planAuth,fetchImpl:openai,env:{CLOCKWORK_AGENT_ID:'personal',
    CLOCKWORK_LOCAL_ONLY:'false',OPENAI_API_KEY:key}});
  const workerToken = 'fixture-only-internal-worker-token-123456';
  const worker = await listen(t,createHttpServer({root,runtime,workerToken}));
  const relay = createPlanCallback(redirectUri);
  const callback = await listen(t,relay.server);
  const password = 'fixture-only-owner-password';
  const gateway = await listen(t,createGatewayServer({root,password,agents:[{id:'personal',url:worker,token:workerToken}],planCallback:relay}));
  const browserBodies = [];
  let cookie = '', revision = 0, profile = 'local';
  async function api(path, body, {method=body === undefined ? 'GET':'POST',rev=revision,expectedProfile=profile,status=200}={}) {
    const res = await fetch(gateway + '/api' + path,{method, headers:{cookie,'content-type':'application/json',
      'x-clockwork-request':'1','x-clockwork-profile':expectedProfile,'x-clockwork-revision':String(rev)},
      body:body === undefined ? undefined : JSON.stringify(body)});
    const text = await res.text();
    browserBodies.push(text);
    assert.equal(res.status,status,text);
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return JSON.parse(text);
  }
  // Exercise Host checking even though the listener uses an ephemeral test port.
  async function visit(query, host = '127.0.0.1:1455') {
    const req = httpRequest(callback + '/auth/callback?' + query, {headers:{host}});
    const result = once(req,'response');
    req.end();
    const [res] = await result;
    let body = '';
    for await (const chunk of res) body += chunk;
    browserBodies.push(body);
    return {status:res.statusCode,body};
  }
  const prefix = '/agents/personal';
  await api(prefix + '/plan/start',{}, {status:401});
  await api('/login',{password});
  await api(prefix + '/preferences',{text:privateText});
  await api(prefix + '/plan/start',{}, {rev:1,status:409});
  await api('/agents/nonexistent/plan/start',{}, {status:404});
  await api(prefix + '/plan/start',{}, {expectedProfile:'plan',status:409});
  const start = await api(prefix + '/plan/start',{});
  authorization = new URL(start.url).searchParams;
  assert.deepEqual(Object.keys(start),['url']);
  assert.equal(authorization.get('redirect_uri'),redirectUri);
  const query = new URLSearchParams({code:'fake-code',client_id:'oaiapp_smoke',state:authorization.get('state')}).toString();
  await api(prefix + '/plan/callback',{query},{status:404});
  await api('/plan/callback',{query},{status:404});
  assert.equal((await fetch(worker + '/api/plan/callback',{method:'POST'})).status,401);
  assert.equal((await visit(query,'unexpected.example')).status,400);
  const confirmed = await visit(query);
  assert.equal(confirmed.status,200,confirmed.body);
  assert.match(confirmed.body,/permission confirmed/);
  assert.equal((await visit(query)).status,400);
  const status = await api(prefix + '/plan/status');
  assert.equal(status.planEnabled,true);
  assert.ok(status.accounts[0].scopes.includes('chatgpt.tokens.use.direct'));
  const settings = await api(prefix + '/settings');
  assert.ok(settings.revision > revision);
  await api(prefix + '/plan/models',{}, {status:409});
  revision = settings.revision;
  assert.deepEqual((await api(prefix + '/plan/models',{})).models,[{slug:model.slug,display_name:model.display_name}]);
  const selected = await api(prefix + '/settings',{revision,name:'Personal assistant',goal:'Calculate time blocks.',
    profileId:'plan',model:model.slug,baseUrl:'https://api.openai.com/v1',nativeTools:true},{method:'PUT'});
  revision = selected.revision;
  profile = selected.activeProfile;
  assert.equal(profile,'plan');
  await api(prefix + '/chat',{text:'Divide 95 minutes into 30-minute blocks.'});
  const state = await api(prefix + '/state');
  assert.equal(state.messages.at(-1).content,'Three blocks, five minutes remaining.');
  assert.equal(payloads.length,2);
  assert.deepEqual(payloads.map(b => [b.model,b.store,b.stream]),[[model.slug,false,true],[model.slug,false,true]]);
  assert.ok(payloads[0].tools[0].tools.some(t => t.name === 'estimate_blocks'));
  const result = payloads[1].input.find(item => item.type === 'function_call_output');
  assert.equal(result.call_id,'call_estimate');
  assert.deepEqual(JSON.parse(result.output),{blocks:3,remainingMinutes:5});
  assert.equal(destinations.filter(url => url === issuer + '/api/accounts/oauth/token').length,1);
  // The installed billed API key must remain unused when plan admission fails.
  limitReached = true;
  const before = destinations.length;
  const failure = await api(prefix + '/chat',{text:'Check again.'},{status:502});
  assert.match(failure.error,/usage limit/);
  assert.deepEqual(destinations.slice(before),['https://api.openai.com/v1/models','https://api.openai.com/v1/responses']);
  for (const secret of [bearer,refreshToken,idToken,key,workerToken]) {
    assert.ok(!browserBodies.some(text => text.includes(secret)));
    assert.ok(!JSON.stringify(payloads).includes(secret));
  }
  assert.ok(!JSON.stringify(payloads).includes(privateText));
});
