import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../src/scheduler.mjs';
import { createInbox } from '../src/inbox.mjs';

const start = Date.parse('2026-11-22T17:00:00Z');
const basic = {
  goal: 'Check open commitments', profileId: 'local', timezone: 'America/Los_Angeles',
  localTime: '2026-11-22T09:00', recurrence: 'once', condition: 'nonempty', budgetSeconds: 30,
  allowedTools: ['list_commitments'], tool: { name: 'list_commitments', args: {} },
};

function fixture(t, { file = ':memory:', clock = { time: start }, read = () => ({ items: ['follow up'], count: 1 }), createDelivery } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000');
  const getProfile = id => {
    if (id !== 'local') throw Object.assign(new Error('Unknown profile'), { status: 400 });
    return { id, scope: 'personal' };
  };
  const calls = [];
  const capabilities = {
    list: () => [{ name: 'list_commitments', effect: 'read' }, { name: 'send_message', effect: 'send' }],
    validate(profile, name, args, opts) {
      assert.equal(profile.id, 'local');
      if (name !== 'list_commitments' || !opts.allowedTools.includes(name) || !opts.readOnly ||
          !args || Object.keys(args).length) {
        throw Object.assign(new Error('Invalid read'), { status: 400 });
      }
    },
    async dispatch(profile, name, args, opts) {
      capabilities.validate(profile, name, args, opts);
      calls.push(opts);
      return read(opts.signal);
    },
  };
  const scheduler = createScheduler({ db, getProfile, capabilities, createDelivery, now: () => clock.time, leaseMs: 1500 });
  t.after(async () => { await scheduler.stop(); if (db.isOpen) db.close(); });
  return { db, scheduler, clock, calls, capabilities };
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clockwork-scheduler-'));
  // Registered before fixtures, explicitly close all handles in these tests.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.db');
}

test('a saved schedule survives reopening the file and multiple polls produce one inbox entry', async t => {
  const file = workspace(t);
  const before = fixture(t, { file });
  const job = before.scheduler.create(basic);
  before.db.close();
  const after = fixture(t, { file });
  await Promise.all([after.scheduler.tick(), after.scheduler.tick()]);
  await after.scheduler.tick();
  assert.equal(after.scheduler.notifications().length, 1);
  assert.equal(after.scheduler.notifications()[0].jobId, job.id);
  assert.equal(after.scheduler.list()[0].status, 'completed');
  assert.equal(after.scheduler.runs()[0].attempts, 1);
  assert.equal(after.calls.length, 1);
  after.db.close();
});

test('schedule creation retries preserve the original job after restart and distinguish new approvals', async t => {
  const file = workspace(t);
  const before = fixture(t, { file });
  const key = randomUUID();
  const spec = { ...basic, requestId: key };
  const original = before.scheduler.create(spec);
  await before.scheduler.tick();
  before.db.close();
  const after = fixture(t, { file });
  const replay = after.scheduler.create({ ...spec, requestId: key.toUpperCase() });
  assert.equal(replay.id, original.id);
  assert.equal(replay.status, 'completed');
  assert.throws(() => after.scheduler.create({ ...spec, goal: 'Different goal' }), { status: 409 });
  assert.throws(() => after.scheduler.create({ ...spec, requestId: 'bad-key' }), { status: 400 });
  await after.scheduler.tick();
  assert.equal(after.scheduler.notifications().length, 1);
  assert.equal(after.scheduler.list().length, 1);
  assert.notEqual(after.scheduler.create({ ...spec, requestId: randomUUID() }).id, original.id);
  assert.notEqual(after.scheduler.create(basic).id, after.scheduler.create(basic).id);
  assert.equal(after.scheduler.list().length, 4);
  after.db.close();
});

