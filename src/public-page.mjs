import {Resolver} from 'node:dns/promises';
import https from 'node:https';
import {BlockList, isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
import {promisify} from 'node:util';
import {gunzip, brotliDecompress} from 'node:zlib';
import {SAXParser} from 'parse5-sax-parser';
import robotsParser from 'robots-parser';
import {ToolError} from './capabilities.mjs';

const readerName = 'ClockworkReader';
const byteLimit = 1024 * 1024;
const robotsLimit = 512 * 1024;
const textLimit = 12000;
const decompress = {gzip:promisify(gunzip), br:promisify(brotliDecompress)};
const redirects = new Set([301,302,303,307,308]);
class ReaderError extends ToolError {
  constructor(message) { super(message, 422); }
}

// Broadly exclude special-purpose ranges, including transition mechanisms that
// embed another IP. The sole IPv6 allow range is allocated global unicast.
const forbidden = new BlockList();
for (const range of ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12',
  '192.0.0.0/24','192.0.2.0/24','192.31.196.0/24','192.52.193.0/24','192.88.99.0/24','192.168.0.0/16',
  '192.175.48.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4',
  '168.63.129.16/32','2001::/23','2001:db8::/32','2002::/16','2620:4f:8000::/48','3fff::/20']) {
  const [address, prefix] = range.split('/');
  forbidden.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

export function safePublicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value) ||
      /[\p{Cc}\p{Cf}\s\\]/u.test(value) || /^https:\/\/[^/?#]*@/i.test(value)) return null;
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = url.hostname;
  if (host.length > 253 || isIP(host) || !host.includes('.') ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /\.(?:arpa|internal|localhost|localdomain|local|home|lan|corp|test|invalid|onion)$/.test(host)) return null;
  url.hash = '';
  return url.href.length <= 2048 ? url.href : null;
}

async function dnsAddresses(host, signal) {
  const resolver = new Resolver({timeout:2500, tries:1});
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, {once:true});
  try {
    // A fully qualified name prevents resolver search suffixes from expanding
    // a public-looking name into a private DNS zone.
    const name = host + '.';
    const families = await Promise.all([resolver.resolve4(name), resolver.resolve6(name)].map(async answer => {
      try { return await answer; }
      catch (error) {
        if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') return [];
        throw error;
      }
    }));
    return families.flat();
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function approvedAddress(addresses) {
  const local = new BlockList();
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (entry && isIP(entry.address)) local.addAddress(entry.address, isIP(entry.address) === 6 ? 'ipv6' : 'ipv4');
  }
  for (const address of addresses) {
    const family = isIP(address);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (!family || (family === 6 && (!globalIPv6.check(address, type) || address.includes('%'))) ||
        forbidden.check(address, type) || local.check(address, type)) {
      throw new ReaderError('This source resolves outside the permitted public network.');
    }
  }
  if (!addresses.length) throw new ReaderError('The source domain has no public address.');
  return addresses[0];
}

function openHttps(options) {
  return new Promise((resolve, reject) => https.get(options, resolve).once('error', reject));
}

function redirectTarget(from, location) {
  if (typeof location !== 'string' || !location || location.length > 2048) return null;
  const redirected = URL.parse(location, from);
  if (!redirected || redirected.origin !== from.origin || !safePublicUrl(redirected.href)) return null;
  redirected.hash = '';
  return redirected;
}

async function readBody(res, limit) {
  const encoding = (res.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity' && !Object.hasOwn(decompress, encoding)) {
    throw new ReaderError('The source uses an unsupported content encoding.');
  }
  if (Number(res.headers['content-length']) > limit) throw new ReaderError('The source exceeds the reader size limit.');
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) throw new ReaderError('The source exceeds the reader size limit.');
    chunks.push(chunk);
  }
  let bytes = Buffer.concat(chunks, size);
  if (encoding !== 'identity') {
    try { bytes = await decompress[encoding](bytes, {maxOutputLength:limit}); }
    catch { throw new ReaderError('The compressed source is invalid or exceeds the reader size limit.'); }
  }
  if (bytes.includes(0)) throw new ReaderError('This source does not contain readable text.');
  try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
  catch { throw new ReaderError('This source uses an unsupported text encoding.'); }
}

function plainText(value) {
  return value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
}

