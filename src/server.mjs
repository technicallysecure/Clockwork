import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStore } from './store.mjs';
import { createRuntime } from './runtime.mjs';
import { createHttpServer } from './http.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = process.env;
const password = env.CLOCKWORK_PASSWORD_FILE
  ? readFileSync(env.CLOCKWORK_PASSWORD_FILE, 'utf8').replace(/^\uFEFF/, '').trimEnd()
  : env.CLOCKWORK_PASSWORD;
const db = openStore(resolve(env.CLOCKWORK_DB ?? 'data/clockwork.sqlite'));
const runtime = await createRuntime({db, root, env});
const server = createHttpServer({runtime, root, password, secureCookie: env.CLOCKWORK_SECURE_COOKIE === 'true'});
const host = env.CLOCKWORK_BIND ?? '127.0.0.1';
const port = Number(env.CLOCKWORK_PORT ?? 8787);
server.listen(port, host, () => {
  console.log(`Clockwork listening on ${host}:${server.address().port} (${runtime.active().provider})`);
  runtime.scheduler.start();
});
async function shutDown() {
  const drained = new Promise(resolve => server.close(resolve));
  await runtime.scheduler.stop();
  await drained;
  db.close();
}
process.once('SIGTERM', shutDown);
process.once('SIGINT', shutDown);
