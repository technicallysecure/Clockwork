import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.mjs';
import { openStore } from '../src/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assignment = text => ({requestId:randomUUID(), text, profileId:'local', revision:0});

test('a replayed assignment returns the same success after restart and keeps one commitment', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clockwork-assign-'));
  const path = join(dir, 'agent.sqlite');
  let db = openStore(path);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, {recursive:true, force:true});
  });
  let runtime = await createRuntime({db,root,env:{}});
  const task = assignment('/commit Check the reimbursement');
  assert.deepEqual(await runtime.assign(task), {ok:true});
  runtime.selectProfile('focus');
  db.close();
  db = openStore(path);
  runtime = await createRuntime({db,root,env:{}});
  assert.deepEqual(await runtime.assign(task), {ok:true});
  await assert.rejects(runtime.assign({...task, text:'/commit A different item'}), {status:409});
  await assert.rejects(runtime.assign({...task, profileId:'focus'}), {status:409});
  runtime.selectProfile('local');
  assert.equal(runtime.state().commitments.length, 1);
  assert.equal(runtime.state().messages.length, 2);
});

test('matching concurrent deliveries share a turn; busy or stale targets can retry without a spent claim', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  let count = 0;
  const {promise,resolve} = Promise.withResolvers();
  const provider = {complete:async () => { count++; return await promise; }};
  const runtime = await createRuntime({db,root,env:{},provider});
  const task = assignment('Review the agenda');
  const busy = assignment('/commit Read agenda');
  await assert.rejects(runtime.assign({...task, requestId:'invalid-id'}), {status:400});
  await assert.rejects(runtime.assign({...task, revision:2}), {status:409});
  const first = runtime.assign(task);
  const replay = runtime.assign({...task,requestId:task.requestId.toUpperCase()});
  await assert.rejects(runtime.assign(busy), {status:409});
  await assert.rejects(runtime.assign({...task, text:'Something else'}), {status:409});
  assert.equal(count, 1);
  // A replacement runtime cannot establish the outcome of an older live claim.
  const replacement = await createRuntime({db,root,env:{},provider});
  await assert.rejects(replacement.assign(task), {status:409});
  resolve({text:'Ready.',calls:[]});
  assert.deepEqual(await Promise.all([first,replay]), [{ok:true},{ok:true}]);
  assert.deepEqual(await replacement.assign(task), {ok:true});
  await replacement.assign(busy);
  assert.equal(runtime.state().messages.length, 4);
  assert.equal(runtime.state().commitments.length, 1);
});

test('a provider failure replay preserves the recorded error and does not append another turn', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  let count = 0;
  const provider = {complete: async () => {
    count++;
    throw Object.assign(new Error('Selected provider timed out.'), {status:504});
  }};
  const runtime = await createRuntime({db,root,env:{},provider});
  const task = assignment('Please review the notes');
  for (let i=0; i<2; i++) await assert.rejects(runtime.assign(task), {status:504, message:'Selected provider timed out.'});
  assert.equal(count, 1);
  assert.deepEqual(runtime.state().messages.map(m=>m.role), ['user','error']);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM assignment_receipts').all()), /Please review the notes/);
});
