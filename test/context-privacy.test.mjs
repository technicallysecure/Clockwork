import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.mjs';
import { loadConfig } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJob = {profileId:'local', goal:'PRIVATE scheduled goal', timezone:'UTC', localTime:'2020-01-01T00:00',
  allowedTools:['list_commitments'], tool:{name:'list_commitments', args:{}}, condition:'nonempty'};

function edit(runtime, profileId, changes) {
  const settings = runtime.settings();
  const p = settings.profiles.find(profile => profile.id === profileId);
  return runtime.updateSettings({revision:settings.revision, name:settings.agent.name, goal:p.goal, profileId,
    model:p.model, baseUrl:p.baseUrl, nativeTools:p.nativeTools, ...changes});
}

function chatCompletion(content, tools = []) {
  return Response.json({choices:[{message:{content, tool_calls:tools.map(([name,args], index) => ({
    id:'call_' + index, type:'function', function:{name, arguments:JSON.stringify(args)},
  }))}}]});
}

function stream(output) {
  const event = {type:'response.completed', response:{status:'completed', output}};
  return new Response('data: ' + JSON.stringify(event) + '\n\n', {headers:{'Content-Type':'text/event-stream'}});
}

test('wire requests after a local-only restart, manual provider switch and resumed read exclude local data', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clockwork-private-context-'));
  const dbFile = join(dir, 'state.sqlite');
  const workspaceDir = join(dir, 'workspace');
  let db = openStore(dbFile);
  t.after(() => { if (db.isOpen) db.close(); rmSync(dir, {recursive:true, force:true}); });
  // Pre-partition databases may contain hosted replies derived from local history.
  db.prepare("INSERT INTO messages(scope,role,content,profileId,createdAt) VALUES('personal',?,?, 'hosted','2020')").run('user','PRIVATE legacy question');
  db.prepare("INSERT INTO messages(scope,role,content,profileId,createdAt) VALUES('personal',?,?, 'hosted','2020')").run('assistant','PRIVATE legacy summary');
  const localRequests = [];
  let runtime = await createRuntime({db, root, workspaceDir, env:{CLOCKWORK_LM_TOOLS:'true'}, fetchImpl:async (url, options) => {
    assert.equal(new URL(url).hostname, 'host.docker.internal');
    localRequests.push(JSON.parse(options.body));
    return localRequests.length === 1 ? chatCompletion(null,[['read_workspace',{name:'notes.txt'}]]) :
      chatCompletion('PRIVATE derived answer from the local workspace.');
  }});
  edit(runtime, 'local', {goal:'PRIVATE local agent goal'});
  runtime.workspace.write('notes.txt','PRIVATE raw tool result',null);
  await runtime.chat('/commit PRIVATE local commitment');
  await runtime.chat('/remember PRIVATE local preference');
  await runtime.chat('PRIVATE local request');
  assert.match(JSON.stringify(localRequests.at(-1)),/PRIVATE raw tool result/);
  const job = runtime.scheduler.create(readJob);
  runtime.scheduler.change(job.id, 'pause');
  // Restore the persisted shape used by releases before provider isolation.
  db.prepare("UPDATE scheduled_jobs SET spec=json_remove(spec,'$.readContext') WHERE id=?").run(job.id);
  db.close();
  db = openStore(dbFile);
  const hostedRequests = [];
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin,'https://api.openai.com');
    hostedRequests.push({path:endpoint.pathname, body:options.body && JSON.parse(options.body)});
    if (endpoint.pathname === '/v1/models') return Response.json({models:[{slug:'example',display_name:'Example',visibility:'list'}]});
    const body = hostedRequests.at(-1).body;
    if (endpoint.pathname === '/v1/responses') {
      return body.tools ? stream([{type:'function_call', name:'list_commitments', namespace:'clockwork', call_id:'commit', arguments:'{}'}]) :
        stream([{type:'message', role:'assistant', content:[{type:'output_text', text:'Plan account summary.'}]}]);
    }
    assert.equal(endpoint.pathname,'/v1/chat/completions');
    return body.tools ? chatCompletion(null, [['read_workspace',{name:'notes.txt'}], ['list_commitments',{}]]) :
      chatCompletion('API key account summary.');
  };
  const planAuth = {status:() => ({planEnabled:true,activeId:'test-binding'}), credential:async () =>
    ({profileId:'test-binding', accessToken:'fake-plan-grant'})};
  runtime = await createRuntime({db, root, workspaceDir, env:{CLOCKWORK_LOCAL_ONLY:'false',OPENAI_API_KEY:'fake-key'}, planAuth, fetchImpl});
  // Older clients prefill the local goal when the owner changes a model.
  edit(runtime, 'hosted', {goal:runtime.agentInfo().goal});
  runtime.scheduler.change(job.id, 'resume');
  await runtime.scheduler.tick();
  assert.equal(hostedRequests.length, 0);
  assert.match(runtime.scheduler.notifications()[0].body,/PRIVATE local commitment/);
  assert.deepEqual(runtime.workspace.forProfile(runtime.active()).list().files, []);
  runtime.workspace.forProfile(runtime.active()).write('notes.txt','API key workspace note',null);
  await runtime.chat('/commit API key commitment');
  await runtime.chat('Check my hosted workspace.');
  assert.match(JSON.stringify(hostedRequests.at(-1)),/API key workspace note/);
  assert.match(JSON.stringify(hostedRequests.at(-1)),/API key commitment/);
  edit(runtime, 'plan', {model:'example', nativeTools:true, goal:'Plan-specific goal'});
  await runtime.chat('/commit Plan-only commitment');
  await runtime.chat('Check my plan commitments.');
  const planBody = hostedRequests.at(-1).body;
  assert.match(planBody.instructions,/Plan-specific goal/);
  assert.match(planBody.input.at(-1).output,/Plan-only commitment/);
  assert.doesNotMatch(JSON.stringify(planBody),/API key commitment|API key workspace note|API key account summary/);
  assert.doesNotMatch(JSON.stringify(hostedRequests),/PRIVATE/);
  runtime.selectProfile('local');
  assert.match(runtime.state().messages.at(-1).content,/PRIVATE derived answer/);
  assert.equal(runtime.state().agent.goal, 'PRIVATE local agent goal');
});

