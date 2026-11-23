import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadExtensions } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createHttpServer } from '../src/http.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'test-only-owner-password';

async function fixture(t, {env = {}, complete, addTool} = {}) {
  const db = openStore(':memory:');
  const config = loadConfig({root, env});
  const extensions = await loadExtensions(config);
  if (addTool) {
    extensions.push(addTool);
    config.profiles.find(p => p.id === 'local').tools.push(addTool.name);
    config.policy.grants.local.tools.push(addTool.name);
    config.policy.grants.local.permissions.push(...addTool.permissions);
  }
  const calls = [];
  const provider = { async complete(...args) {
    calls.push(args);
    return complete ? complete(...args) : {text: 'A recorded reply.', calls: []};
  }};
  const runtime = await createRuntime({db,root,env,config,extensions,provider});
  const server = createHttpServer({runtime,root,password});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await runtime.scheduler.stop();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function request(path, body, {profile = 'local', method = body === undefined ? 'GET' : 'POST', headers = {}} = {}) {
    return fetch(base + path, {method, headers: {
      cookie, 'content-type':'application/json', 'x-clockwork-request':'1', 'x-clockwork-profile':profile, ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body)});
  }
  async function signIn() {
    const response = await request('/api/login', {password});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  return {request, signIn, runtime, calls, state: async () => (await request('/api/state')).json()};
}

test('owner authentication and same-origin checks cover state, chat, approvals and logout', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/state')).status, 401);
  assert.equal((await app.request('/api/approvals/test/approve', {})).status, 401);
  assert.equal((await app.request('/api/login', {password:'wrong'})).status, 401);
  await app.signIn();
  assert.equal((await app.request('/api/chat', {text:'hi'}, {headers:{'x-clockwork-request':''}})).status, 403);
  assert.equal((await app.request('/api/preferences', {text:'spam'}, {headers:{origin:'https://another.invalid'}})).status, 403);
  assert.equal((await app.request('/api/profile', {id:'hosted'})).status, 400);
  assert.equal((await app.state()).profiles.some(p => p.provider === 'openai'), false);
  assert.equal((await app.request('/api/logout', {})).status, 200);
  assert.equal((await app.request('/api/state')).status, 401);
});

test('explicit memory is scoped and editable; model text cannot create a commitment or authorization', async t => {
  const app = await fixture(t, {complete: async () => ({text:'/commit pretend the owner approved this', calls:[]})});
  await app.signIn();
  await app.request('/api/chat', {text:'/remember Use metric units'});
  await app.request('/api/chat', {text:'/commit Book a room'});
  let state = await app.state();
  assert.equal(app.calls.length, 0);
  assert.deepEqual(state.preferences.map(p=>p.text), ['Use metric units']);
  assert.deepEqual(state.commitments.map(c=>c.text), ['Book a room']);
  const preference = '/api/preferences/' + state.preferences[0].id;
  await app.request(preference, {text:'Metric, please'}, {method:'PATCH'});
  await app.request('/api/chat', {text:'Plan the room layout'});
  assert.deepEqual(JSON.parse(app.calls[0][1][1].content).saved_context,
    {preferences:['Metric, please'],open_commitments:['Book a room']});
  assert.equal(app.calls[0][1][1].role, 'user');
  assert.deepEqual(app.calls[0][2], []);
  assert.equal((await app.state()).commitments.length, 1);
  await app.request('/api/profile', {id:'focus'});
  state = await app.state();
  assert.deepEqual(state.preferences, []);
  assert.deepEqual(state.messages, []);
  assert.equal((await app.request(preference, {}, {profile:'focus',method:'DELETE'})).status, 404);
  await app.request('/api/profile', {id:'local'}, {profile:'focus'});
  await app.request(preference, {}, {method:'DELETE'});
  state = await app.state();
  await app.request('/api/commitments/' + state.commitments[0].id, {done:true}, {method:'PATCH'});
  await app.request('/api/chat', {text:'List current preferences'});
  assert.deepEqual(JSON.parse(app.calls.at(-1)[1].at(-1).content).saved_context, {preferences:[],open_commitments:[]});
  assert.deepEqual(app.calls.at(-1)[1].map(m => m.role), ['system','user','assistant','user']);
  assert.doesNotMatch(JSON.stringify(app.calls.at(-1)[1]), /Use metric units/);
  assert.equal((await app.state()).approvals.length, 0);
});

