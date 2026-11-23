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
    if (size > 256 * 1024) throw badRequest('Request body is too large.', 413);
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

export function createWebServer({root, password, workerToken, secureCookie = false, route}) {
  const worker = workerToken !== undefined;
  if (worker && (typeof workerToken !== 'string' || workerToken.length < 32)) {
    throw Error('The worker requires its provisioned internal credential.');
  }
  if (!worker && (typeof password !== 'string' || password.length < 16 || password.length > 1024)) {
    throw Error('Set a Clockwork owner password of 16–1024 characters before starting.');
  }
  const passwordDigest = worker ? null : digest(password);
  const bearerDigest = worker ? digest('Bearer ' + workerToken) : null;
  const sessions = new Map();
  const failures = new Map();
  const cookie = (token, age) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookie ? '; Secure' : ''}`;
  const files = new Map([
    ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
    ['/style.css', ['style.css', 'text/css']], ['/agents.js', ['agents.js', 'text/javascript']],
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
    if (!worker && method === 'GET' && files.has(path)) {
      const [file, type] = files.get(path);
      const content = readFileSync(join(root, 'public', file));
      res.writeHead(200, {'Content-Type': type + '; charset=utf-8'});
      res.end(content);
      return;
    }
    if (method === 'GET' && path === '/healthz') return json(res, 200, {ok: true});
    if (!worker && method === 'POST' && path === '/api/login') {
      login(req, res, (await readJson(req)).password);
      return json(res, 200, {ok: true});
    }
    if (!path.startsWith('/api/')) throw badRequest('Page not found.', 404);
    const token = /(?:^|;\s*)clockwork_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const key = token && digest(token).toString('hex');
    if (worker) {
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), bearerDigest)) throw badRequest('Worker authentication required.', 401);
    } else if (!key || !(sessions.get(key) > Date.now())) {
      throw badRequest('Sign in to Clockwork.', 401);
    }
    if (!['GET','POST','PUT','PATCH','DELETE'].includes(method)) throw badRequest('Route not found.', 404);
    const body = method === 'GET' ? undefined : await readJson(req);
    if (!worker && method === 'POST' && path === '/api/logout') {
      sessions.delete(key);
      res.setHeader('Set-Cookie', cookie('', 0));
      return json(res, 200, {ok: true});
    }
    const result = await route({
      method, path:path.slice('/api'.length), query:url.search, body,
      agentId:req.headers['x-clockwork-agent'], profile:req.headers['x-clockwork-profile'],
      revision:req.headers['x-clockwork-revision'],
    });
    json(res, 200, result);
  }
  return createServer({headersTimeout: 15000, requestTimeout: 30000}, (req, res) => {
    handle(req, res).catch(error => {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      if (!res.headersSent && !res.destroyed) json(res, status, {error: status === 500 ? 'Clockwork could not complete this request.' : error.message});
      if (status === 500) console.error('Clockwork request failed.', error.code ?? error.name);
    });
  });
}
