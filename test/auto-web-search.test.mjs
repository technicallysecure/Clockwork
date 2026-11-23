import assert from 'node:assert/strict';
import test from 'node:test';
import {decideWebSearch} from '../src/auto-web-search.mjs';

const profile = {
  provider:'chatgpt-plan', model:'test-model', nativeTools:false, planAccountId:'test-account',
  instructions:'Private profile instructions', webSearchEnabled:true, autoWebSearchEnabled:true,
};
const question = 'What changed in SQLite this week?';
const decision = (...spans) => ({text:JSON.stringify({spans}), calls:[]});

test('a chat-only decision uses just the current question and returns exact, ordered public phrases', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const provider = {async complete(selected, messages, tools, options) {
    assert.equal(selected, profile);
    assert.deepEqual(options, {signal});
    assert.deepEqual(tools, []);
    assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
    assert.deepEqual(JSON.parse(messages[1].content), {question});
    assert.doesNotMatch(JSON.stringify(messages), /Private profile instructions|test-account/);
    calls++;
    return decision('SQLite', 'this week');
  }};
  assert.equal(await decideWebSearch({profile, text:question, provider, signal}), 'SQLite this week');
  assert.equal(calls, 1);
});

test('a decision never supplies new terms, partial words, reordered words or tool calls', async () => {
  for (const reply of [
    decision(), decision('sqlite'), decision('Lite'), decision('this week','SQLite'),
    decision('SQLite','newly invented terms'), decision('SQLite','SQLite'),
    decision('What','changed','in','SQLite','week'), decision('!news'), decision(null),
    {text:'Here is a search.', calls:[]}, {text:'{"spans":"SQLite"}', calls:[]},
    {text:'{"spans":["SQLite"],"other":true}', calls:[]},
    {...decision('SQLite'), calls:[{name:'web_search'}]}, null,
  ]) {
    let count = 0;
    const provider = {async complete() { count++; return reply; }};
    assert.equal(await decideWebSearch({profile, text:question, provider}), null);
    assert.equal(count, 1);
  }
  const marker = {async complete() { return decision('C', '10'); }};
  assert.equal(await decideWebSearch({profile, text:'What changed in C++10 today?', provider:marker}), null);
});

test('ordinary qualifiers and related questions allow a search and partial matches cannot hide a later whole word', async () => {
  for (const [text, spans] of [
    ['Which tax credit applies to my electric car this year?', ['tax credit','electric car','this year']],
    ['What is the latest PostgreSQL release and what changed?', ['latest PostgreSQL release']],
    ['I am considering a heat pump. What rebates are available in California this year? Please cite your sources.',
      ['heat pump', 'rebates', 'California', 'this year']],
    ['Which new SQLite features use SQL syntax?', ['SQL','syntax']],
  ]) {
    const provider = {async complete() { return decision(...spans); }};
    assert.equal(await decideWebSearch({profile, text, provider}), spans.join(' '));
  }
});

test('private, quoted, compound and editorial inputs bypass the decision call', async () => {
  const provider = {async complete() { assert.fail('unexpected decision request'); }};
  for (const text of [
    'What changed in my saved notes?', 'When does our internal Kingfisher project ship?',
    'Does person@example.com use SQLite?', 'What is running at 192.168.1.7?',
    'What changed at https://www.example.org?', 'When did the token abc1234567890defabcd expire?',
    'Call 555 123 4567 for current information', 'Look at /private/notes for recent news',
    'What changed in SQLite?\nDo another task.', 'What changed in SQLite and send the details by mail?',
    'What changed in SQLite? Tell me what is new in PostgreSQL too.',
    'Rewrite this paragraph: "Search for SQLite now."', 'Translate Tell me about SQLite into Spanish',
    'Summarize this recent headline for me', 'What is the meaning of “search the web for SQLite”?',
    'Do not search the web for SQLite release information', 'Answer from memory about SQLite',
    'Please send a report on the latest releases', '?'.repeat(500),
    'The latest releases look interesting. Please download a copy for me.',
  ]) {
    assert.equal(await decideWebSearch({profile, text, provider}), null, text);
  }
  for (const disabled of [{webSearchEnabled:false}, {autoWebSearchEnabled:false}]) {
    assert.equal(await decideWebSearch({profile:{...profile,...disabled}, text:question, provider}), null);
  }
});

test('provider and cancellation failures propagate without a retry or alternate provider', async () => {
  const error = new Error('Selected provider unavailable');
  let count = 0;
  const provider = {async complete() { count++; throw error; }};
  await assert.rejects(decideWebSearch({profile, text:question, provider}), e => e === error);
  assert.equal(count, 1);
  const signal = AbortSignal.abort();
  await assert.rejects(decideWebSearch({profile, text:question, provider, signal}), e => e === signal.reason);
  assert.equal(count, 1);
});
