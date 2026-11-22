import { randomUUID } from 'node:crypto';

export function createInbox(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_notifications (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES scheduled_runs(id),
    body TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  const insert = db.prepare(`INSERT INTO inbox_notifications(id,run_id,body,created_at) VALUES (?,?,?,?)
    ON CONFLICT(run_id) DO NOTHING`);
  const recent = db.prepare(`SELECT n.*,r.job_id,j.spec FROM inbox_notifications n
    JOIN scheduled_runs r ON r.id=n.run_id JOIN scheduled_jobs j ON j.id=r.job_id
    ORDER BY n.created_at DESC,n.rowid DESC`);

  return {
    deliver({ runId, body, createdAt }) {
      if (!db.isTransaction) throw new Error('Inbox delivery requires an open run transaction.');
      insert.run(randomUUID(), runId, body, createdAt);
    },
    list() {
      return recent.all().map(row => ({
        id: row.id, runId: row.run_id, jobId: row.job_id, goal: JSON.parse(row.spec).goal,
        body: row.body, createdAt: new Date(row.created_at).toISOString(),
      }));
    },
  };
}
