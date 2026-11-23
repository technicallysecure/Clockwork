import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createProvider, providerEndpoint } from '../src/providers.mjs';
import { loadConfig } from '../src/config.mjs';

const local = {provider: 'lmstudio', model: 'test-local', baseUrl: 'http://127.0.0.1:1234/v1', nativeTools: false};
const hosted = {provider: 'openai', model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', nativeTools: true};
const tools = [{name: 'check', description: 'A read tool.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}}];
const reply = message => JSON.stringify({choices: [{message}]});
const call = args => ({id: 'call_1', type: 'function', function: {name: 'check', arguments: args}});
async function server(t, handler) {
  const app = createServer(handler);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => {
    app.closeAllConnections();
    return new Promise(resolve => app.close(resolve));
  });
  return 'http://127.0.0.1:' + app.address().port + '/v1';
}

test('LM Studio wire request uses only local credentials. Chat-only models cannot request actions', async t => {
  let received;
  const baseUrl = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {body: JSON.parse(Buffer.concat(chunks)), headers: req.headers, path: req.url};
    res.end(reply({content: 'Hello', tool_calls: [call('{}')]}));
  });
  const provider = createProvider({config: {localOnly: true}, env: {OPENAI_API_KEY: 'cloud-test', LM_STUDIO_API_KEY: 'lm-test'}});
  const messages = [{role: 'user', content: 'Hi'}];
  assert.deepEqual(await provider.complete({...local, baseUrl}, messages, tools), {text: 'Hello', calls: []});
  assert.equal(received.headers.authorization, 'Bearer lm-test');
  assert.equal(received.path, '/v1/chat/completions');
  assert.deepEqual(received.body, {model: 'test-local', messages});
  assert.ok(!JSON.stringify(received).includes('cloud-test'));
});

test('hosted adapter opts out of storage, advertises only passed schemas, keeps credentials in headers', async () => {
  const provider = createProvider({config: {localOnly: false}, env: {LM_STUDIO_API_KEY: 'lm-test', OPENAI_API_KEY: 'cloud-test'},
    fetchImpl: async (url, opts) => {
      assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
      assert.equal(opts.headers.Authorization, 'Bearer cloud-test');
      const body = JSON.parse(opts.body);
      assert.equal(body.store, false);
      assert.deepEqual(body.tools[0].function.parameters, tools[0].inputSchema);
      assert.ok(!opts.body.includes('cloud-test') && !opts.body.includes('lm-test'));
      assert.equal(body.response_format, undefined);
      return new Response(reply({content: null, tool_calls: [call('{}')]}));
    }});
  assert.deepEqual((await provider.complete(hosted, [], tools)).calls, [{id: 'call_1', name: 'check', arguments: {}}]);
});

test('provider failure has no cloud fallback, retry, or leaked error body', async () => {
  const urls = [];
  const provider = createProvider({config: {localOnly: true}, env: {OPENAI_API_KEY: 'available-but-unused'},
    fetchImpl: async url => {
      urls.push(url.hostname);
      return new Response('private request contents from server log', {status: 503});
    }});
  await assert.rejects(provider.complete(local, [], []), {message: 'Selected provider returned HTTP 503.', status: 502});
  await assert.rejects(provider.complete(hosted, [], []), {status: 403});
  assert.deepEqual(urls, ['127.0.0.1']);
});

test('a local timeout ends the request at its selected endpoint', async t => {
  let count = 0;
  const baseUrl = await server(t, () => { count++; });
  const provider = createProvider({config: {localOnly: true, providerTimeoutMs: 150}, env: {OPENAI_API_KEY: 'unused'}});
  await assert.rejects(provider.complete({...local, baseUrl}, [], []), {status: 504});
  assert.equal(count, 1);
});

test('native transport refuses redirects before forwarding any data or credentials', async t => {
  let hits = 0;
  const destination = await server(t, (_req, res) => { hits++; res.end(); });
  const baseUrl = await server(t, (_req, res) => { res.writeHead(307, {Location: destination}); res.end(); });
  const provider = createProvider({config: {localOnly: true}, env: {LM_STUDIO_API_KEY: 'private'}});
  await assert.rejects(provider.complete({...local, baseUrl}, [], []), /HTTP 307/);
  assert.equal(hits, 0);
});

test('local endpoint and hosted credential boundaries reject public or credential-bearing URLs', () => {
  for (const baseUrl of ['https://api.openai.com/v1', 'http://8.8.8.8/v1', 'ftp://127.0.0.1/v1',
    'http://user:secret@localhost/v1', 'http://[::ffff:0808:0808]/v1', 'http://private.invalid/v1']) {
    assert.throws(() => providerEndpoint({...local, baseUrl}, true));
  }
  for (const baseUrl of ['http://host.docker.internal:1234/v1', 'http://192.168.1.20:1234/v1', 'http://[::1]:1234/v1']) {
    assert.ok(providerEndpoint({...local, baseUrl}, true).pathname.endsWith('/chat/completions'));
  }
  assert.throws(() => providerEndpoint({...hosted, baseUrl: 'https://api.openai.com:8081/v1'}, false));
  assert.throws(() => providerEndpoint({...hosted, baseUrl: 'https://example.org/v1'}, false));
});

test('malformed and unadvertised calls fail closed; chat never executes JSON in prose', async () => {
  for (const tool_calls of [[call('oops')], [call('null')], [call('{}'), call('{}')], [{...call('{}'), function: {name: 'invented', arguments: '{}'}}]]) {
    const provider = createProvider({config: {localOnly: true}, env: {}, fetchImpl: async () => new Response(reply({tool_calls}))});
    await assert.rejects(provider.complete({...local, nativeTools: true}, [], tools));
  }
  const prose = '{"tool_calls":[{"name":"check","arguments":{}}]}';
  const provider = createProvider({config: {localOnly: true}, env: {}, fetchImpl: async () => new Response(reply({content: prose}))});
  assert.deepEqual(await provider.complete(local, [], tools), {text: prose, calls: []});
});

test('capabilities are explicit per model; local-only profiles exclude hosted inference', () => {
  const config = loadConfig({env: {CLOCKWORK_LOCAL_ONLY: 'false', CLOCKWORK_OPENAI_MODEL: 'another-model'}});
  assert.equal(config.profiles.find(p => p.id === 'hosted').nativeTools, false);
  const isolated = loadConfig({env: {}});
  assert.ok(isolated.profiles.every(p => p.provider === 'lmstudio' && !p.nativeTools));
  assert.throws(() => loadConfig({env: {CLOCKWORK_LOCAL_ONLY: 'invalid'}}));
});
