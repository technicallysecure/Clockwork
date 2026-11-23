import { badRequest, requiredText } from './store.mjs';
import { createWebServer } from './web-server.mjs';

const agentId = /^[a-z][a-z0-9-]{0,62}$/;
const workerRoute = /^\/(?:state|history|settings|profile|chat|workspace(?:\/[A-Za-z0-9_.-]+)?|preferences(?:\/\d+)?|commitments(?:\/\d+)?|jobs(?:\/[\w-]+\/(?:pause|resume|cancel))?|approvals\/[\w-]+\/(?:approve|reject))$/;
const legacyRoute = /^\/(?:state|history|profile|chat|preferences|commitments|jobs|approvals)(?:\/|$)/;

function remoteClient({id, url, token}) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/' || typeof token !== 'string' || token.length < 32) {
    throw Error('Invalid worker endpoint or internal credential.');
  }
  return {
    id,
    async call({method, path, body, profile, revision, query}) {
      // Only the deployment supplies the origin and token. The gateway builds a
      // new request so browser cookies/credentials never reach a worker.
      const destination = new URL(endpoint);
      destination.pathname = '/api' + path;
      if (path === '/history') destination.search = query ?? '';
      const headers = {authorization:'Bearer ' + token, 'x-clockwork-agent':id};
      if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        headers['x-clockwork-request'] = '1';
        if (profile !== undefined) headers['x-clockwork-profile'] = profile;
        if (revision !== undefined) headers['x-clockwork-revision'] = revision;
      }
      let response, data;
      try {
        response = await fetch(destination, {
          method, headers, body:method === 'GET' ? undefined : JSON.stringify(body),
          redirect:'error', signal:AbortSignal.timeout(path === '/info' ? 2000 : 70000),
        });
        data = await response.json();
      } catch {
        throw badRequest('This worker is unreachable. Check its state before retrying an assignment.', 503);
      }
      if (response.status === 401) throw badRequest('The gateway could not authenticate this worker.', 502);
      if (!response.ok) throw badRequest(typeof data?.error === 'string' ? data.error : 'Worker request failed.', response.status);
      return data;
    },
  };
}

export function fleetRouter(clients) {
  const directory = new Map();
  for (const client of clients) {
    if (!agentId.test(client.id) || directory.has(client.id)) throw Error('Invalid or duplicate worker ID.');
    directory.set(client.id, client);
  }
  if (!clients.length) throw Error('Configure at least one worker.');
  const defaultAgent = directory.has('personal') ? 'personal' : clients[0].id;
  function clientFor(id) {
    const client = directory.get(id);
    if (!client) throw badRequest('Unknown agent.', 404);
    return client;
  }
  function call(id, request) {
    return clientFor(id).call({...request, agentId:id});
  }
  async function describe({id}) {
    try {
      const info = await call(id, {method:'GET', path:'/info'});
      if (info.id !== id) throw Error('Worker identity mismatch.');
      return {id, name:info.name, goal:info.goal, initialized:info.initialized, available:true};
    } catch {
      return {id, name:id, goal:'', initialized:false, available:false};
    }
  }
  async function dispatch(body) {
    const text = requiredText(body.text, 'Assignment', 8000);
    const {targets, requestId} = body;
    if (typeof requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)) {
      throw badRequest('Include a UUID for this assignment.');
    }
    if (!Array.isArray(targets) || !targets.length || targets.length > directory.size) throw badRequest('Choose one or more available agents.');
    const selected = new Set();
    for (const target of targets) {
      if (!target || !directory.has(target.id) || selected.has(target.id) ||
          typeof target.profileId !== 'string' || !Number.isSafeInteger(target.revision) || target.revision < 0) {
        throw badRequest('Each selected agent needs its current profile and settings revision.');
      }
      selected.add(target.id);
    }
    const results = await Promise.all(targets.map(async ({id,profileId,revision}) => {
      try {
        await call(id, {method:'POST', path:'/assignment', profile:profileId, revision:String(revision), body:{requestId,text}});
        return {id, ok:true};
      } catch (err) {
        return {id, ok:false, error:err.status ? err.message : 'Worker assignment failed.'};
      }
    }));
    return {results};
  }
  return async request => {
    const {method, path, body} = request;
    if (path === '/agents' && method === 'GET') return {agents:await Promise.all(clients.map(describe)), defaultAgent};
    if (path === '/agents' && method === 'POST') {
      const agent = await call(body.id, {method:'POST', path:'/initialize', body:{name:body.name, goal:body.goal}});
      return {agent};
    }
    if (path === '/dispatch' && method === 'POST') return dispatch(body);
    const scoped = /^\/agents\/([a-z][a-z0-9-]*)\/(.+)$/.exec(path);
    if (scoped && workerRoute.test('/' + scoped[2])) return call(scoped[1], {...request, path:'/' + scoped[2]});
    // Earlier single-agent clients refer exclusively to the original agent.
    // An unversioned mutation can only reach its original settings revision.
    if (directory.has('personal') && legacyRoute.test(path) && workerRoute.test(path)) {
      return call('personal', {...request, revision:request.revision ?? '0'});
    }
    throw badRequest('Route not found.', 404);
  };
}

export function createGatewayServer({root, password, secureCookie, agents}) {
  return createWebServer({root, password, secureCookie, route:fleetRouter(agents.map(remoteClient))});
}
