import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createInbox } from './inbox.mjs';
import { memoryScope } from './context.mjs';

const minute = 60_000;
const day = 24 * 60 * minute;
const maxAttempts = 3;
const formatters = new Map();

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function formatter(zone) {
  if (typeof zone !== 'string' || zone.length > 80 || !/^[a-zA-Z][a-zA-Z0-9_/+\-]*$/.test(zone)) {
    throw invalid('Choose an IANA timezone, such as America/Los_Angeles.');
  }
  if (!formatters.has(zone)) {
    try {
      formatters.set(zone, new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }));
    } catch {
      throw invalid('Unknown timezone.');
    }
  }
  return formatters.get(zone);
}

// Encode a wall clock reading as civil calendar fields on a UTC number line.
function civilAt(epoch, zone) {
  const values = Object.fromEntries(formatter(zone).formatToParts(epoch).map(p => [p.type, p.value]));
  return Date.UTC(+values.year, +values.month - 1, +values.day, +values.hour, +values.minute);
}

function parseWallTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw invalid('Choose a local date and time to the nearest minute.');
  }
  const epoch = Date.parse(value + ':00Z');
  if (!Number.isFinite(epoch) || epoch < 0 || new Date(epoch).toISOString().slice(0, 16) !== value) {
    throw invalid('Invalid local date and time.');
  }
  return epoch;
}

// Sample offsets on both sides of transitions. A gap has zero matches, a fold two.
function resolveCivil(civil, zone) {
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 12) {
    const sample = civil + hours * 60 * minute;
    offsets.add(civilAt(sample, zone) - sample);
  }
  const matches = Array.from(offsets, offset => civil - offset).filter(epoch => civilAt(epoch, zone) === civil);
  return matches.length ? Math.min(...matches) : null;
}

