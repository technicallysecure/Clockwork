import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.mjs';
import { openStore, Notebook } from '../src/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function changes(runtime, patch = {}) {
  const current = runtime.settings();
  const profile = current.profiles.find(p => p.id === (patch.profileId ?? current.activeProfile));
  return {
    revision:current.revision, name:current.agent.name, goal:current.agent.goal,
    profileId:profile.id, baseUrl:profile.baseUrl, model:profile.model, nativeTools:profile.nativeTools,
    ...patch,
  };
}

async function recorder(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({token:req.headers.authorization, payload:JSON.parse(Buffer.concat(chunks))});
    res.end(JSON.stringify({choices:[{message:{content:'It is done.'}}]}));
  });
  server.listen(0,'127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {url:'http://127.0.0.1:' + server.address().port + '/v1', requests};
}

test('a reserved worker is claimed exactly once and refuses another worker’s volume identity', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const env = {CLOCKWORK_AGENT_ID:'studio', CLOCKWORK_AGENT_RESERVED:'true'};
  const runtime = await createRuntime({db, root, env});
  assert.equal(runtime.agentInfo().initialized, false);
  await assert.rejects(runtime.chat('/remember private'), {status:409});
  assert.throws(() => runtime.initializeAgent({name:'Studio',goal:'   '}), {status:400});
  assert.equal(runtime.agentInfo().initialized, false);
  const info = runtime.initializeAgent({name:'Studio',goal:'Review drafts.'});
  assert.deepEqual(info, {id:'studio',name:'Studio',goal:'Review drafts.',initialized:true});
  assert.throws(() => runtime.initializeAgent({name:'Other',goal:'Other goal'}), {status:409});
  await runtime.chat('/remember Review revisions');
  assert.deepEqual((await createRuntime({db, root, env})).state().preferences.map(p=>p.text), ['Review revisions']);
  await assert.rejects(createRuntime({db, root, env:{CLOCKWORK_AGENT_ID:'other'}}), /different agent/);
});

test('legacy records remain accessible only to the personal agent during adoption', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  new Notebook(db).add('personal', 'commitment', 'Legacy appointment');
  await assert.rejects(createRuntime({db, root, env:{CLOCKWORK_AGENT_ID:'other'}}), /personal agent/);
  const runtime = await createRuntime({db, root, env:{}});
  assert.equal(runtime.agentInfo().id, 'personal');
  assert.deepEqual(runtime.state().commitments.map(c=>c.text), ['Legacy appointment']);
});

test('automatic search needs its own opt-in for each profile and plan registration', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const env = {CLOCKWORK_LOCAL_ONLY:'false', CLOCKWORK_WEB_SEARCH:'true'};
  let account = 'plan-one';
  const planAuth = {status:() => ({activeId:account})};
  let runtime = await createRuntime({db,root,env,planAuth});
  const save = patch => runtime.updateSettings(changes(runtime, patch));
  assert.throws(() => save({profileId:'plan',autoWebSearchEnabled:true}), {status:400});
  assert.throws(() => save({profileId:'plan',webSearchEnabled:true,autoWebSearchEnabled:'false'}), {status:400});
  save({profileId:'plan',webSearchEnabled:true});
  assert.equal(runtime.active().autoWebSearchEnabled, false, 'existing manual permission alone');
  save({autoWebSearchEnabled:true});
  save({model:'another-model'}); // Older clients may omit both search settings.
  runtime = await createRuntime({db,root,env,planAuth});
  assert.equal(runtime.settings().profiles.find(p => p.id === 'plan').autoWebSearchEnabled, true);
  assert.equal(runtime.getProfile('hosted').autoWebSearchEnabled, false);
  account = 'plan-two';
  assert.equal(runtime.active().webSearchEnabled, false);
  save({webSearchEnabled:true});
  assert.equal(runtime.active().autoWebSearchEnabled, false);
  account = 'plan-one';
  assert.equal(runtime.active().autoWebSearchEnabled, true);
  save({webSearchEnabled:false});
  save({webSearchEnabled:true});
  assert.equal(runtime.active().autoWebSearchEnabled, false, 'manual re-enable must not restore an earlier automatic grant');

  save({profileId:'local',webSearchEnabled:true,autoWebSearchEnabled:true});
  for (const ceiling of [{CLOCKWORK_LOCAL_ONLY:'true'}, {CLOCKWORK_WEB_SEARCH:'false'}]) {
    runtime = await createRuntime({db,root,env:{...env,...ceiling},planAuth});
    assert.equal(runtime.active().autoWebSearchEnabled, false);
    assert.throws(() => save({webSearchEnabled:true,autoWebSearchEnabled:true}), {status:400});
    assert.throws(() => save({autoWebSearchEnabled:true}), {status:400});
  }
});