test('changing plan workspace isolates its goal, chats, files and commitments and fences a scheduled read', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clockwork-plan-context-'));
  const db = openStore(':memory:');
  t.after(() => {db.close(); rmSync(dir, {recursive:true, force:true});});
  let account = 'account-A-workspace-1';
  const runtime = await createRuntime({db, root, workspaceDir:dir, env:{CLOCKWORK_LOCAL_ONLY:'false'},
    planAuth:{status:() => ({planEnabled:true, activeId:account})},
    provider:{complete:async () => ({text:'workspace one summary',calls:[]})}});
  edit(runtime, 'plan', {goal:'workspace one goal'});
  await runtime.chat('/commit workspace one commitment');
  await runtime.chat('workspace one question');
  const original = runtime.active();
  runtime.workspace.forProfile(original).write('hello.txt','workspace one file',null);
  const job = runtime.scheduler.create({...readJob, profileId:'plan'});
  runtime.scheduler.change(job.id,'pause');
  account = 'account-A-workspace-2';
  assert.deepEqual(runtime.state().messages, []);
  assert.deepEqual(runtime.state().commitments, []);
  assert.doesNotMatch(runtime.state().agent.goal,/workspace one/);
  assert.deepEqual(runtime.workspace.forProfile(runtime.active()).list().files, []);
  await assert.rejects(runtime.capabilities.dispatch(original,'list_commitments',{}), {status:409});
  await runtime.chat('/commit workspace two commitment');
  runtime.scheduler.change(job.id, 'resume');
  await runtime.scheduler.tick();
  assert.equal(runtime.scheduler.runs()[0].status, 'failed');
  assert.deepEqual(runtime.scheduler.notifications(), []);
  account = original.planAccountId;
  assert.match(runtime.state().messages.at(-1).content,/workspace one summary/);
  assert.equal(runtime.state().agent.goal, 'workspace one goal');
});

test('approved actions bind the original plan workspace and unclassified extensions cannot return local data to hosted models', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const env = {CLOCKWORK_LOCAL_ONLY:'false'};
  const config = loadConfig({root,env});
  const delivered = [];
  const send = {name:'send_note', description:'Send an owner-approved test note.', effect:'send',
    hostedSafe:true, permissions:['note.send'], network:true,
    inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
    destination:() => 'test-desk', execute:({text}) => {delivered.push(text); return {ok:true};}};
  const file = {name:'legacy_read', description:'Read a legacy note.', effect:'read', permissions:['note.read'], network:false,
    inputSchema:{type:'object',properties:{},additionalProperties:false}, execute:() => ({text:'PRIVATE legacy extension'})};
  const profile = config.profiles.find(p => p.id === 'plan');
  profile.tools.push(send.name, file.name);
  config.policy.grants.plan.tools.push(send.name, file.name);
  config.policy.grants.plan.permissions.push(...send.permissions, ...file.permissions);
  let account = 'A';
  const runtime = await createRuntime({db, root, env, config, extensions:[send,file],
    planAuth:{status:() => ({planEnabled:true,activeId:account})}});
  runtime.selectProfile('plan');
  assert.ok(!runtime.capabilities.list(runtime.active()).some(tool => tool.name === file.name));
  await assert.rejects(runtime.capabilities.dispatch(runtime.active(),file.name,{}), {status:403});
  const proposal = await runtime.capabilities.dispatch(runtime.active(),send.name,{text:'Safe note'});
  assert.deepEqual(delivered, []);
  account = 'B';
  await assert.rejects(runtime.capabilities.decide(proposal.approvalId,'approve'), {status:409});
  assert.deepEqual(delivered, []);
  account = 'A';
  await runtime.capabilities.decide(proposal.approvalId,'approve');
  assert.deepEqual(delivered, ['Safe note']);
});