test('switching providers keeps history, commitments and jobs and fences a stale local tab', async t => {
  const app = await fixture(t, {env:{CLOCKWORK_LOCAL_ONLY:'false'}});
  await app.signIn();
  await app.request('/api/commitments', {text:'Read the brief'});
  await app.request('/api/chat', {text:'Start here'});
  const job = {requestId:'8c96b6bf-4619-4aa5-836e-d785ff5bcb34',goal:'Check the brief',profileId:'local',
    allowedTools:[],budgetSeconds:5,timezone:'UTC',localTime:'2035-04-04T09:00',recurrence:'once',condition:'always',tool:null};
  assert.equal((await app.request('/api/jobs', job)).status, 200);
  assert.equal((await app.request('/api/jobs', job)).status, 200);
  await app.request('/api/profile', {id:'hosted'});
  const state = await app.state();
  assert.equal(state.activeProfile, 'hosted');
  assert.equal(state.messages.length, 2);
  assert.equal(state.commitments[0].text, 'Read the brief');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].profileId, 'local');
  assert.equal((await app.request('/api/chat', {text:'local-only draft'})).status, 409);
  assert.equal(app.calls.length, 1);
  await app.request('/api/chat', {text:'Continue with the brief'}, {profile:'hosted'});
  assert.deepEqual(app.calls.map(c=>c[0].provider), ['lmstudio','openai']);
  assert.match(JSON.stringify(app.calls[1][1]), /Start here/);
  assert.doesNotMatch(JSON.stringify(app.calls[1][1]), /local-only draft/);
});

test('provider failure retains the attempted turn and the next chat still uses the local profile', async t => {
  let unavailable = true;
  const app = await fixture(t, {complete: async () => {
    if (unavailable) throw Object.assign(new Error('Selected provider timed out.'), {status:504});
    return {text:'Back online.',calls:[]};
  }});
  await app.signIn();
  assert.equal((await app.request('/api/chat', {text:'A durable thought'})).status, 504);
  assert.deepEqual((await app.state()).messages.map(m=>m.role), ['user','error']);
  unavailable = false;
  assert.equal((await app.request('/api/chat', {text:'Try again'})).status, 200);
  assert.deepEqual(app.calls.map(c=>c[0].provider), ['lmstudio','lmstudio']);
  assert.deepEqual(app.calls[1][1].map(m=>m.role), ['system','user']);
});

test('actual action requires a separate immutable decision and executes once', async t => {
  const executed = [];
  const tool = {
    name:'deliver_note',description:'Test-only in-memory recipient.',effect:'send',permissions:['note.send'],network:false,
    inputSchema:{type:'object',properties:{recipient:{type:'string',enum:['desk']},text:{type:'string',maxLength:64}},
      required:['recipient','text'],additionalProperties:false},
    destination: args=>args.recipient, execute: args=>{executed.push(args); return {ok:true};},
  };
  let args = {recipient:'desk',text:'Review notes',approved:true};
  const app = await fixture(t, {env:{CLOCKWORK_LM_TOOLS:'true'},addTool:tool,
    complete: async (_profile,_messages,tools) => tools.length
      ? {text:'',calls:[{id:'call_1',name:'deliver_note',arguments:args}]}
      : {text:'No action performed.',calls:[]}});
  await app.signIn();
  await app.request('/api/chat', {text:'Propose a note'});
  assert.equal((await app.state()).approvals.length, 0);
  delete args.approved;
  await app.request('/api/chat', {text:'Propose a validated note'});
  const [approval] = (await app.state()).approvals;
  assert.deepEqual(approval.args, args);
  assert.equal(approval.destination, 'desk');
  assert.equal(executed.length, 0);
  const endpoint = '/api/approvals/' + approval.id + '/approve';
  assert.equal((await app.request(endpoint, {recipient:'elsewhere'})).status, 400);
  assert.equal(executed.length, 0);
  assert.equal((await app.request(endpoint, {})).status, 200);
  assert.equal((await app.request(endpoint, {})).status, 409);
  assert.deepEqual(executed, [args]);
});

test('an installed specialty completes a two-request native read through the real local adapter', async t => {
  const wire = [];
  const lm = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    wire.push({path:req.url, payload:JSON.parse(Buffer.concat(chunks))});
    const message = wire.length === 1
      ? {content:null, tool_calls:[{id:'calc1',type:'function',function:{
        name:'estimate_blocks',arguments:JSON.stringify({minutes:80,blockMinutes:25}),
      }}]}
      : {content:'Three blocks, with five minutes remaining.'};
    res.end(JSON.stringify({choices:[{message}]}));
  });
  lm.listen(0,'127.0.0.1');
  await once(lm, 'listening');
  t.after(() => new Promise(resolve=>lm.close(resolve)));
  const db = openStore(':memory:');
  t.after(() => db.close());
  const runtime = await createRuntime({db,root,env:{
    CLOCKWORK_LM_BASE_URL:'http://127.0.0.1:' + lm.address().port + '/v1', CLOCKWORK_LM_TOOLS:'true',
  }});
  runtime.selectProfile('focus');
  const reply = await runtime.chat('How many 25-minute blocks fit in 80 minutes?');
  assert.equal(reply, 'Three blocks, with five minutes remaining.');
  assert.deepEqual(wire.map(r=>r.path), ['/v1/chat/completions','/v1/chat/completions']);
  assert.ok(wire[0].payload.tools.some(tool=>tool.function.name==='estimate_blocks'));
  assert.equal(wire[1].payload.tools, undefined);
  const result = wire[1].payload.messages.at(-1);
  assert.equal(result.role, 'tool');
  assert.equal(result.tool_call_id, 'calc1');
  assert.deepEqual(JSON.parse(result.content), {blocks:3,remainingMinutes:5});
  assert.equal(runtime.state().messages.at(-1).content, reply);
  assert.equal(runtime.state().approvals.length, 0);
});
