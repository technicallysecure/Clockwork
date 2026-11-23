import assert from 'node:assert/strict';
import test from 'node:test';
import {createWebSearch, SEARCH_QUERY_MAX, SEARCH_RESULT_LIMIT} from '../src/web-search.mjs';

test('search sends just the supplied terms and fixed options to the worker sidecar, then bounds the result set', async () => {
  let calls = 0;
  const search = createWebSearch({fetchImpl:async (url, options) => {
    calls++;
    assert.equal(url, 'http://web-search:8080/search');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, {accept:'application/json'});
    assert.deepEqual(Object.fromEntries(options.body), {q:'site:nodejs.org AbortSignal', format:'json', safesearch:'2'});
    return Response.json({results:[
      {url:'javascript:alert(1)', title:'discard'},
      {url:'https://192.168.1.1/', title:'discard'},
      {url:'https://example.com/a#anchor', title:'<b>Node</b> &amp; timeouts', content:'Useful\u202E fact', img_src:'remote asset'},
      {url:'https://example.com/a#other', title:'duplicate'},
      ...Array.from({length:9}, (_,i) => ({url:'https://nodejs.org/'+i, title:'A'.repeat(1000), content:'B'.repeat(2000)})),
    ]});
  }});
  const results = await search(' site:nodejs.org AbortSignal ');
  assert.equal(calls, 1);
  assert.equal(results.length, SEARCH_RESULT_LIMIT);
  assert.deepEqual(results[0], {title:'Node & timeouts',url:'https://example.com/a',snippet:'Useful fact'});
  assert.equal(results[1].title.length, 200);
  assert.equal(results[1].snippet.length, 500);
});

test('invalid queries and aborts never contact the sidecar', async () => {
  let calls = 0;
  const search = createWebSearch({fetchImpl:() => { calls++; }});
  for (const value of [2, '', 'x'.repeat(SEARCH_QUERY_MAX+1), 'two\nlines', 'x\u200by', 'find !images cats',
    '!!docs example', 'find :fr tigers', 'find <week tigers']) {
    await assert.rejects(search(value), {status:400});
  }
  await assert.rejects(search('deadline', {signal:AbortSignal.abort()}), {status:504});
  assert.equal(calls, 0);
});

test('a genuine empty result differs from rate limiting, bad payloads and upstream outages', async () => {
  const fixtures = [
    [Response.json({results:[],unresponsive_engines:[]}), null],
    [Response.json({results:[],unresponsive_engines:[['duckduckgo','upstream detail']]}), 503],
    [Response.json({error:'upstream detail'}, {status:429}), 429],
    [new Response('upstream detail', {status:503}), 503],
    [Response.json({answer:'upstream detail'}), 502],
    [new Response('upstream detail', {headers:{'content-type':'text/html'}}), 502],
    [new Response('{', {headers:{'content-type':'application/json'}}), 502],
    [new Response(new Uint8Array(524289), {headers:{'content-type':'application/json'}}), 502],
    [new Response(null, {status:302,headers:{location:'https://elsewhere.net/'}}), 503],
  ];
  for (const [response, status] of fixtures) {
    const search = createWebSearch({fetchImpl:async () => response});
    if (status) await assert.rejects(search('query'), e => e.status === status && !e.message.includes('upstream detail'));
    else assert.deepEqual(await search('query'), []);
  }
  const down = createWebSearch({fetchImpl:async () => { throw Object.assign(new Error('upstream detail'), {status:503}); }});
  await assert.rejects(down('query'), {status:503, message:'The search service is unavailable.'});
});
