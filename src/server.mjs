import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createPlanCallback } from './plan-callback.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = process.env;
const role = env.CLOCKWORK_ROLE ?? 'standalone';
const host = env.CLOCKWORK_BIND ?? '127.0.0.1';
const port = Number(env.CLOCKWORK_PORT ?? 8787);
const secureCookie = env.CLOCKWORK_SECURE_COOKIE === 'true';
const slotPattern = /^[a-z][a-z0-9-]{0,31}$/;

function readSecret(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trimEnd();
}

function ownerPassword() {
  return env.CLOCKWORK_PASSWORD_FILE ? readSecret(env.CLOCKWORK_PASSWORD_FILE) : env.CLOCKWORK_PASSWORD;
}

function workerToken(file) {
  if (!file) throw new Error('Configure a dedicated worker token file.');
  const token = readSecret(file);
  if (!/^[A-Za-z0-9_+=/-]{32,256}$/.test(token)) throw new Error('Invalid worker token. Run scripts/setup.ps1.');
  return token;
}

function configuredAgents() {
  const ids = (env.CLOCKWORK_AGENT_SLOTS ?? '').split(',').map(value => value.trim());
  if (ids.some(id => !slotPattern.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Configure a comma-separated list of distinct agent slots.');
  }
  const agents = ids.map(id => ({
    id,
    url: `http://worker-${id}:8787`,
    token: workerToken(`/run/secrets/worker_${id}`),
  }));
  if (new Set(agents.map(a => a.token)).size !== agents.length) throw new Error('Each agent needs a distinct token.');
  return agents;
}

let db, runtime, server, planAuth;
const callbackPort = env.CLOCKWORK_PLAN_CALLBACK_PORT;
const enablePlan = env.CLOCKWORK_LOCAL_ONLY === 'false' && Boolean(callbackPort);
if (enablePlan && (!/^\d{1,5}$/.test(callbackPort) || Number(callbackPort) < 1 || Number(callbackPort) > 65535)) {
  throw Error('Choose a valid ChatGPT loopback callback port.');
}
const redirectUri = enablePlan && `http://127.0.0.1:${Number(callbackPort)}/auth/callback`;
const planCallback = enablePlan && role !== 'worker' ? createPlanCallback(redirectUri) : undefined;
if (role === 'gateway') {
  const { createGatewayServer } = await import('./gateway.mjs');
  server = await createGatewayServer({root, password: ownerPassword(), secureCookie, agents: configuredAgents(), planCallback});
} else if (role === 'worker' || role === 'standalone') {
  const { openStore } = await import('./store.mjs');
  const { createRuntime } = await import('./runtime.mjs');
  const { createHttpServer } = await import('./http.mjs');
  const { bindWorkspace } = await import('./worker-volume.mjs');
  const worker = role === 'worker';
  if (worker && !slotPattern.test(env.CLOCKWORK_AGENT_ID ?? '')) throw new Error('Worker requires an agent ID.');
  const auth = worker ? {workerToken: workerToken(env.CLOCKWORK_WORKER_TOKEN_FILE)} : {password: ownerPassword(), secureCookie};
  const databasePath = resolve(env.CLOCKWORK_DB ?? 'data/clockwork.sqlite');
  const workspaceDir = resolve(env.CLOCKWORK_WORKSPACE ?? resolve(dirname(databasePath), 'workspace'));
  db = openStore(databasePath);
  if (enablePlan) {
    const { createPlanAuth } = await import('./plan-auth.mjs');
    const agentId = env.CLOCKWORK_AGENT_ID ?? 'personal';
    const directory = env.CLOCKWORK_PLAN_VAULT ?? resolve(homedir(), '.clockwork', 'plan', agentId);
    planAuth = createPlanAuth({directory, agentId, redirectUri});
  }
  runtime = await createRuntime({db, root, env, workspaceDir, planAuth});
  bindWorkspace(workspaceDir, runtime.agentInfo().id);
  server = createHttpServer({runtime, root, workspaceDir, planCallback, ...auth});
} else {
  throw new Error('Unknown CLOCKWORK_ROLE. Choose gateway, worker or standalone.');
}

if (planCallback) {
  // The container's dedicated callback socket is published solely to Windows loopback.
  // Standalone Node always binds the socket directly to loopback.
  await new Promise((done, fail) => planCallback.server.once('error', fail)
    .listen(Number(callbackPort), role === 'gateway' ? host : '127.0.0.1', done));
}
server.listen(port, host, () => {
  console.log(`Clockwork listening on ${host}:${server.address().port} (${role})`);
  runtime?.scheduler.start();
});
async function shutDown() {
  planCallback?.server.close();
  const drained = new Promise(resolve => server.close(resolve));
  await runtime?.scheduler.stop();
  await drained;
  planAuth?.close();
  db?.close();
}
process.once('SIGTERM', shutDown);
process.once('SIGINT', shutDown);
