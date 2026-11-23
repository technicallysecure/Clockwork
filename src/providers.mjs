import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const MAX_RESPONSE = 1024 * 1024;
const failure = (message, status = 502) => Object.assign(new Error(message), {status});

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return net.isIPv6(address) && (address === '::1' || /^f[cd]/i.test(address));
}

export function providerEndpoint(profile, localOnly) {
  let url;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    throw failure('Invalid inference base URL.');
  }
  if (url.username || url.password || url.search || url.hash) throw failure('Invalid inference base URL.');
  if (profile.provider === 'chatgpt-plan') {
    if (localOnly) throw failure('Hosted inference is disabled in local-only mode.', 403);
    if (url.href !== 'https://api.openai.com/v1') throw failure('ChatGPT plan requests require the public Responses API.');
    return new URL('https://api.openai.com/v1/responses');
  }
  if (profile.provider === 'openai') {
    if (localOnly) throw failure('Hosted inference is disabled in local-only mode.', 403);
    if (url.origin !== 'https://api.openai.com') throw failure('Hosted inference requires https://api.openai.com.');
  } else if (profile.provider === 'lmstudio') {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) ||
        (!privateAddress(host) && !['localhost', 'host.docker.internal'].includes(host))) {
      throw failure('LM Studio requires a loopback or private IP, localhost, or host.docker.internal.');
    }
  } else {
    throw failure('Unknown inference provider.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
  return url;
}

// Resolve once, directly in the socket's lookup hook. The HTTP client connects
// to the checked address without performing a second DNS resolution.
function privateLookup(host, options, callback) {
  dns.lookup(host, {all: true, family: options.family || 0}, (error, addresses) => {
    if (error) return callback(error);
    const trusted = addresses.filter(entry => privateAddress(entry.address));
    if (!trusted.length) return callback(new Error('Local inference resolved outside the private network.'));
    if (options.all) return callback(null, trusted);
    callback(null, trusted[0].address, trusted[0].family);
  });
}

// Native clients here deliberately have no redirect, proxy, or retry policy.
function post(url, body, headers, signal, local) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST', headers, signal, agent: false, lookup: local ? privateLookup : undefined
    }, res => {
      const status = res.statusCode;
      if (status < 200 || status >= 300) {
        res.destroy();
        resolve({status});
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE) {
          res.destroy(new Error('Response too large.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({status, raw: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function secret(env, name) {
  if (!env[name + '_FILE']) return env[name]?.trim();
  try {
    return readFileSync(env[name + '_FILE'], 'utf8').trim();
  } catch {
    throw failure('The configured provider credential file could not be read.');
  }
}

export function deploymentCredential(env, provider) {
  if (provider === 'lmstudio') return secret(env, 'LM_STUDIO_API_KEY');
  if (provider === 'openai') return secret(env, 'OPENAI_API_KEY');
}

function parseReply(raw, toolNames) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_RESPONSE) throw failure('Invalid provider response.');
  let msg;
  try {
    msg = JSON.parse(raw).choices[0].message;
  } catch {
    throw failure('Invalid provider response.');
  }
  const text = typeof msg?.content === 'string' ? msg.content : '';
  const calls = [];
  const seen = new Set();
  if (toolNames.size && msg?.tool_calls != null) {
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length > 8) throw failure('Invalid provider tool request.');
    for (const call of msg.tool_calls) {
      const fn = call?.function;
      if (call?.type !== 'function' || typeof call.id !== 'string' || !/^[\w.-]{1,128}$/.test(call.id) ||
          seen.has(call.id) || !toolNames.has(fn?.name) || typeof fn.arguments !== 'string' || fn.arguments.length > 16384) {
        throw failure('Invalid provider tool request. Use chat-only mode for this model.');
      }
      let args;
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        throw failure('Invalid tool arguments. Use chat-only mode for this model.');
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('Invalid tool arguments.');
      seen.add(call.id);
      calls.push({id: call.id, name: fn.name, arguments: args});
    }
  }
  if (!text.trim() && !calls.length) throw failure('The provider returned no usable response.');
  return {text, calls};
}

export function createProvider({config, env = process.env, fetchImpl, planProvider, credentialFor = profile => deploymentCredential(env, profile.provider)}) {
  return {
    async complete(profile, messages, tools = [], options = {}) {
      const url = providerEndpoint(profile, config.localOnly);
      if (profile.provider === 'chatgpt-plan') {
        if (!planProvider) throw failure('Configure Sign in with ChatGPT on this worker.', 503);
        return planProvider.complete(profile, messages, tools, options);
      }
      const {signal} = options;
      const local = profile.provider === 'lmstudio';
      const token = credentialFor(profile);
      if (!local && !token) throw failure('Configure the OpenAI API key to use hosted inference.');
      const headers = {'Content-Type': 'application/json'};
      if (token) headers.Authorization = 'Bearer ' + token;
      const payload = {model: profile.model, messages};
      if (!local) payload.store = false;
      const enabled = profile.nativeTools === true ? tools : [];
      if (enabled.length) {
        payload.tools = enabled.map(({name, description, inputSchema}) => ({
          type: 'function', function: {name, description, parameters: inputSchema}
        }));
      }
      const timer = AbortSignal.timeout(config.providerTimeoutMs ?? 45000);
      const deadline = signal ? AbortSignal.any([signal, timer]) : timer;
      let result;
      try {
        deadline.throwIfAborted();
        const body = JSON.stringify(payload);
        if (fetchImpl) {
          const response = await fetchImpl(url, {method: 'POST', headers, body, signal: deadline, redirect: 'error'});
          result = {status: response.status, raw: response.ok ? await response.text() : undefined};
        } else {
          result = await post(url, body, headers, deadline, local);
        }
      } catch {
        throw failure(deadline.aborted ? 'Provider request timed out or was cancelled.' : 'Could not reach the selected provider.', deadline.aborted ? 504 : 502);
      }
      if (result.status < 200 || result.status >= 300) throw failure('Selected provider returned HTTP ' + result.status + '.');
      return parseReply(result.raw, new Set(enabled.map(tool => tool.name)));
    }
  };
}