test('a stale worker cannot deliver after another worker recovers the same persisted occurrence', async t => {
  const file = workspace(t);
  const clock = { time: start };
  let unblock;
  const slow = fixture(t, { file, clock, read: () => new Promise(resolve => { unblock = resolve; }) });
  slow.scheduler.create(basic);
  const late = slow.scheduler.tick();
  const id = slow.scheduler.runs()[0].id;
  const fast = fixture(t, { file, clock });
  await fast.scheduler.tick();
  assert.equal(fast.calls.length, 0);
  clock.time += 3 * 24 * 60 * 60 * 1000;
  await fast.scheduler.tick();
  unblock({ items: ['stale result'] });
  await late;
  assert.equal(fast.scheduler.runs().length, 1);
  assert.equal(fast.scheduler.runs()[0].id, id);
  assert.equal(fast.scheduler.runs()[0].attempts, 2);
  assert.equal(fast.scheduler.notifications().length, 1);
  assert.doesNotMatch(fast.scheduler.notifications()[0].body, /stale result/);
  slow.db.close();
  fast.db.close();
});

test('a failed commit rolls back inbox delivery and run completion together', async t => {
  const { scheduler, db, clock } = fixture(t);
  scheduler.create(basic);
  db.exec(`CREATE TRIGGER simulate_interruption BEFORE UPDATE OF next_at ON scheduled_jobs
    BEGIN SELECT RAISE(ABORT, 'interrupt commit'); END;`);
  await assert.rejects(scheduler.tick(), /interrupt commit/);
  assert.equal(scheduler.notifications().length, 0);
  assert.equal(scheduler.runs()[0].status, 'running');
  db.exec('DROP TRIGGER simulate_interruption');
  clock.time += 2000;
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(scheduler.notifications().length, 1);
  assert.equal(scheduler.runs()[0].attempts, 2);
});

test('local delivery adapters receive the matched occurrence inside its transaction', async t => {
  const received = [];
  const { scheduler } = fixture(t, { createDelivery(db) {
    const inbox = createInbox(db);
    return {
      deliver(entry) {
        assert.equal(db.isTransaction, true);
        received.push(entry);
        inbox.deliver(entry);
        inbox.deliver(entry);
      },
      list: inbox.list,
    };
  } });
  const job = scheduler.create(basic);
  await scheduler.tick();
  const entries = scheduler.notifications();
  assert.equal(entries.length, 1);
  assert.deepEqual(received, [{
    runId: scheduler.runs()[0].id, jobId: job.id, goal: job.goal, createdAt: start, body: entries[0].body,
  }]);
  scheduler.create({ ...basic, condition: 'never' });
  await scheduler.tick();
  assert.equal(received.length, 1);
});

test('empty and never conditions stay quiet and unknown result shapes fail closed', async t => {
  const data = [[], { count: 0 }, { items: [] }, { unrelated: true }, { count: 42 }];
  const { scheduler } = fixture(t, { read: () => data.shift() });
  for (let i = 0; i < 5; i++) {
    scheduler.create({ ...basic, condition: i === 4 ? 'never' : 'nonempty' });
    await scheduler.tick();
  }
  assert.equal(scheduler.notifications().length, 0);
  assert.equal(scheduler.runs().filter(r => r.status === 'quiet').length, 4);
  assert.equal(scheduler.runs().filter(r => r.status === 'failed').length, 1);
});

test('unavailable reads retry within budget and permanent policy revocation fails immediately', async t => {
  let calls = 0;
  const { scheduler, clock, capabilities } = fixture(t, { read: () => {
    if (calls++ === 0) throw new Error('Unavailable');
    return { count: 1 };
  } });
  scheduler.create(basic);
  await scheduler.tick();
  assert.equal(scheduler.runs()[0].status, 'retrying');
  await scheduler.tick();
  assert.equal(calls, 1);
  clock.time += 1000;
  await scheduler.tick();
  assert.equal(scheduler.runs()[0].attempts, 2);
  assert.equal(scheduler.notifications().length, 1);
  scheduler.create(basic);
  capabilities.validate = () => { throw Object.assign(new Error('Revoked'), { status: 403 }); };
  await scheduler.tick();
  assert.equal(scheduler.runs()[0].status, 'failed');
  assert.equal(scheduler.notifications().length, 1);
});

