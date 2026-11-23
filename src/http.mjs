import { badRequest } from './store.mjs';
import { createWorkspace } from './workspace.mjs';
import { createWebServer } from './web-server.mjs';
import { fleetRouter } from './gateway.mjs';
import { memoryScope } from './context.mjs';

// The worker owns this API and all its state. Its routes never select another agent.
function agentRoutes(runtime, workspace) {
  return async ({method, path, query, body, profile, revision, agentId}) => {
    const info = runtime.agentInfo();
    if (agentId !== info.id) throw badRequest('Worker identity does not match the selected agent.', 409);
    if (method === 'GET' && path === '/info') return info;
    if (method === 'POST' && path === '/initialize') return runtime.initializeAgent(body);
    if (!info.initialized) throw badRequest('Activate this agent before assigning work.', 409);
    if (method === 'POST' && path === '/assignment') {
      if (typeof revision !== 'string' || !/^(0|[1-9]\d*)$/.test(revision)) throw badRequest('Invalid assignment settings revision.');
      return runtime.assign({requestId:body.requestId, text:body.text, profileId:profile, revision:Number(revision)});
    }
    if (method === 'GET' && path === '/state') return runtime.state();
    if (method === 'GET' && path === '/settings') return runtime.settings();
    if (method === 'POST' && path === '/plan/callback') return runtime.planRequest('callback', body);
    const current = runtime.active();
    const scope = memoryScope(current);
    if (method === 'GET' && path === '/history') {
      const params = new URLSearchParams(query);
      if (params.get('profile') !== current.id) throw badRequest('Profile changed. Refresh the conversation.', 409);
      if (revision !== undefined && revision !== String(runtime.settingsRevision())) throw badRequest('Workspace changed. Refresh the conversation.', 409);
      const before = Number(params.get('before'));
      if (!Number.isSafeInteger(before) || before <= 0) throw badRequest('Invalid message cursor.');
      const messages = runtime.notebook.messages(scope, 101, before);
      return {messages:messages.slice(-100), hasEarlier:messages.length > 100};
    }
    if (method !== 'GET') {
      if (profile !== current.id || revision !== String(runtime.settingsRevision())) {
        throw badRequest('The agent or its model settings changed. Refresh and review the provider before continuing.', 409);
      }
    }
    const plan = /^\/plan\/(status|models|start|select|renew|signout)$/.exec(path);
    if (plan && method === (plan[1] === 'status' ? 'GET' : 'POST')) return runtime.planRequest(plan[1], body);
    const file = /^\/workspace\/([A-Za-z0-9_.-]+)$/.exec(path);
    if (path === '/workspace' || file) {
      if (!workspace) throw badRequest('Workspace storage is unavailable for this worker.', 503);
      if (method === 'GET' && (profile !== undefined || revision !== undefined) &&
          (profile !== current.id || revision !== String(runtime.settingsRevision()))) {
        throw badRequest('Workspace changed. Refresh the file list.', 409);
      }
      const files = workspace.forProfile(current);
      if (method === 'GET' && !file) return files.list();
      if (method === 'GET' && file) return files.read(file[1]);
      if (method === 'PUT' && file) return files.write(file[1], body.text, body.version);
    }
    let match;
    if (method === 'PUT' && path === '/settings') {
      return runtime.updateSettings(body);
    } else if (method === 'POST' && path === '/profile') {
      runtime.selectProfile(body.id);
    } else if (method === 'POST' && path === '/chat') {
      await runtime.chat(body.text);
    } else if (method === 'POST' && path === '/preferences') {
      runtime.notebook.add(scope, 'preference', body.text);
    } else if (method === 'POST' && path === '/commitments') {
      runtime.notebook.add(scope, 'commitment', body.text);
    } else if ((match = /^\/(preferences|commitments)\/(\d+)$/.exec(path)) && method === 'PATCH') {
      runtime.notebook.update(scope, match[1] === 'preferences' ? 'preference' : 'commitment', match[2], body);
    } else if ((match = /^\/preferences\/(\d+)$/.exec(path)) && method === 'DELETE') {
      runtime.notebook.removePreference(scope, match[1]);
    } else if (method === 'POST' && path === '/jobs') {
      if (body.profileId !== current.id) throw badRequest('Choose the active profile for this follow-up.');
      runtime.scheduler.create(body);
    } else if ((match = /^\/jobs\/([\w-]+)\/(pause|resume|cancel)$/.exec(path)) && method === 'POST') {
      runtime.scheduler.change(match[1], match[2]);
    } else if ((match = /^\/approvals\/([\w-]+)\/(approve|reject)$/.exec(path)) && method === 'POST') {
      if (Object.keys(body).length) throw badRequest('An approval decision accepts only the stored action.');
      await runtime.capabilities.decide(match[1], match[2] === 'approve' ? 'approve' : 'deny');
    } else {
      throw badRequest('Route not found.', 404);
    }
    return {ok:true};
  };
}

export function createHttpServer({runtime, root, password, secureCookie, workerToken, workspaceDir, planCallback}) {
  const workspace = runtime.workspace ?? (workspaceDir && createWorkspace(workspaceDir));
  const local = {id:runtime.agentInfo().id, call:agentRoutes(runtime, workspace)};
  const route = workerToken === undefined ? fleetRouter([local], planCallback) : local.call;
  return createWebServer({root, password, secureCookie, workerToken, route});
}
