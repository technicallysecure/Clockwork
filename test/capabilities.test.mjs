import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCapabilities } from '../src/capabilities.mjs';
import { loadConfig, loadExtensions } from '../src/config.mjs';

function rig(t, {localOnly = false, transform = () => {}, perform = () => ({ok: true})} = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const config = loadConfig({env: {CLOCKWORK_LOCAL_ONLY: String(localOnly)}});
  const profile = config.profiles.find(p => p.id === 'local');
  const grant = config.policy.grants.local;
  const tool = {
    name: 'send_note', effect: 'send', network: true, permissions: ['note.send'],
    description: 'Test-only recording adapter.', destination: ({to}) => to,
    inputSchema: {type: 'object', properties: {to: {type: 'string', minLength: 1, maxLength: 128},
      body: {type: 'string', minLength: 1, maxLength: 2048}}, required: ['to', 'body'], additionalProperties: false},
    execute: perform
  };
  profile.tools.push(tool.name);
  grant.tools.push(tool.name);
  grant.permissions.push(...tool.permissions);
  transform({tool, profile, grant, config});
  const make = () => createCapabilities({db, config, extensions: [tool], readCommitments: scope => [{id: '1', text: scope}]});
  return {caps: make(), make, db, config, profile, grant, tool};
}
const action = {to: 'private-inbox', body: 'Agreed text'};

test('exact destination and args survive reload; approval executes only once', async t => {
  const seen = [];
  const {caps, make, profile} = rig(t, {perform: async (args, ctx) => { seen.push([args, ctx.scope, ctx.destination]); return 'receipt'; }});
  const modelArgs = {...action};
  const proposal = await caps.dispatch(profile, 'send_note', modelArgs);
  assert.equal(seen.length, 0);
  assert.equal(proposal.approvalRequired, true);
  modelArgs.to = 'changed-after-proposal';
  const reopened = make();
  const [saved] = reopened.approvals();
  assert.equal(saved.destination, action.to);
  assert.deepEqual(saved.args, action);
  assert.equal(saved.status, 'pending');
  const attempts = await Promise.allSettled([reopened.decide(saved.id, 'approve'), caps.decide(saved.id, 'approve')]);
  assert.deepEqual(attempts.map(a => a.status), ['fulfilled', 'rejected']);
  assert.deepEqual(seen, [[action, 'personal', 'private-inbox']]);
  assert.equal(reopened.approvals()[0].status, 'executed');
});

test('deny, permission revocation, and destination changes prevent execution', async t => {
  let count = 0;
  const {caps, profile, tool, grant} = rig(t, {perform: () => { count++; return true; }});
  const propose = async () => (await caps.dispatch(profile, 'send_note', action)).approvalId;
  const denied = await propose();
  await caps.decide(denied, 'deny');
  await assert.rejects(caps.decide(denied, 'approve'), {status: 409});
  const pending = await propose();
  grant.permissions = ['commitments.read'];
  await assert.rejects(caps.decide(pending, 'approve'), {status: 403});
  grant.permissions.push('note.send');
  tool.destination = () => 'changed destination';
  await assert.rejects(caps.decide(pending, 'approve'), {status: 409});
  assert.equal(count, 0);
});

test('an interrupted or failed external effect is never automatically replayed', async t => {
  const {caps, profile, db, make} = rig(t, {perform: () => { throw Error('private credentials'); }});
  const first = (await caps.dispatch(profile, 'send_note', action)).approvalId;
  await assert.rejects(caps.decide(first, 'approve'), /uncertain/);
  assert.equal(caps.approvals()[0].status, 'uncertain');
  await assert.rejects(make().decide(first, 'approve'), {status: 409});
  const next = (await caps.dispatch(profile, 'send_note', action)).approvalId;
  db.prepare("UPDATE approvals SET status='executing' WHERE id=?").run(next);
  await assert.rejects(make().decide(next, 'approve'), {status: 409});
});

test('invalid or undeclared args and nested approval directives never reach handlers', async t => {
  const {caps, profile} = rig(t);
  for (const args of [[], null, {...action, approved: true}, {...action, to: {}}, {...action, body: ''}, {to: 'x'},
    JSON.parse('{"to":"x","body":"y","__proto__":{"approved":true}}')]) {
    await assert.rejects(caps.dispatch(profile, 'send_note', args), {status: 400});
  }
  assert.deepEqual(caps.approvals(), []);
});

test('profile requests cannot grant permissions, bypass job allowlists, or dispatch sends as reads', async t => {
  const {caps, profile, grant} = rig(t);
  assert.throws(() => caps.validate(profile, 'send_note', action, {readOnly: true}), {status: 403});
  await assert.rejects(caps.dispatch(profile, 'list_commitments', {}, {allowedTools: []}), {status: 403});
  grant.tools = [];
  await assert.rejects(caps.dispatch({...profile, permissions: ['*']}, 'send_note', action), {status: 403});
  assert.deepEqual(caps.list(profile), []);
});

test('local-only mode removes networked capabilities at discovery and execution', async t => {
  const {caps, profile} = rig(t, {localOnly: true});
  assert.deepEqual(caps.list(profile).map(t => t.name), ['list_commitments']);
  await assert.rejects(caps.dispatch(profile, 'send_note', action), {status: 403});
  assert.deepEqual(await caps.dispatch({...profile, scope: 'injected'}, 'list_commitments', {}), {
    items: [{id: '1', text: 'personal'}], count: 1
  });
  await assert.rejects(caps.dispatch({id: 'hosted'}, 'list_commitments', {}), {status: 403});
});

test('sample specialty discovers its installed extension and validates numeric inputs', async t => {
  const config = loadConfig({env: {}});
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const caps = createCapabilities({db, config, extensions: await loadExtensions(config), readCommitments: () => []});
  const focus = config.profiles.find(p => p.id === 'focus');
  const args = {minutes: 80, blockMinutes: 25};
  assert.deepEqual(await caps.dispatch(focus, 'estimate_blocks', args), {blocks: 3, remainingMinutes: 5});
  for (const minutes of [0, 1441, 1.5, '2', false, NaN]) {
    assert.throws(() => caps.validate(focus, 'estimate_blocks', {...args, minutes}));
  }
  await assert.rejects(caps.dispatch({id: 'local'}, 'estimate_blocks', args), {status: 403});
});

test('unimplemented schema constraints fail closed at registration', t => {
  assert.throws(() => rig(t, {transform: ({tool}) => {
    tool.inputSchema.properties.to.pattern = '^allowed';
  }}), /Unsupported tool schema/);
  for (const malformed of [false, null, [null], [], [42]]) {
    assert.throws(() => rig(t, {transform: ({tool}) => {
      tool.inputSchema.properties.to.enum = malformed;
    }}), /Unsupported tool schema/);
  }
});