function nextOccurrence(spec, after) {
  if (spec.recurrence === 'once') return null;
  const first = parseWallTime(spec.localTime);
  const interval = spec.recurrence === 'daily' ? day : 7 * day;
  const civilNow = civilAt(after, spec.timezone);
  const steps = Math.max(0, Math.floor((civilNow - first) / interval));
  for (let civil = first + steps * interval; ; civil += interval) {
    const utc = resolveCivil(civil, spec.timezone);
    if (utc !== null && utc > after) return utc;
  }
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const iso = n => n == null ? null : new Date(n).toISOString();
const jobView = row => ({
  ...JSON.parse(row.spec), id: row.id, status: row.status, nextAt: iso(row.next_at), createdAt: iso(row.created_at),
});

function nonempty(result) {
  if (Array.isArray(result)) return result.length > 0;
  if (result && Array.isArray(result.items)) return result.items.length > 0;
  if (result && Number.isSafeInteger(result.count) && result.count >= 0) return result.count > 0;
  throw invalid('This condition needs a list, an items array, or a nonnegative count.');
}

function accrued(row, time) {
  if (row.status !== 'running') return row.spent_ms;
  // A crashed process can only have used its last live lease. Portable data
  // volumes may be offline for days before the next owner reopens them.
  return row.spent_ms + Math.max(0, Math.min(row.lease_until, time) - row.started_at);
}

export function createScheduler({
  db, getProfile, capabilities, createDelivery = createInbox, now = Date.now, pollMs = 1000, leaseMs = 4000,
  onError = () => console.error('Clockwork scheduler could not finish its database operation.'),
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY, spec TEXT NOT NULL, status TEXT NOT NULL, next_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_due ON scheduled_jobs(status, next_at);
    CREATE TABLE IF NOT EXISTS schedule_requests (
      request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES scheduled_jobs(id)
    );
    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES scheduled_jobs(id), due_at INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, spent_ms INTEGER NOT NULL DEFAULT 0,
      token TEXT, started_at INTEGER, lease_until INTEGER, retry_at INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT '', finished_at INTEGER, UNIQUE(job_id, due_at)
    );
  `);
  const delivery = createDelivery(db);
  const readJob = id => db.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(id);
  let timer, active;
  let polling = false;
  let inFlight = null;

  function normalize(input) {
    if (!input || typeof input !== 'object') throw invalid('Supply a schedule.');
    const { goal, profileId, allowedTools = [], budgetSeconds = 30, timezone, localTime,
      recurrence = 'once', condition = 'always', tool = null } = input;
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000) throw invalid('Enter a goal of 1–2000 characters.');
    if (!Array.isArray(allowedTools) || allowedTools.length > 64 ||
        allowedTools.some(name => typeof name !== 'string') || new Set(allowedTools).size !== allowedTools.length) {
      throw invalid('Choose a list of distinct allowed tools.');
    }
    return { goal: goal.trim(), profileId, allowedTools: [...allowedTools].sort(), budgetSeconds, timezone, localTime,
      recurrence, condition, tool: tool && { name: tool.name, args: tool.args } };
  }

  function firstOccurrence(spec) {
    const { profileId, allowedTools, budgetSeconds, timezone, localTime, recurrence, condition, tool } = spec;
    if (!['once', 'daily', 'weekly'].includes(recurrence)) throw invalid('Choose a supported recurrence.');
    if (!['always', 'never', 'nonempty'].includes(condition)) throw invalid('Choose a supported notification condition.');
    if (!Number.isInteger(budgetSeconds) || budgetSeconds < 1 || budgetSeconds > 600) throw invalid('Budget must be 1–600 whole seconds.');
    if (typeof profileId !== 'string' || !profileId) throw invalid('Choose a profile.');
    const profile = getProfile(profileId);
    if (!profile) throw invalid('Unknown profile.');
    const readable = new Set(capabilities.list(profile, allowedTools).filter(t => t.effect === 'read').map(t => t.name));
    if (allowedTools.some(t => !readable.has(t))) throw invalid('A selected tool lacks read permission.');
    if (condition === 'nonempty' && !tool) throw invalid('Select a read tool for this condition.');
    if (tool !== null) {
      if (!tool || !allowedTools.includes(tool.name) || !tool.args || Array.isArray(tool.args) || typeof tool.args !== 'object') {
        throw invalid('Select an allowed read tool and supply its arguments as an object.');
      }
      capabilities.validate(profile, tool.name, tool.args, { allowedTools, readOnly: true, ownerInput:true });
    }
    const nextAt = resolveCivil(parseWallTime(localTime), timezone);
    if (nextAt == null) throw invalid('That clock time is skipped by a timezone transition. Choose another time.');
    return nextAt;
  }

  function create(input) {
    const spec = normalize(input);
    if (spec.tool) {
      const profile = getProfile(spec.profileId);
      if (!profile) throw invalid('Unknown profile.');
      if (profile.provider === 'chatgpt-plan' && !profile.planAccountId) {
        throw invalid('Connect the ChatGPT workspace before scheduling a read.');
      }
      spec.readContext = memoryScope(profile);
    }
    const requestId = input.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId))) {
      throw invalid('Schedule request ID must be a UUID.');
    }
    const key = requestId?.toLowerCase();
    return transaction(db, () => {
      if (key) {
        const saved = db.prepare(`SELECT j.* FROM schedule_requests r JOIN scheduled_jobs j ON r.job_id=j.id
          WHERE r.request_id=?`).get(key);
        if (saved) {
          const {readContext, ...original} = JSON.parse(saved.spec);
          const {readContext:current, ...requested} = spec;
          if (!isDeepStrictEqual(original, requested) || (readContext !== undefined && readContext !== current)) {
            throw invalid('That request ID belongs to a different schedule or workspace.', 409);
          }
          return jobView(saved);
        }
      }
      const nextAt = firstOccurrence(spec);
      const id = randomUUID();
      db.prepare("INSERT INTO scheduled_jobs VALUES (?,?, 'active', ?,?)").run(id, JSON.stringify(spec), nextAt, now());
      if (key) db.prepare('INSERT INTO schedule_requests(request_id,job_id) VALUES (?,?)').run(key, id);
      return jobView(readJob(id));
    });
  }

  function change(id, action) {
    const job = transaction(db, () => {
      const row = readJob(id);
      if (!row) throw invalid('Schedule not found.', 404);
      if (!['pause', 'resume', 'cancel'].includes(action)) throw invalid('Unknown schedule action.');
      const target = { pause: 'paused', resume: 'active', cancel: 'cancelled' }[action];
      if (row.status === target) return jobView(row);
      if (!['active', 'paused'].includes(row.status)) throw invalid('This schedule has finished.', 409);
      db.prepare('UPDATE scheduled_jobs SET status=?,next_at=? WHERE id=?')
        .run(target, action === 'cancel' ? null : row.next_at, id);
      const run = db.prepare('SELECT * FROM scheduled_runs WHERE job_id=? AND due_at=?').get(id, row.next_at);
      if (run && ['running', 'held', 'retrying'].includes(run.status) && action !== 'resume') {
        const time = now();
        db.prepare('UPDATE scheduled_runs SET status=?,spent_ms=?,token=NULL,lease_until=NULL,finished_at=?,detail=? WHERE id=?')
          .run(action === 'pause' ? 'held' : 'cancelled', accrued(run, time), action === 'pause' ? null : time,
            action === 'pause' ? 'Paused by owner.' : 'Cancelled by owner.', run.id);
      }
      return jobView(readJob(id));
    });
    if (action !== 'resume' && active?.jobId === id) active.controller.abort();
    return job;
  }

  // Called inside the same transaction as inbox delivery.
  function finish(run, spec, status, detail, time) {
    db.prepare('UPDATE scheduled_runs SET status=?,token=NULL,lease_until=NULL,finished_at=?,detail=? WHERE id=?')
      .run(status, time, detail, run.id);
    const nextAt = nextOccurrence(spec, Math.max(time, run.due_at));
    db.prepare('UPDATE scheduled_jobs SET status=?,next_at=? WHERE id=?')
      .run(nextAt === null ? 'completed' : 'active', nextAt, run.job_id);
  }

  function claim() {
    return transaction(db, () => {
      const time = now();
      const job = db.prepare(`SELECT j.* FROM scheduled_jobs j LEFT JOIN scheduled_runs r
        ON r.job_id=j.id AND r.due_at=j.next_at
        WHERE j.status='active' AND j.next_at<=? AND (r.id IS NULL OR r.status='held'
          OR (r.status='retrying' AND r.retry_at<=?) OR (r.status='running' AND r.lease_until<=?))
        ORDER BY j.next_at,j.created_at,j.id LIMIT 1`).get(time, time, time);
      if (!job) return null;
      const spec = JSON.parse(job.spec);
      db.prepare(`INSERT INTO scheduled_runs (id,job_id,due_at,status) VALUES (?,?,?,'retrying')
        ON CONFLICT(job_id,due_at) DO NOTHING`).run(randomUUID(), job.id, job.next_at);
      const run = db.prepare('SELECT * FROM scheduled_runs WHERE job_id=? AND due_at=?').get(job.id, job.next_at);
      const spent = accrued(run, time);
      const remaining = spec.budgetSeconds * 1000 - spent;
      if (remaining <= 0 || run.attempts >= maxAttempts) {
        finish(run, spec, 'failed', remaining <= 0 ? 'Execution budget exhausted.' : 'Retry limit reached.', time);
        return null;
      }
      const token = randomUUID();
      db.prepare(`UPDATE scheduled_runs SET status='running',token=?,started_at=?,lease_until=?,
        attempts=attempts+1,spent_ms=?,detail='' WHERE id=?`)
        .run(token, time, time + Math.min(leaseMs, remaining), spent, run.id);
      return { run, spec, token, deadline: time + remaining, remaining };
    });
  }

  function settle(work, result, error, timedOut, closing) {
    transaction(db, () => {
      const run = db.prepare("SELECT * FROM scheduled_runs WHERE id=? AND token=? AND status='running'")
        .get(work.run.id, work.token);
      if (!run) return; // Another transaction paused, cancelled or reclaimed it.
      const time = now();
      if (timedOut || time >= work.deadline) {
        finish(run, work.spec, 'failed', 'Execution budget exhausted.', time);
        return;
      }
      if (error || closing) {
        const permanent = error?.status >= 400 && error.status < 500 && error.status !== 429;
        if (permanent || run.attempts >= maxAttempts) {
          finish(run, work.spec, 'failed', permanent ? 'Read or condition rejected.' : 'Read failed after retries.', time);
        } else {
          const wait = closing ? 0 : 1000 * run.attempts;
          db.prepare(`UPDATE scheduled_runs SET status='retrying',spent_ms=?,retry_at=?,
            token=NULL,lease_until=NULL,detail=? WHERE id=?`)
            .run(run.spent_ms + Math.max(0, time - run.started_at), time + wait,
              closing ? 'Worker stopped. Ready to resume.' : 'Read failed. Waiting to retry.', run.id);
        }
        return;
      }
      if (result.notify) {
        delivery.deliver({ runId: run.id, jobId: run.job_id, goal: work.spec.goal, body: result.body, createdAt: time });
      }
      finish(run, work.spec, result.notify ? 'notified' : 'quiet',
        result.notify ? 'Delivered to inbox.' : 'Notification condition did not match.', time);
    });
  }

  async function execute(work) {
    const controller = new AbortController();
    active = { jobId: work.run.job_id, controller, closing: false };
    const { spec } = work;
    let timedOut = false, result, failure;
    const budgetTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, work.remaining);
    const heartbeat = setInterval(() => {
      try {
        const renewed = db.prepare("UPDATE scheduled_runs SET lease_until=? WHERE id=? AND token=? AND status='running'")
          .run(Math.min(now() + leaseMs, work.deadline), work.run.id, work.token);
        if (!renewed.changes) controller.abort();
      } catch {
        controller.abort();
      }
    }, Math.max(1, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      let data;
      if (spec.tool) {
        const profile = getProfile(spec.profileId);
        if (spec.readContext === undefined) {
          // Existing jobs retain access to in-process reads. Legacy arguments
          // lack provenance, so cannot be passed to a networked tool.
          const tool = capabilities.validate(profile, spec.tool.name, spec.tool.args, {allowedTools:spec.allowedTools, readOnly:true});
          if (profile.provider === 'chatgpt-plan' || tool?.network !== false) throw invalid('Review the workspace for this legacy read.', 409);
        } else if (memoryScope(profile) !== spec.readContext) {
          throw invalid('The workspace approved for this read changed.', 409);
        }
        const stopped = new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('Read interrupted.')), { once: true });
        });
        const read = capabilities.dispatch(profile, spec.tool.name, spec.tool.args, {
          allowedTools: spec.allowedTools, readOnly: true, ownerInput:true, signal: controller.signal,
        });
        data = await Promise.race([stopped, read]);
      }
      const notify = spec.condition === 'always' || (spec.condition === 'nonempty' && nonempty(data));
      const body = spec.tool ? (JSON.stringify(data) ?? '').slice(0, 4000) : spec.goal;
      result = { notify, body };
    } catch (err) {
      failure = err instanceof Error ? err : new Error('Read failed.');
    } finally {
      clearTimeout(budgetTimer);
      clearInterval(heartbeat);
      const closing = active.closing;
      active = null;
      settle(work, result, failure, timedOut, closing);
    }
  }

  function tick() {
    if (inFlight) return inFlight;
    const work = claim();
    if (!work) return Promise.resolve();
    inFlight = execute(work).finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (polling) return;
    polling = true;
    async function poll() {
      try { await tick(); } catch (err) { onError(err); }
      if (polling) timer = setTimeout(poll, pollMs);
    }
    timer = setTimeout(poll, 0);
  }

  async function stop() {
    polling = false;
    clearTimeout(timer);
    if (active) {
      active.closing = true;
      active.controller.abort();
    }
    await inFlight;
  }

  function list() {
    return db.prepare('SELECT * FROM scheduled_jobs ORDER BY created_at DESC,rowid DESC').all().map(jobView);
  }

  function runs() {
    return db.prepare(`SELECT r.*,j.spec FROM scheduled_runs r JOIN scheduled_jobs j ON j.id=r.job_id
      ORDER BY r.due_at DESC,r.rowid DESC`).all().map(row => ({
      id: row.id, jobId: row.job_id, goal: JSON.parse(row.spec).goal, scheduledAt: iso(row.due_at),
      status: row.status, attempts: row.attempts, detail: row.detail, finishedAt: iso(row.finished_at),
    }));
  }

  function notifications() {
    return delivery.list();
  }
  return { create, change, list, runs, notifications, tick, start, stop };
}
