import {createServer} from 'node:http';
import {badRequest} from './store.mjs';

// Only the owner-authenticated start route can install a callback destination.
// Losing this in-memory table on restart requires a fresh browser sign-in.
export function createPlanCallback(redirectUri) {
  const target = new URL(redirectUri);
  if (target.origin !== 'http://127.0.0.1:' + target.port || target.pathname !== '/auth/callback' ||
      target.search || target.hash || target.username || target.password) throw Error('Invalid plan callback URI.');
  const attempts = new Map();
  function track(agentId, state, finish) {
    if (typeof state !== 'string' || state.length < 20 || state.length > 256) throw Error('Invalid sign-in state.');
    for (const [key, pending] of attempts) {
      if (pending.agentId === agentId || pending.expires <= Date.now()) attempts.delete(key);
    }
    attempts.set(state, {agentId, finish, expires:Date.now() + 10 * 60_000});
  }
  const server = createServer({headersTimeout:10000, requestTimeout:15000}, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    try {
      if (req.method !== 'GET' || req.headers.host !== target.host || !req.url.startsWith('/auth/callback?') ||
          req.url.length > 8192) throw badRequest('Invalid callback.', 400);
      const params = new URL(req.url, target.origin).searchParams;
      const states = params.getAll('state');
      const pending = states.length === 1 && attempts.get(states[0]);
      if (!pending || pending.expires <= Date.now()) throw badRequest('Expired sign-in.', 400);
      attempts.delete(states[0]);
      const status = await pending.finish(params.toString());
      res.end(status.planEnabled
        ? 'ChatGPT plan permission confirmed. Return to Clockwork to choose a model and send a message.'
        : 'Signed in to ChatGPT. Plan permission is missing. Return to Clockwork Settings to review consent.');
    } catch (error) {
      res.statusCode = 400;
      res.end(error.message === 'ChatGPT sign-in or consent was declined. Reconnect when ready.'
        ? 'ChatGPT sign-in or plan consent was declined. Return to Clockwork Settings when you want to reconnect.'
        : 'Sign-in could not be completed. Return to Clockwork Settings and start a new sign-in.');
    }
  });
  function listen({role, env}) {
    // Docker publishes its dedicated gateway socket on host loopback. Native
    // gateways must bind to loopback even when their web UI is on the network.
    const container = role === 'gateway' && env.CLOCKWORK_PLAN_CONTAINER_CALLBACK === 'true';
    return new Promise((resolve, reject) => server.once('error', reject)
      .listen(Number(target.port), container ? '0.0.0.0' : '127.0.0.1', resolve));
  }
  return {server, track, listen};
}
