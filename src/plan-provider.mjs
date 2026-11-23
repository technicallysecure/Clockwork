import { createHash } from 'node:crypto';

// The OAuth and API-key transports intentionally do not share credential lookup.
const origin = 'https://api.openai.com/v1';
const invalid = (message, status = 502) => Object.assign(new Error(message), {status});
const invalidStream = () => invalid('ChatGPT returned an invalid response stream.');
const invalidCall = () => invalid('ChatGPT requested an invalid or unavailable tool. Check the model’s tool settings.');

const codeMessages = new Map([
  ['subscription_sharing_user_not_eligible', 'This account or workspace is ineligible for ChatGPT plan usage.'],
  ['subscription_sharing_usage_limit_exceeded', 'The ChatGPT plan usage limit was reached. Review Manage usage in settings.'],
  ['subscription_sharing_usage_unavailable', 'ChatGPT plan usage is temporarily unavailable. Try again later.'],
  ['subscription_sharing_user_unavailable', 'The selected ChatGPT account or workspace is temporarily unavailable.'],
  ['subscription_sharing_unsupported_capability', 'This model or ChatGPT plan route does not support a requested capability. Check the model and tool settings.'],
  ['subscription_sharing_route_not_supported', 'This endpoint is unavailable for ChatGPT plan usage.'],
  ['subscription_sharing_invalid_user', 'ChatGPT could not validate this account. Check the connection in settings.'],
  ['chatpass_v2_scope_not_authorized', 'The selected ChatGPT grant does not permit this request. Review the plan permission in settings.'],
  ['chatpass_v2_invalid_authorization_context', 'ChatGPT rejected the selected plan authorization. Check the connection in settings.']
]);

function planError(response, problem) {
  const status = response.status;
  const code = problem?.code;
  const messages = {
    401: 'ChatGPT rejected the account credential. Check plan permission and reconnect in settings.',
    403: 'ChatGPT denied access for the selected account or workspace. Review plan permission and workspace policy.',
    429: 'ChatGPT rate-limited this request. Check Manage usage in settings and try again later.',
    503: 'The ChatGPT plan route is temporarily unavailable. Try again later.'
  };
  const invalidToken = code === 'invalid_token' && (status === 401 || status === 200);
  const error = invalid(invalidToken ? 'ChatGPT rejected the selected plan credential. Reconnect this account in settings.' :
    codeMessages.get(code) ?? messages[status] ??
    (response.ok ? 'The ChatGPT response failed during streaming.' : 'The ChatGPT plan request failed (HTTP ' + status + ').'));
  // Admission bodies may echo the request. Keep them out of persistent chat errors.
  error.providerStatus = status;
  error.providerCode = typeof code === 'string' ? code : undefined;
  error.providerParam = typeof problem?.param === 'string' ? problem.param : undefined;
  error.requestId = response.headers.get('x-request-id');
  error.invalidToken = invalidToken;
  return error;
}

// Match the error parameter of a Bearer challenge. Quoted descriptions and
// challenges for other authentication schemes cannot establish invalidation.
function invalidBearer(header) {
  const bearer = /^\s*Bearer\s+(.+)$/i.exec(header ?? '');
  if (!bearer) return false;
  const parameter = /(?:^|,)\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^",\s]+))\s*(?=,|$)/gy;
  for (const [, name, quoted, token] of bearer[1].matchAll(parameter)) {
    if (name.toLowerCase() === 'error') return (quoted ?? token) === 'invalid_token';
  }
  return false;
}

async function* bytes(response, limit) {
  if (!response.body) throw invalid('ChatGPT returned an empty response.');
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.byteLength;
    if (count > limit) throw invalid('The ChatGPT response exceeded the size limit.');
    yield chunk;
  }
}

async function readJson(response, limit) {
  const chunks = [];
  for await (const chunk of bytes(response, limit)) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// SSE events can span multiple data lines, TCP chunks and UTF-8 code points.
async function* events(response) {
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let fragment = '';
  let previousCR = false;
  let data = [];
  for await (const chunk of bytes(response, 16 * 1024 * 1024)) {
    let decoded = decoder.decode(chunk, {stream:true});
    if (!decoded) continue;
    if (previousCR && decoded.startsWith('\n')) decoded = decoded.slice(1);
    previousCR = decoded.endsWith('\r');
    const lines = decoded.replace(/\r\n?/g, '\n').split('\n');
    lines[0] = fragment + lines[0];
    fragment = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      } else if (!line && data.length) {
        const frame = data.join('\n');
        data = [];
        if (frame === '[DONE]') return;
        let event;
        try { event = JSON.parse(frame); } catch { throw invalidStream(); }
        if (typeof event?.type !== 'string') throw invalidStream();
        yield event;
      }
    }
  }
  decoder.decode();
}

