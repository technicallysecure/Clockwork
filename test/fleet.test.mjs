import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createGatewayServer } from '../src/gateway.mjs';
import { createHttpServer } from '../src/http.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { openStore } from '../src/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'fixture-only-owner-password';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

async function fleet(t, provider) {
  const directory = mkdtempSync(join(tmpdir(), 'clockwork-fleet-'));
  const workers = [];
  for (const id of ['personal','research']) {
    const db = openStore(join(directory, id, 'data', 'agent.sqlite'));
    t.after(() => db.close());
    const runtime = await createRuntime({root, db, provider,
      env:{CLOCKWORK_AGENT_ID:id, CLOCKWORK_AGENT_RESERVED:String(id === 'research')},
      workspaceDir:join(directory, id, 'workspace'),
    });
    const token = randomBytes(32).toString('hex');
    const url = await listen(t, createHttpServer({runtime, root, workerToken:token}));
    workers.push({id, token, url, runtime});
  }
  const base = await listen(t, createGatewayServer({root,password,agents:workers}));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  let cookie = '';
  async function api(path, body, {method=body === undefined ? 'GET':'POST',revision=0,profile='local',headers={}}={}) {
    const res = await fetch(base + '/api' + path, {method, headers:{
      cookie, 'x-clockwork-request':'1','content-type':'application/json','x-clockwork-profile':profile,
      'x-clockwork-revision':String(revision), ...headers,
    }, body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:res.status, body:await res.json(), cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login() {
    const res = await api('/login',{password});
    assert.equal(res.status,200);
    cookie = res.cookie;
  }
  return {api, login, workers};
}

test('gateway authenticates owners, binds workers to their own identity, and activates each slot once', async t => {
  const {api, login, workers} = await fleet(t);
  assert.equal((await api('/agents')).status,401);
  const [one, two] = workers;
  for (const [token, id, expected] of [[one.token,'research',401],[two.token,'personal',409],[two.token,'research',200]]) {
    const res = await fetch(two.url + '/api/info',{headers:{authorization:'Bearer ' + token, 'x-clockwork-agent':id}});
    assert.equal(res.status,expected);
  }
  assert.equal((await api('/agents', undefined, {headers:{authorization:'Bearer ' + two.token}})).status,401);
  await login();
  const {agents} = (await api('/agents')).body;
  assert.deepEqual(agents.map(a=>[a.id,a.initialized,a.available]), [['personal',true,true],['research',false,true]]);
  assert.equal((await api('/agents/research/state')).status,409);
  const spec = {id:'research',name:'Research',goal:'Compare the references'};
  const attempts = await Promise.all([api('/agents',spec),api('/agents',spec)]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  assert.equal((await api('/agents/research/initialize',spec)).status,404);
  assert.equal((await api('/agents/missing/state')).status,404);
});

test('parallel assignments use each worker’s goal and context, keeping files, jobs and outputs separate', async t => {
  const calls = [];
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  const provider = {async complete(_profile, messages) {
    calls.push(messages);
    if (calls.length === 2) release();
    // A serial dispatcher would never release this barrier on its first call.
    await Promise.race([bothStarted, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('Assignments did not overlap.')), 3000);
      timer.unref();
    })]);
    const ctx = JSON.parse(messages.at(-1).content);
    return {text:'Answer for ' + ctx.saved_context.preferences[0],calls:[]};
  }};
  const {api, login, workers} = await fleet(t, provider);
  await login();
  await api('/agents',{id:'research',name:'Archivist',goal:'Compare archives.'});
  for (const [id, rev] of [['personal',0],['research',1]]) {
    assert.equal((await api('/agents/' + id + '/preferences', {text:id + ' preference'},{revision:rev})).status,200);
    assert.equal((await api('/agents/' + id + '/workspace/notes.txt', {text:id + ' notebook',version:null},
      {method:'PUT',revision:rev})).status,200);
  }
  const job = {goal:'A private reminder', profileId:'local',allowedTools:[],budgetSeconds:10,timezone:'UTC',
    localTime:'2025-01-01T12:00',recurrence:'once',condition:'always',tool:null};
  assert.equal((await api('/agents/personal/jobs', job)).status,200);
  await workers[0].runtime.scheduler.tick();
  const dispatch = {requestId:randomUUID(), text:'Prepare the next step',targets:[
    {id:'personal',profileId:'local',revision:0}, {id:'research',profileId:'local',revision:1},
  ]};
  const result = await api('/dispatch',dispatch);
  assert.deepEqual(result.body.results,[{id:'personal',ok:true},{id:'research',ok:true}]);
  assert.deepEqual((await api('/dispatch',dispatch)).body, result.body);
  for (const {id,runtime} of workers) {
    const other = id === 'personal' ? 'research' : 'personal';
    const state = (await api('/agents/' + id + '/state')).body;
    assert.equal(state.agent.id,id);
    assert.deepEqual(state.messages.map(m=>m.content),[dispatch.text,'Answer for ' + id + ' preference']);
    const context = calls.find(messages => messages.at(-1).content.includes(id + ' preference'));
    assert.ok(context[0].content.includes(state.agent.goal));
    assert.ok(!JSON.stringify(context).includes(other + ' preference'));
    const file = await runtime.capabilities.dispatch(runtime.active(),'read_workspace',{name:'notes.txt'});
    assert.equal(file.text,id + ' notebook');
    for (const key of ['jobs','runs','notifications']) assert.equal(state[key].length, id === 'personal' ? 1 : 0);
  }
  const before = workers[0].runtime.state().messages.length;
  assert.equal((await api('/dispatch',{...dispatch,targets:[dispatch.targets[0],dispatch.targets[0]]})).status,400);
  assert.equal(workers[0].runtime.state().messages.length,before);
  const wrongRevision = await api('/dispatch',{requestId:randomUUID(),text:'Private assignment',targets:[{id:'research',profileId:'local',revision:0}]});
  assert.equal(wrongRevision.body.results[0].ok,false);
  assert.equal(workers[1].runtime.state().messages.length,2);
});

test('model settings stay in the addressed agent and invalidate stale submissions even on the legacy routes', async t => {
  const {api, login} = await fleet(t);
  await login();
  await api('/agents',{id:'research',name:'Analyst',goal:'Compare forecasts.'});
  const original = (await api('/agents/personal/settings')).body;
  const other = (await api('/agents/research/settings')).body;
  const profile = original.profiles.find(p=>p.id === original.activeProfile);
  const update = {revision:0, name:'Organiser', goal:'Plan meetings.', profileId:profile.id,
    model:'desk-model', baseUrl:profile.baseUrl, nativeTools:false, credential:'test-token-only'};
  const saved = await api('/agents/personal/settings', update,{method:'PUT'});
  assert.equal(saved.status,200);
  assert.equal(saved.body.revision,1);
  assert.equal((await api('/agents/personal/workspace', undefined, {revision:0})).status,409);
  assert.equal((await api('/agents/personal/workspace', undefined, {revision:1,profile:'focus'})).status,409);
  assert.equal((await api('/agents/personal/workspace', undefined, {revision:1})).status,200);
  assert.ok(!JSON.stringify(saved.body).includes(update.credential));
  assert.deepEqual((await api('/agents/research/settings')).body, other);
  assert.equal((await api('/agents/personal/preferences',{text:'Stale write'})).status,409);
  assert.equal((await api('/preferences',{text:'Stale legacy write'},{headers:{'x-clockwork-revision':''}})).status,409);
  assert.equal((await api('/agents/personal/preferences',{text:'Current write'},{revision:1})).status,200);
});
