import { createHash } from 'node:crypto';
import { badRequest, requiredText, transaction } from './store.mjs';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createAssignmentRunner({db, checkTarget, chat}) {
  db.exec(`CREATE TABLE IF NOT EXISTS assignment_receipts (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
    errorStatus INTEGER, errorMessage TEXT
  )`);
  const read = db.prepare('SELECT * FROM assignment_receipts WHERE id=?');
  const claim = db.prepare("INSERT INTO assignment_receipts(id,fingerprint,status) VALUES(?,?,'running')");
  const finish = db.prepare("UPDATE assignment_receipts SET status=?,errorStatus=?,errorMessage=? WHERE id=? AND status='running'");
  const running = new Map();

  function record(id, status, errorStatus = null, errorMessage = null) {
    try {
      if (finish.run(status, errorStatus, errorMessage, id).changes !== 1) throw new Error();
    } catch {
      throw badRequest('Could not record the assignment outcome. Check this agent’s conversation.', 503);
    }
  }

  async function execute(id, text) {
    try {
      await chat(text);
    } catch (error) {
      // chat exposes sanitized application and provider errors. Internal storage
      // or runtime errors must not be copied into the receipt or response.
      const expected = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
      const status = expected ? error.status : 500;
      const message = expected ? error.message : 'Could not complete the assignment. Check this agent’s conversation.';
      record(id, 'failed', status, message);
      throw badRequest(message, status);
    }
    record(id, 'succeeded');
    return {ok:true};
  }

  return async function assign(input) {
    if (!input || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw badRequest('Assignment request ID must be a UUID.');
    const {text, profileId, revision} = input;
    requiredText(text, 'Assignment', 8000);
    if (typeof profileId !== 'string' || !Number.isSafeInteger(revision) || revision < 0) {
      throw badRequest('Supply the selected profile and current settings revision.');
    }
    const id = input.requestId.toLowerCase();
    const fingerprint = createHash('sha256').update(JSON.stringify([text,profileId,revision])).digest('hex');
    const prior = transaction(db, () => {
      const receipt = read.get(id);
      if (receipt) return receipt;
      checkTarget(profileId, revision);
      claim.run(id, fingerprint);
    });
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw badRequest('This request ID belongs to a different assignment.', 409);
      if (prior.status === 'succeeded') return {ok:true};
      if (prior.status === 'failed') throw badRequest(prior.errorMessage, prior.errorStatus);
      if (running.has(id)) return running.get(id);
      // The durable claim can outlive its process. Neither model requests nor
      // local memory commands can be safely retried across that boundary.
      throw badRequest('An earlier assignment has an unconfirmed outcome. Check this agent’s conversation.', 409);
    }
    const work = execute(id, text);
    running.set(id, work);
    try { return await work; }
    finally { running.delete(id); }
  };
}