async function readCompletion(response) {
  if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw invalid('The ChatGPT plan route did not return an event stream.');
  }
  // Only the completed response authorizes a tool dispatch or supplies a final
  // answer. Earlier items and text deltas may belong to an abandoned generation.
  for await (const event of events(response)) {
    switch (event.type) {
      case 'response.incomplete':
        throw invalid('ChatGPT marked this response incomplete. Try a shorter request.');
      case 'response.failed':
        throw planError(response, event.response?.error);
      case 'error':
        throw planError(response, event.error ?? event);
      case 'response.completed': {
        if (event.response?.status !== 'completed') throw invalidStream();
        const output = event.response?.output;
        if (!Array.isArray(output)) throw invalidStream();
        return output;
      }
    }
  }
  throw invalid('The ChatGPT stream ended before response.completed. The reply was interrupted.');
}

function unpack(items, toolNames) {
  const calls = [];
  const ids = new Set();
  const text = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') throw invalidStream();
    switch (item.type) {
      case 'message':
        if (item.role !== 'assistant' || !Array.isArray(item.content) ||
            (item.status != null && item.status !== 'completed') ||
            (item.phase != null && !['commentary','final_answer'].includes(item.phase))) throw invalidStream();
        for (const part of item.content) {
          const value = part?.type === 'output_text' ? part.text : part?.type === 'refusal' ? part.refusal : null;
          if (typeof value !== 'string') throw invalidStream();
          if (item.phase !== 'commentary') text.push(value);
        }
        break;
      case 'reasoning':
        break;
      case 'function_call': {
        if (item.namespace !== 'clockwork' || !toolNames.has(item.name) || calls.length >= 6 ||
            (item.async != null && item.async !== false) || (item.caller != null && item.caller.type !== 'direct') ||
            typeof item.call_id !== 'string' || !/^[\w.-]{1,128}$/.test(item.call_id) || ids.has(item.call_id) ||
            typeof item.arguments !== 'string' || Buffer.byteLength(item.arguments) > 16384 ||
            (item.status != null && item.status !== 'completed')) throw invalidCall();
        let args;
        try { args = JSON.parse(item.arguments); } catch { throw invalidCall(); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalidCall();
        ids.add(item.call_id);
        calls.push({id:item.call_id, name:item.name, arguments:args});
        break;
      }
      default:
        throw invalid('ChatGPT returned an output type this application does not support.');
    }
  }
  const answer = text.join('');
  if (!answer.trim() && !calls.length) throw invalid('ChatGPT completed without usable text or tool calls.');
  return {text:answer, calls};
}

function initialInput(messages) {
  let instructions;
  const input = [];
  for (const {role, content} of messages) {
    if (typeof content !== 'string') throw invalid('Invalid ChatGPT input.');
    if (role === 'system' && instructions === undefined && !input.length) instructions = content;
    else if (role === 'user' || role === 'assistant') input.push({role, content});
    else throw invalid('Invalid ChatGPT input role.');
  }
  return {instructions, input};
}

function toolResults(messages, ids) {
  const supplied = messages.slice(-ids.length);
  if (supplied.length !== ids.length) throw invalid('Missing application tool results.');
  return supplied.map((msg, index) => {
    if (msg.role !== 'tool' || msg.tool_call_id !== ids[index] || typeof msg.content !== 'string') {
      throw invalid('The application tool results do not match this turn.');
    }
    return {type:'function_call_output', call_id:ids[index], output:msg.content};
  });
}

