import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { badRequest } from './store.mjs';

const dayMs = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest();
const cookieName = 'clockwork_session';

async function readJson(req) {
  if (req.headers['x-clockwork-request'] !== '1' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw badRequest('Use a Clockwork JSON request.', 403);
  }
  if (req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.headers.origin && URL.parse(req.headers.origin)?.host !== req.headers.host)) {
    throw badRequest('Cross-origin request blocked.', 403);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64000) throw badRequest('Request body is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    return body;
  } catch {
    throw badRequest('Expected a JSON object.');
  }
}

function json(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
}

export function createHttpServer({runtime, root, password, secureCookie = false}) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) {
    throw Error('Set a Clockwork owner password of 16–1024 characters before starting.');
  }
  const passwordDigest = digest(password);
  const sessions = new Map();
  const failures = new Map();
  const cookie = (token, age) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookie ? '; Secure' : ''}`;
  const files = new Map([
    ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
    ['/style.css', ['style.css', 'text/css']],
  ]);

  function login(req, res, candidate) {
    const now = Date.now();
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
    for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
    const ip = req.socket.remoteAddress;
    const record = failures.get(ip) ?? {count: 0, until: now + 10 * 60 * 1000};
    if (record.count >= 10) throw badRequest('Too many attempts. Try again in ten minutes.', 429);
    if (typeof candidate !== 'string' || candidate.length > 1024 || !timingSafeEqual(digest(candidate), passwordDigest)) {
      failures.set(ip, {...record, count: record.count + 1});
      throw badRequest('Incorrect owner password.', 401);
    }
    failures.delete(ip);
    const token = randomBytes(32).toString('hex');
    sessions.set(digest(token).toString('hex'), now + dayMs);
    res.setHeader('Set-Cookie', cookie(token, dayMs / 1000));
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;
    if (method === 'GET' && files.has(path)) {
      const [file, type] = files.get(path);
      const content = readFileSync(join(root, 'public', file));
      res.writeHead(200, {'Content-Type': type + '; charset=utf-8'});
      res.end(content);
      return;
    }
    if (method === 'GET' && path === '/healthz') return json(res, 200, {ok: true});
    if (method === 'POST' && path === '/api/login') {
      login(req, res, (await readJson(req)).password);
      return json(res, 200, {ok: true});
    }
    if (!path.startsWith('/api/')) throw badRequest('Page not found.', 404);
    const token = /(?:^|;\s*)clockwork_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const key = token && digest(token).toString('hex');
    if (!key || !(sessions.get(key) > Date.now())) throw badRequest('Sign in to Clockwork.', 401);
    if (method === 'GET' && path === '/api/state') return json(res, 200, runtime.state());
    const profile = runtime.active();
    if (method === 'GET' && path === '/api/history') {
      if (url.searchParams.get('profile') !== profile.id) throw badRequest('Profile changed. Refresh the conversation.', 409);
      const before = Number(url.searchParams.get('before'));
      if (!Number.isSafeInteger(before) || before <= 0) throw badRequest('Invalid message cursor.');
      const messages = runtime.notebook.messages(profile.scope, 101, before);
      return json(res, 200, {messages: messages.slice(-100), hasEarlier: messages.length > 100});
    }
    if (!['POST','PATCH','DELETE'].includes(method)) throw badRequest('Route not found.', 404);
    const body = await readJson(req);
    if (method === 'POST' && path === '/api/logout') {
      sessions.delete(key);
      res.setHeader('Set-Cookie', cookie('', 0));
      return json(res, 200, {ok: true});
    }
    // This check runs after the async body read, immediately before routing.
    const current = runtime.active();
    if (req.headers['x-clockwork-profile'] !== current.id) {
      throw badRequest('The active profile changed. Refresh and review the provider before continuing.', 409);
    }
    let match;
    if (method === 'POST' && path === '/api/profile') {
      runtime.selectProfile(body.id);
    } else if (method === 'POST' && path === '/api/chat') {
      await runtime.chat(body.text);
    } else if (method === 'POST' && path === '/api/preferences') {
      runtime.notebook.add(current.scope, 'preference', body.text);
    } else if (method === 'POST' && path === '/api/commitments') {
      runtime.notebook.add(current.scope, 'commitment', body.text);
    } else if ((match = /^\/api\/(preferences|commitments)\/(\d+)$/.exec(path)) && method === 'PATCH') {
      runtime.notebook.update(current.scope, match[1] === 'preferences' ? 'preference' : 'commitment', match[2], body);
    } else if ((match = /^\/api\/preferences\/(\d+)$/.exec(path)) && method === 'DELETE') {
      runtime.notebook.removePreference(current.scope, match[1]);
    } else if (method === 'POST' && path === '/api/jobs') {
      if (body.profileId !== current.id) throw badRequest('Choose the active profile for this follow-up.');
      runtime.scheduler.create(body);
    } else if ((match = /^\/api\/jobs\/([\w-]+)\/(pause|resume|cancel)$/.exec(path)) && method === 'POST') {
      runtime.scheduler.change(match[1], match[2]);
    } else if ((match = /^\/api\/approvals\/([\w-]+)\/(approve|reject)$/.exec(path)) && method === 'POST') {
      if (Object.keys(body).length) throw badRequest('An approval decision accepts only the stored action.');
      await runtime.capabilities.decide(match[1], match[2] === 'approve' ? 'approve' : 'deny');
    } else {
      throw badRequest('Route not found.', 404);
    }
    json(res, 200, {ok: true});
  }
  return createServer({headersTimeout: 15000, requestTimeout: 30000}, (req, res) => {
    handle(req, res).catch(error => {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      if (!res.headersSent && !res.destroyed) json(res, status, {error: status === 500 ? 'Clockwork could not complete this request.' : error.message});
      if (status === 500) console.error('Clockwork request failed.', error.code ?? error.name);
    });
  });
}
