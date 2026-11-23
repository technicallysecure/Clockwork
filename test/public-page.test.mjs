import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import {createPublicPageReader, safePublicUrl} from '../src/public-page.mjs';

const domain = 'news.example.com';
const url = 'https://' + domain + '/story?a=1';
const publicIp = '93.184.216.34';

function response(body = '', status = 200, type = 'text/plain', headers = {}) {
  const stream = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  return Object.assign(stream, {statusCode:status, headers:{'content-type':type, ...headers}});
}

function fixture(paths, records = [publicIp]) {
  const requests = [], queries = [];
  const read = createPublicPageReader({
    async resolveHost(host) { queries.push(host); return records; },
    async request(options) {
      requests.push(options);
      const value = paths[options.path];
      if (!value) throw Error('Unexpected request path');
      return response(...value);
    },
  });
  return {read, requests, queries};
}

test('source URL syntax accepts normal HTTPS domains and removes fragments', () => {
  assert.equal(safePublicUrl('https://News.Example.com:443/story#chapter'), 'https://news.example.com/story');
  for (const value of ['http://news.example.com/', 'file:///path', 'https://127.1/', 'https://2130706433/',
    'https://[::1]/','https://xyz.onion/','https://files.local/','https://a.home.arpa/','https://intranet/',
    'https://someone@news.example.com/','https://@news.example.com/','https://news.example.com:9443/',
    'https://news.example.com\\other/', 'https://news.example.com\n/', 'https://.example.com/']) {
    assert.equal(safePublicUrl(value), null);
  }
});

test('any special-use or private DNS answer blocks the connection, before robots or page access', async () => {
  for (const address of ['127.0.0.1','172.16.0.1','100.64.3.4','192.0.2.2','169.254.1.1','198.51.100.4','198.19.0.5',
    '224.0.0.1','240.0.0.1','168.63.129.16','::','::1','::ffff:127.0.0.1','64:ff9b::1','2002::1','2001::8',
    '2001:db8::c','3fff::2','fe80::1','fc00::1','ff00::9']) {
    const {read, requests} = fixture({}, [publicIp, address]);
    await assert.rejects(read(url), /outside the permitted public network/);
    assert.equal(requests.length, 0);
  }
});

test('one validated DNS resolution pins robots and page sockets and preserves hostname TLS verification', async () => {
  const html = '<title>Public &amp; current</title><body><nav>nav text</nav><script>hidden()</script>' +
    '<div hidden><div>nested secret</div> hidden</div><svg/><span style="display:none!important">hidden</span>' +
    '<p>Read &lt;this&gt; article.</p><a href="/over">Facts</a>' +
    '<img src="/pixel"><iframe src="/tracking"></iframe><form action="/post">Ignore</form></body>';
  const ip = '2606:4700::1111';
  const {read, requests, queries} = fixture({'/robots.txt':['',404],
    '/story?a=1':[gzipSync(html),200,'text/html; charset=utf-8',{'content-encoding':'gzip'}]}, [ip]);
  assert.deepEqual(await read(url), {url, title:'Public & current', text:'Read <this> article. Facts'});
  assert.deepEqual(queries,[domain]);
  assert.deepEqual(requests.map(r => r.path), ['/robots.txt','/story?a=1']);
  for (const r of requests) {
    assert.equal(r.hostname, ip);
    assert.equal(r.servername, domain);
    assert.equal(r.rejectUnauthorized, true);
    assert.equal(r.port,443);
    assert.equal(r.agent,false);
    assert.equal(r.headers.Host,domain);
    assert.ok(Object.keys(r.headers).every(k => ['Host','User-Agent','Accept','Accept-Encoding'].includes(k)));
  }
});

test('same-origin redirects are checked against site rules; off-origin and credential-bearing redirects stop', async () => {
  const policy = 'User-agent: *\nAllow: /\nUser-agent: ClockworkReader\nDisallow: /private*\nAllow: /private/public$';
  for (const [to, expected] of [['/private1',/excludes this page/], ['//other.example.org/',/outside its approved origin/],
    ['http://news.example.com/',/outside its approved origin/],['https://user@news.example.com/',/outside its approved origin/]]) {
    const {read,requests} = fixture({'/robots.txt':[policy],'/story?a=1':['',302,'text/plain',{location:to}]});
    await assert.rejects(read(url),expected);
    assert.equal(requests.length,2);
  }
  const {read} = fixture({'/robots.txt':['',301,'text/plain',{location:'/rules'}],'/rules':[policy],
    '/story?a=1':['',307,'text/plain',{location:'/private/public'}],'/private/public':['A page']});
  assert.deepEqual(await read(url),{title:'',url:'https://news.example.com/private/public',text:'A page'});
});

test('only an unavailable 404 or 410 robots file defaults to reading; denials, unreadable and failed policies stop', async () => {
  for (const robots of [['',401],['',403],['',429],['',503],['<html>',200,'text/html'],
    ['',301,'text/plain',{location:'https://other.example.com/robots.txt'}],['User-agent: *\nDisallow: /']]) {
    const {read,requests} = fixture({'/robots.txt':robots});
    await assert.rejects(read(url));
    assert.equal(requests.length,1);
  }
  assert.equal((await fixture({'/robots.txt':['',410],'/story?a=1':['ok']}).read(url)).text,'ok');
});

test('size bounds apply to wire and expanded content; output is bounded and excludes formatting controls', async () => {
  const large = Buffer.alloc(1024 * 1024 + 1, 65);
  for (const page of [[large],[gzipSync(large),200,'text/plain',{'content-encoding':'gzip'}],
    ['short',200,'text/plain',{'content-length':String(large.length)}], ['image data',200,'image/png'],
    [Buffer.from([0x61,0,2])],['',206]]) {
    await assert.rejects(fixture({'/robots.txt':['',404],'/story?a=1':page}).read(url));
  }
  const {text} = await fixture({'/robots.txt':['',404],'/story?a=1':['a\u202e'+'word '.repeat(5000)]}).read(url);
  assert.equal(text.length,12000);
  assert.ok(!text.includes('\u202e'));
});

test('cancellation before lookup or after resolution prevents any connection', async () => {
  const {read,queries} = fixture({});
  await assert.rejects(read(url,{signal:AbortSignal.abort()}),/cancelled/);
  assert.equal(queries.length,0);
  const controller = new AbortController();
  let connections = 0;
  const abortOnResolve = createPublicPageReader({resolveHost: async () => { controller.abort(); return [publicIp]; },
    request:async () => { connections++; }});
  await assert.rejects(abortOnResolve(url,{signal:controller.signal}),/cancelled/);
  assert.equal(connections,0);
});