test('settings changes apply to the actual next inference, persist after restart and bind keys to destinations', async t => {
  const first = await recorder(t);
  const second = await recorder(t);
  const dir = mkdtempSync(join(tmpdir(), 'clockwork-credentials-'));
  const filename = join(dir, 'data.sqlite');
  const env = {CLOCKWORK_LM_BASE_URL:first.url, LM_STUDIO_API_KEY:'test-mounted-token'};
  let db = openStore(filename);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, {recursive:true, force:true});
  });
  let runtime = await createRuntime({db, root, env});
  assert.equal(runtime.settings().profiles.find(p => p.id==='local').credentialConfigured, true);
  await runtime.chat('First server');
  assert.equal(first.requests[0].token, 'Bearer test-mounted-token');
  const update = {name:'Editorial',goal:'Proofread copy before publication.',model:'example-model',baseUrl:second.url};
  runtime.updateSettings(changes(runtime, update));
  assert.equal(runtime.settings().profiles.find(p => p.id==='local').credentialConfigured, false);
  await runtime.chat('Read this copy');
  assert.equal(second.requests[0].token, undefined);
  assert.equal(second.requests[0].payload.model, 'example-model');
  assert.match(second.requests[0].payload.messages[0].content, /Proofread copy before publication/);
  assert.equal(second.requests[0].payload.tools, undefined);
  runtime.updateSettings(changes(runtime, {credential:'test-web-only-token'}));
  assert.doesNotMatch(JSON.stringify([runtime.state(),runtime.settings()]), /test-web-only-token|test-mounted-token/);
  const encrypted = db.prepare('SELECT sealed FROM agent_credentials').get().sealed;
  assert.equal(Buffer.from(encrypted).includes('test-web-only-token'), false);
  db.close();

  db = openStore(filename);
  runtime = await createRuntime({db, root, env});
  assert.equal(runtime.settingsRevision(), 2);
  assert.equal(runtime.agentInfo().goal, update.goal);
  assert.equal(readFileSync(filename + '.key').length, 32);
  await runtime.chat('Another proofread');
  assert.equal(second.requests.at(-1).token, 'Bearer test-web-only-token');
  assert.doesNotMatch(JSON.stringify(second.requests.at(-1).payload), /test-web-only-token|test-mounted-token/);
  runtime.updateSettings(changes(runtime, {baseUrl:first.url,credential:''}));
  await runtime.chat('Back on original server');
  assert.equal(first.requests.at(-1).token, undefined);
  runtime.updateSettings(changes(runtime, {baseUrl:second.url}));
  await runtime.chat('Use this destination again');
  assert.equal(second.requests.at(-1).token, 'Bearer test-web-only-token');
});

test('stale revisions, unsafe endpoints, policy changes and edits during a chat leave settings intact', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  let release;
  const provider = {complete:()=> new Promise(resolve => {release=()=>resolve({text:'Hello',calls:[]});})};
  const runtime = await createRuntime({db, root, env:{}, provider});
  const edit = changes(runtime, {name:'One'});
  runtime.updateSettings(edit);
  assert.throws(() => runtime.updateSettings({...edit, name:'Two'}), {status:409});
  for (const attempt of [
    {baseUrl:'https://api.openai.com/v1'}, {baseUrl:'http://test:password@127.0.0.1/v1'},
    {profileId:'hosted'}, {scope:'another-agent'}, {tools:['admin']}, {localOnly:false},
    {credential:'wrong\nheader'}, {nativeTools:'yes'},
  ]) assert.throws(() => runtime.updateSettings({...changes(runtime), ...attempt}), {status:400});
  const pending = runtime.chat('Hi');
  assert.throws(() => runtime.updateSettings(changes(runtime, {model:'unexpected'})), {status:409});
  release();
  await pending;
  assert.equal(runtime.agentInfo().name, 'One');
  assert.equal(runtime.settingsRevision(), 1);
  assert.equal(runtime.settings().activeProfile, 'local');
});

test('operator cloud ceiling applies to restored settings and new workers inherit no deployment credentials', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const env = {
    CLOCKWORK_AGENT_ID:'studio', CLOCKWORK_LOCAL_ONLY:'false',
    OPENAI_API_KEY:'test-global-openai-key', LM_STUDIO_API_KEY:'test-global-lm-key',
  };
  let runtime = await createRuntime({db, root, env});
  assert.ok(runtime.settings().profiles.every(p=>!p.credentialConfigured));
  runtime.updateSettings(changes(runtime, {profileId:'hosted',model:'selected-model',credential:'test-owner-key'}));
  assert.equal(runtime.active().provider, 'openai');
  runtime = await createRuntime({db, root, env:{...env,CLOCKWORK_LOCAL_ONLY:'true'}});
  assert.equal(runtime.active().provider, 'lmstudio');
  assert.ok(runtime.settings().profiles.every(p=>p.provider==='lmstudio' && !p.credentialConfigured));
  assert.throws(() => runtime.selectProfile('hosted'), {status:400});
});
