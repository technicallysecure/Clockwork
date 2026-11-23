import {safePublicUrl} from './public-page.mjs';
import {ToolError} from './capabilities.mjs';

export const SEARCH_QUERY_MAX = 300;
export const SEARCH_RESULT_LIMIT = 5;
const endpoint = 'http://web-search:8080/search';
const maxResponseBytes = 512 * 1024;
class SearchError extends ToolError {}

export function normalizeSearchQuery(query) {
  if (typeof query !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(query) ||
      !query.trim() || [...query.trim()].length > SEARCH_QUERY_MAX) {
    throw new SearchError('Enter a single-line search query of up to 300 characters.', 400);
  }
  // SearXNG interprets token prefixes as engine/category, external redirect,
  // language or time-range directives. This client accepts literal terms.
  if (/(?:^|\s)[!:<]/u.test(query)) throw new SearchError('Use search terms without SearXNG routing prefixes.', 400);
  return query.trim();
}

function excerpt(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.slice(0, 8000)
    .replace(/<[^<>]{1,500}>/g, ' ')
    .replace(/&(?:amp|quot|apos|nbsp|lt|gt);/g, entity =>
      ({'&amp;':'&', '&quot;':'"', '&apos;':"'", '&nbsp;':' ', '&lt;':'<', '&gt;':'>'})[entity])
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return [...text].slice(0, limit).join('');
}

async function readResults(response) {
  const error = () => new SearchError('The search service returned an invalid response.', 502);
  if (!response.ok || !response.body ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > maxResponseBytes) {
    await response.body?.cancel();
    if (response.status === 429) throw new SearchError('The search service is rate limited. Try again later.', 429);
    if (!response.ok) throw new SearchError('The search service is unavailable.', 503);
    throw error();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw error();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error(); }
  if (!Array.isArray(data?.results)) throw error();
  const results = [];
  const found = new Set();
  for (const item of data.results) {
    const url = safePublicUrl(item?.url);
    const title = excerpt(item?.title, 200);
    if (!url || !title || found.has(url)) continue;
    found.add(url);
    results.push({title, url, snippet:excerpt(item.content, 500)});
    if (results.length === SEARCH_RESULT_LIMIT) break;
  }
  if (!results.length && data.unresponsive_engines?.length) {
    throw new SearchError('The search engines could not complete this search. Try again later.', 503);
  }
  return results;
}

export function createWebSearch({fetchImpl = fetch} = {}) {
  return async function search(query, {signal} = {}) {
    const q = normalizeSearchQuery(query);
    const timeout = AbortSignal.timeout(9000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      deadline.throwIfAborted();
      const response = await fetchImpl(endpoint, {
        method:'POST', headers:{accept:'application/json'},
        body:new URLSearchParams({q, format:'json', safesearch:'2'}),
        credentials:'omit', redirect:'error', signal:deadline,
      });
      return await readResults(response);
    } catch (error) {
      if (deadline.aborted) throw new SearchError('The web search timed out or was cancelled.', 504);
      if (error instanceof SearchError) throw error;
      throw new SearchError('The search service is unavailable.', 503);
    }
  };
}