test('late and uncooperative reads cannot deliver after the time budget', async t => {
  const { scheduler, calls } = fixture(t, { read: () => new Promise(() => {}) });
  scheduler.create({ ...basic, budgetSeconds: 1 });
  await scheduler.tick();
  assert.equal(scheduler.runs()[0].status, 'failed');
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(scheduler.notifications().length, 0);
});

test('pause and cancel invalidate running claims before delivery, including while disconnected', async t => {
  let unblock;
  const { scheduler } = fixture(t, { read: () => new Promise(resolve => { unblock = resolve; }) });
  const job = scheduler.create(basic);
  let inFlight = scheduler.tick();
  scheduler.change(job.id, 'pause');
  unblock({ count: 2 });
  await inFlight;
  await scheduler.tick();
  assert.equal(scheduler.runs()[0].status, 'held');
  scheduler.change(job.id, 'resume');
  inFlight = scheduler.tick();
  scheduler.change(job.id, 'cancel');
  unblock({ count: 1 });
  await inFlight;
  assert.equal(scheduler.runs()[0].status, 'cancelled');
  assert.equal(scheduler.list()[0].nextAt, null);
  assert.equal(scheduler.notifications().length, 0);
  assert.throws(() => scheduler.change(job.id, 'resume'), /finished/);
});

test('long downtime coalesces daily and weekly backlog and preserves civil time across DST', async t => {
  const { scheduler, clock } = fixture(t);
  const spec = { ...basic, localTime: '2026-03-07T02:30', recurrence: 'daily' };
  clock.time = Date.parse('2026-03-07T10:30:00Z');
  scheduler.create(spec);
  await scheduler.tick();
  assert.equal(scheduler.list()[0].nextAt, '2026-03-09T09:30:00.000Z'); // Sunday 02:30 does not exist.
  clock.time = Date.parse('2026-11-01T19:00:00Z');
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(scheduler.notifications().length, 2);
  assert.equal(scheduler.list()[0].nextAt, '2026-11-02T10:30:00.000Z');

  const weekly = scheduler.create({ ...basic, localTime: '2026-10-25T01:30', recurrence: 'weekly' });
  // Fold policy chooses the earlier instant on Nov 1. After noon on Nov 1 the next Sunday is Nov 8.
  await scheduler.tick();
  assert.equal(scheduler.list().find(j => j.id === weekly.id).nextAt, '2026-11-08T09:30:00.000Z');
  assert.equal(scheduler.create({ ...basic, localTime: '2026-11-01T01:30' }).nextAt, '2026-11-01T08:30:00.000Z');
  assert.throws(() => scheduler.create({ ...basic, localTime: '2026-03-08T02:30' }), /skipped/);
  assert.throws(() => scheduler.create({ ...basic, localTime: '2026-02-31T02:30' }), /Invalid/);
});

test('plain reminders require no tool and inappropriate tool grants or invalid arguments are rejected', async t => {
  const { scheduler, calls } = fixture(t);
  const reminder = scheduler.create({ ...basic, allowedTools: [], tool: null, condition: 'always' });
  await scheduler.tick();
  assert.equal(scheduler.notifications()[0].body, reminder.goal);
  assert.equal(calls.length, 0);
  assert.throws(() => scheduler.create({ ...basic, allowedTools: ['send_message'] }), /read permission/);
  assert.throws(() => scheduler.create({ ...basic, allowedTools: [] }), /allowed read tool/);
  assert.throws(() => scheduler.create({ ...basic, tool: { name: 'list_commitments', args: { write: true } } }), /Invalid read/);
  assert.throws(() => scheduler.create({ ...basic, timezone: 'Invalid/Timezone' }), /Unknown timezone/);
});