function extractHtml(html) {
  const parser = new SAXParser();
  const skip = new Set(['script','style','template','noscript','iframe','svg','canvas','object','nav','footer','form']);
  const empty = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  let suppressed = '', depth = 0, inTitle = false, inHead = false, title = '', text = '';
  parser.on('startTag', ({tagName, attrs, selfClosing}) => {
    // These foreign elements use XML-style self-closing tags even in HTML.
    if (selfClosing && (tagName === 'svg' || tagName === 'math')) return;
    if (depth) {
      if (tagName === suppressed) depth++;
      return;
    }
    const hidden = attrs.some(a => a.name === 'hidden' || (a.name === 'aria-hidden' && a.value.trim().toLowerCase() === 'true') ||
      (a.name === 'style' && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test(a.value)));
    if (!empty.has(tagName) && (skip.has(tagName) || hidden)) { suppressed = tagName; depth = 1; }
    else if (tagName === 'title') inTitle = true;
    else if (tagName === 'head') inHead = true;
    else if (tagName === 'body') inHead = false;
  });
  parser.on('endTag', ({tagName}) => {
    if (depth) {
      if (tagName === suppressed) depth--;
      return;
    }
    if (tagName === 'title') inTitle = false;
    if (tagName === 'head') inHead = false;
  });
  parser.on('text', token => {
    if (depth) return;
    const value = plainText(token.text);
    if (!value) return;
    if (inTitle) {
      if (title.length < 240) title += ' ' + value.slice(0, 239 - title.length);
    }
    else if (!inHead && text.length < textLimit) text += ' ' + value.slice(0, textLimit - text.length);
  });
  parser.end(html);
  return {title:title.trim(), text:text.trim().slice(0, textLimit)};
}

export function createPublicPageReader({resolveHost = dnsAddresses, request = openHttps} = {}) {
  return async function read(urlString, {signal:callerSignal} = {}) {
    const canonical = safePublicUrl(urlString);
    if (!canonical) throw new ReaderError('Choose a public HTTPS search result.');
    const target = new URL(canonical);
    const timeout = AbortSignal.timeout(12000);
    const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
    try {
      signal.throwIfAborted();
      const address = approvedAddress(await resolveHost(target.hostname, signal));
      async function fetchPath(url, robots, allowed) {
        const maxHops = robots ? 5 : 3;
        for (let hop = 0; hop <= maxHops; hop++) {
          signal.throwIfAborted();
          if (allowed && !allowed(url)) throw new ReaderError('The site’s robots.txt excludes this page.');
          // Connecting by literal IP avoids a second lookup. SNI and certificate
          // validation use the original hostname. No agent, proxies or cookies.
          const res = await request({protocol:'https:', hostname:address, port:443, servername:target.hostname,
            rejectUnauthorized:true, agent:false, signal, maxHeaderSize:16384, path:url.pathname + url.search,
            headers:{Host:target.host, 'User-Agent':readerName + '/1.0', Accept:robots ? 'text/plain' : 'text/html, text/plain',
              'Accept-Encoding':'gzip, br'}});
          try {
            const status = res.statusCode;
            if (redirects.has(status)) {
              url = redirectTarget(url, res.headers.location);
              if (!url) throw new ReaderError('The source redirects outside its approved origin.');
              continue;
            }
            if (robots && (status === 404 || status === 410)) return null;
            if (status !== 200) throw new ReaderError(robots ? 'The site’s robots policy is unavailable.' : 'The source could not be read.');
            const type = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (type !== 'text/plain' && (robots || type !== 'text/html')) {
              throw new ReaderError(robots ? 'The site’s robots policy is unreadable.' : 'The reader supports HTML and plain text.');
            }
            return {url:url.href, type, body:await readBody(res, robots ? robotsLimit : byteLimit)};
          } finally { res.destroy(); }
        }
        throw new ReaderError('The source exceeded the redirect limit.');
      }
      const robotsUrl = new URL('/robots.txt', target);
      const robots = await fetchPath(robotsUrl, true);
      let policy;
      if (robots) {
        // The parser distributes each directive among its user agents; cap
        // potential group expansion before passing it an untrusted document.
        const agents = robots.body.match(/user-agent/gi)?.length || 1;
        if (agents * robots.body.length > 16 * 1024 * 1024) throw new ReaderError('The site’s robots policy is too complex.');
        policy = robotsParser(robotsUrl.href, robots.body);
      }
      const page = await fetchPath(target, false, url => !policy || policy.isAllowed(url.href, readerName) === true);
      signal.throwIfAborted();
      const extracted = page.type === 'text/html' ? extractHtml(page.body) : {title:'', text:plainText(page.body).slice(0, textLimit)};
      if (!extracted.text) throw new ReaderError('The source has no readable text.');
      return {...extracted, url:page.url};
    } catch (error) {
      if (signal.aborted) throw new ReaderError('Reading the source timed out or was cancelled.');
      if (error instanceof ReaderError) throw error;
      throw new ReaderError('The public source could not be reached or verified.');
    }
  };
}

export const readPublicPage = createPublicPageReader();