export function createPlanProvider({auth, fetchImpl = fetch, timeoutMs = 45000, localOnly = false}) {
  // Handles are single-use and live only inside this worker and turn. Neither
  // reasoning items nor credentials are serialized into application history.
  const continuations = new WeakMap();
  // Admission of a bearer and renewal of its grant are separate operations.
  // Remember a rejected bearer in memory until rotation, retaining the grant.
  const issues = new Map();
  const fingerprint = token => createHash('sha256').update(token).digest('hex');

  function deadline(signal) {
    if (localOnly) throw invalid('Hosted inference is disabled in local-only mode.', 403);
    const timer = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timer]) : timer;
  }

  async function request(path, session, signal, read, payload) {
    const issue = issues.get(session.profileId);
    if (issue?.rejected) {
      if (issue.rejected === fingerprint(session.accessToken)) throw invalid(issue.message);
      issues.delete(session.profileId);
    }
    const headers = {Authorization:'Bearer ' + session.accessToken, Accept:payload ? 'text/event-stream' : 'application/json'};
    if (payload) headers['Content-Type'] = 'application/json';
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(origin + path, {
        method:payload ? 'POST' : 'GET', headers, signal, redirect:'error', body:payload ? JSON.stringify(payload) : undefined
      });
      if (!response.ok) {
        let body;
        try { body = await readJson(response, 65536); } catch { /* admission errors can be plain text */ }
        let problem = body?.error;
        if (response.status === 401 && (problem === 'invalid_token' || invalidBearer(response.headers.get('www-authenticate')))) {
          problem = {code:'invalid_token'};
        }
        const error = planError(response, problem);
        error.bodyShape = body?.error ? 'error' : typeof body?.detail === 'string' ? 'detail' : 'other';
        throw error;
      }
      const result = await read(response);
      if (path === '/responses') issues.delete(session.profileId);
      return result;
    } catch (error) {
      if (error.invalidToken === true) {
        // Compare both registration and rejected credential so a concurrent
        // renewal survives an older response from the API.
        await auth.invalidate(session);
      }
      if (signal.aborted) throw invalid('The ChatGPT plan request timed out or was cancelled.', 504);
      if (error.providerStatus) {
        const access = error.providerStatus === 401 || ['chatpass_v2_scope_not_authorized',
          'chatpass_v2_invalid_authorization_context', 'subscription_sharing_invalid_user'].includes(error.providerCode);
        issues.set(session.profileId, {kind:access ? 'access' : 'request', message:error.message,
          rejected:access ? fingerprint(session.accessToken) : null});
      }
      if (error.status) throw error;
      throw invalid('The ChatGPT plan request failed or its response was interrupted.');
    }
  }

  async function catalog(session, signal) {
    const data = await request('/models', session, signal, res => readJson(res, 4 * 1024 * 1024));
    if (!Array.isArray(data?.models)) throw invalid('ChatGPT returned an invalid plan model catalog.');
    return data.models.filter(m => m?.visibility === 'list' && typeof m.slug === 'string' && m.slug &&
      typeof m.display_name === 'string' && m.display_name).map(({slug, display_name}) => ({slug, display_name}));
  }

  return {
    lastIssue(profileId) {
      const issue = issues.get(profileId);
      return issue ? {kind:issue.kind, message:issue.message} : null;
    },
    clearIssue(profileId) { issues.delete(profileId); },
    async listModels({signal, profileId} = {}) {
      signal = deadline(signal);
      return catalog(await auth.credential({signal, profileId}), signal);
    },
    async complete(profile, messages, tools = [], {signal, continuation} = {}) {
      signal = deadline(signal);
      if (profile.provider !== 'chatgpt-plan') throw invalid('Select the ChatGPT plan provider for this request.');
      const previous = continuations.get(continuation);
      if (continuation !== undefined && (!previous || previous.model !== profile.model ||
          (profile.planAccountId && previous.account !== profile.planAccountId))) {
        throw invalid('This ChatGPT tool turn belongs to another model or account, or has already finished.');
      }
      if (previous) continuations.delete(continuation);
      const expected = previous?.account ?? profile.planAccountId;
      const session = await auth.credential({signal, profileId:expected});
      if (!session?.accessToken || !session.profileId || profile.planAccountId === null || (expected && session.profileId !== expected)) {
        throw invalid('The selected ChatGPT account changed. Start a new turn.');
      }
      let context;
      if (previous) {
        context = {instructions:previous.instructions, input:[...previous.input, ...previous.items, ...toolResults(messages, previous.ids)]};
      } else {
        const models = await catalog(session, signal);
        if (!models.some(m => m.slug === profile.model)) throw invalid('Select an eligible model from this ChatGPT account’s model list.', 400);
        context = initialInput(messages);
      }
      const enabled = !previous && profile.nativeTools === true ? tools : [];
      const payload = {model:profile.model, ...context, store:false, stream:true};
      if (enabled.length) {
        payload.tools = [{type:'namespace', name:'clockwork', description:'Application tools available to this agent.',
          tools:enabled.map(({name, description, inputSchema}) => ({
            type:'function', name, description, parameters:inputSchema, strict:false
          }))}];
      }
      const items = await request('/responses', session, signal, readCompletion, payload);
      const reply = unpack(items, new Set(enabled.map(tool => tool.name)));
      if (reply.calls.length) {
        reply.continuation = Object.freeze({});
        continuations.set(reply.continuation, {...context, items, ids:reply.calls.map(c => c.id),
          account:session.profileId, model:profile.model});
      }
      return reply;
    }
  };
}
