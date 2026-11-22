import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const serverModule = new URL('../src/server.mjs', import.meta.url).href;

// Use an advancing test clock to cross calendar days without modifying the
// server's production entry point or editing any SQLite rows from the test.
async function boot({ dbPath, password, instant }) {
  const source = `
    const clock = Date.now.bind(Date);
    const offset = Number(process.argv[1]) - clock();
    Date.now = () => clock() + offset;
    await import(process.argv[2]);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, String(instant), serverModule], {
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH, CLOCKWORK_DB: dbPath,
      CLOCKWORK_BIND: '127.0.0.1', CLOCKWORK_PORT: '0', CLOCKWORK_PASSWORD: password,
      CLOCKWORK_LOCAL_ONLY: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  const crash = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  };
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Timed out starting test server.')), 10000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('close', () => { clearTimeout(timer); reject(new Error('Test server exited. ' + stderr)); });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /listening on 127\.0\.0\.1:(\d+)\s/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const origin = 'http://127.0.0.1:' + port;
    let cookie = '';
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(origin + path, {
        method, headers: {
          'Connection': 'close', 'Content-Type': 'application/json',
          'X-Clockwork-Request': '1', 'X-Clockwork-Profile': 'local', cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return payload;
    };
    await request('/api/login', 'POST', { password });
    return { request, crash };
  } catch (error) {
    await crash();
    throw error;
  }
}

async function waitForRuns(server, expected) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const state = await server.request('/api/state');
    if (state.runs.length >= expected && state.runs.every(run => run.finishedAt)) return state;
    await delay(80);
  }
  assert.fail('Expected the worker to finish ' + expected + ' run(s).');
}

test('approved follow-up and commitments survive process kills, deliver once, and stay quiet when empty', { timeout: 40000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clockwork-process-'));
  const settings = { dbPath: join(dir, 'state.sqlite'), password: randomUUID() };
  const first = Date.parse('2026-11-22T10:00:00Z');
  let server;
  try {
    server = await boot({ ...settings, instant: first });
    await server.request('/api/chat', 'POST', { text: '/commit Check the spare key' });
    await server.request('/api/jobs', 'POST', {
      goal: 'Review open commitments', profileId: 'local', allowedTools: ['list_commitments'],
      tool: { name: 'list_commitments', args: {} }, budgetSeconds: 15, timezone: 'UTC',
      localTime: '2026-11-22T12:00', recurrence: 'daily', condition: 'nonempty',
    });
    const pending = await server.request('/api/state');
    assert.equal(pending.jobs.length, 1);
    assert.equal(pending.runs.length, 0);
    await server.crash();

    server = await boot({ ...settings, instant: first + 3 * 3600000 });
    const delivered = await waitForRuns(server, 1);
    assert.equal(delivered.jobs[0].id, pending.jobs[0].id);
    assert.equal(delivered.notifications.length, 1);
    assert.equal(delivered.notifications[0].runId, delivered.runs[0].id);
    assert.match(delivered.notifications[0].body, /Check the spare key/);
    assert.equal(delivered.commitments[0].done, false);
    await server.request('/api/commitments/' + delivered.commitments[0].id, 'PATCH', { done: true });
    await server.crash();

    server = await boot({ ...settings, instant: first + 27 * 3600000 });
    const quiet = await waitForRuns(server, 2);
    assert.equal(quiet.commitments[0].done, true);
    assert.deepEqual(quiet.runs.map(run => run.status), ['quiet', 'notified']);
    assert.deepEqual(quiet.notifications, delivered.notifications);
    await server.crash();

    server = await boot({ ...settings, instant: first + 28 * 3600000 });
    const replay = await server.request('/api/state');
    assert.deepEqual(replay.runs, quiet.runs);
    assert.deepEqual(replay.notifications, delivered.notifications);
    assert.equal(replay.jobs[0].nextAt, '2026-11-24T12:00:00.000Z');
  } finally {
    if (server) await server.crash();
    rmSync(dir, { recursive: true, force: true });
  }
});
