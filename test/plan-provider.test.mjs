import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanProvider } from '../src/plan-provider.mjs';
import { createProvider } from '../src/providers.mjs';
import { createCapabilities } from '../src/capabilities.mjs';
import { openStore } from '../src/store.mjs';
import estimate from '../extensions/estimate-blocks.mjs';

const profile = {id:'plan', provider:'chatgpt-plan', model:'example', baseUrl:'https://api.openai.com/v1',
  nativeTools:true, scope:'personal', tools:[estimate.name]};
const chat = [{role:'system', content:'Only use authorized tools.'}, {role:'user', content:'Divide 50 minutes into 20-minute blocks.'}];
const auth = {async credential() { return {profileId:'registration-one', accessToken:'fake-oauth'}; }};
const catalog = () => Response.json({models:[
  {slug:'example', display_name:'Example', visibility:'list'},
  {slug:'hidden', display_name:'Hidden', visibility:'hide'},
  {slug:'second', display_name:'Second', visibility:'list'}
]});
const call = {type:'function_call', status:'completed', name:estimate.name, namespace:'clockwork', id:'fc_1',
  call_id:'call_1', arguments:'{"minutes":50,"blockMinutes":20}'};
const completed = (output = []) => ({type:'response.completed', response:{status:'completed', output}});
const delta = text => ({type:'response.output_text.delta', delta:text});

function sse(...events) {
  const frames = events.map(event => 'event: ' + event.type + '\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n').join('');
  // Use one-byte chunks to cover splits inside Unicode, JSON, and CRLF.
  const bytes = new TextEncoder().encode(': ping\r\n\r\n' + frames + 'data: [DONE]\r\n\r\n');
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(index, ++index));
    }
  }), {headers:{'content-type':'text/event-stream; charset=utf-8'}});
}

function harness(...replies) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({url:String(url), ...options});
    if (String(url).endsWith('/models')) return catalog();
    const next = replies.shift();
    if (!next) throw new Error('Unexpected request.');
    return next();
  };
  return {requests, fetchImpl, plan:createPlanProvider({auth, fetchImpl})};
}

test('discovery uses the selected grant each time, filters visible slugs and preserves server order', async () => {
  let current = 'team-one';
  const requests = [];
  const plan = createPlanProvider({auth:{async credential({profileId}) {
    assert.equal(profileId, current);
    return {profileId:current, accessToken:'fake-' + current};
  }}, fetchImpl:async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    requests.push(options.headers.Authorization);
    return current === 'team-one' ? catalog() : Response.json({models:[]});
  }});
  assert.deepEqual(await plan.listModels({profileId:current}), [{slug:'example',display_name:'Example'},{slug:'second',display_name:'Second'}]);
  current = 'team-two';
  assert.deepEqual(await plan.listModels({profileId:current}), []);
  assert.deepEqual(requests, ['Bearer fake-team-one','Bearer fake-team-two']);
});

test('text waits for completed inference and uses only supported fields in a stateless public Responses request', async () => {
  const {plan, requests} = harness(() => sse(delta('ré'), delta('ussi'), completed()));
  assert.deepEqual(await plan.complete({...profile, nativeTools:false}, chat, [estimate]), {text:'réussi', calls:[]});
  const [models, stream] = requests;
  assert.equal(models.method, 'GET');
  assert.equal(stream.method, 'POST');
  assert.equal(stream.url, 'https://api.openai.com/v1/responses');
  assert.equal(stream.redirect, 'error');
  assert.equal(stream.headers.Authorization, 'Bearer fake-oauth');
  assert.deepEqual(JSON.parse(stream.body), {model:'example', instructions:chat[0].content,
    input:[chat[1]], store:false, stream:true});
});

test('one validated read tool round trip replays reasoning and matches function output by call_id', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const config = {profiles:[profile], policy:{grants:{plan:{scope:'personal', tools:profile.tools, permissions:estimate.permissions}}}};
  const capabilities = createCapabilities({db,config,extensions:[estimate],readCommitments:() => []});
  const tools = capabilities.list(profile);
  const reasoning = {type:'reasoning', id:'rs_1', summary:[], encrypted_content:'fake-opaque-reasoning'};
  const toolEvent = {type:'response.output_item.done', output_index:1, item:call};
  const {plan, requests} = harness(() => sse({type:'response.output_item.done', output_index:0, item:reasoning},
    toolEvent, completed()), () => sse(completed([{type:'message', role:'assistant', content:[{type:'output_text', text:'2 blocks, 10 minutes left.'}]}])));
  const first = await plan.complete(profile, chat, tools);
  const [{id, name, arguments:args}] = first.calls;
  const result = await capabilities.dispatch(profile, name, args, {allowedTools:tools.map(t => t.name)});
  assert.deepEqual(result, {blocks:2, remainingMinutes:10});
  const messages = [...chat, {role:'assistant', content:null, tool_calls:[{id}]},
    {role:'tool', tool_call_id:id, content:JSON.stringify(result)}];
  assert.deepEqual(await plan.complete(profile, messages, [], {continuation:first.continuation}),
    {text:'2 blocks, 10 minutes left.', calls:[]});
  assert.deepEqual(JSON.parse(requests[1].body).tools, [{type:'namespace', name:'clockwork',
    description:'Application tools available to this agent.', tools:[{type:'function', name:estimate.name,
      description:estimate.description, parameters:estimate.inputSchema, strict:false}]}]);
  assert.deepEqual(JSON.parse(requests[2].body), {model:'example', instructions:chat[0].content,
    input:[chat[1], reasoning, call, {type:'function_call_output', call_id:id, output:JSON.stringify(result)}], store:false, stream:true});
  assert.equal(JSON.stringify(first).includes('fake-opaque-reasoning'), false);
  await assert.rejects(plan.complete(profile, messages, [], {continuation:first.continuation}), /already finished/);
});

test('account switch, foreign namespace, unadvertised tool, malformed arguments and duplicate calls stop the turn', async () => {
  const {fetchImpl, requests} = harness(() => sse(completed([call])));
  let account = 'first';
  const plan = createPlanProvider({fetchImpl,auth:{async credential() { return {accessToken:'fake',profileId:account}; }}});
  const first = await plan.complete(profile, chat, [estimate]);
  account = 'second';
  await assert.rejects(plan.complete(profile, [{role:'tool',tool_call_id:'call_1',content:'private-result'}], [],
    {continuation:first.continuation}), /account changed/);
  assert.equal(requests.length, 2);
  for (const output of [[{...call, name:'forbidden'}], [{...call,namespace:'other'}], [{...call, arguments:'"test"'}],
    [{...call, arguments:'invalid'}], [call,call]]) {
    await assert.rejects(harness(() => sse(completed(output))).plan.complete(profile, chat, [estimate]), /invalid or unavailable tool/);
  }
  await assert.rejects(harness(() => sse(completed([call]))).plan.complete({...profile,nativeTools:false}, chat, [estimate]), /unavailable tool/);
});

test('incomplete, failed, interrupted and malformed streams never release partial text or partial calls', async () => {
  for (const [reply, expected] of [
    [() => sse(delta('partial'), {type:'response.incomplete'}), /incomplete/],
    [() => sse(delta('partial'), {type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}), /limit was reached/],
    [() => sse(delta('partial'), {type:'error',code:'subscription_sharing_usage_unavailable'}), /temporarily unavailable/],
    [() => sse(delta('partial'), {type:'response.output_item.done',output_index:0,item:call}), /interrupted/],
    [() => new Response('data: broken\n\n',{headers:{'content-type':'text/event-stream'}}), /invalid response stream/],
    [() => Response.json({fake:'message'}), /did not return an event stream/]
  ]) {
    const {plan} = harness(reply);
    await assert.rejects(plan.complete(profile, chat, [estimate]), expected);
  }
});

test('plan errors with a billed credential configured never read it, retry, or forward the diagnostic body', async () => {
  const {plan, requests} = harness(() => Response.json({error:{code:'subscription_sharing_unsupported_capability',
    param:'tools', message:'sensitive echoed user content'}}, {status:400, headers:{'x-request-id':'req_test'}}));
  let billedLookups = 0;
  const provider = createProvider({config:{localOnly:false}, planProvider:plan,
    fetchImpl:async () => { throw new Error('Unexpected billed transport.'); },
    credentialFor:() => { billedLookups++; return 'fake-billed'; }});
  await assert.rejects(provider.complete(profile, chat, [estimate]), error => {
    assert.equal(error.providerStatus, 400);
    assert.equal(error.requestId, 'req_test');
    assert.equal(error.providerCode, 'subscription_sharing_unsupported_capability');
    assert.equal(error.providerParam, 'tools');
    assert.match(error.message, /does not support/);
    assert.doesNotMatch(error.message, /sensitive|fake-billed/);
    return true;
  });
  assert.equal(billedLookups, 0);
  assert.deepEqual(requests.map(x => x.url), ['https://api.openai.com/v1/models', 'https://api.openai.com/v1/responses']);
  for (const status of [401,403,429,503]) {
    const {plan} = harness(() => Response.json({detail:'sensitive echoed user content'}, {status}));
    await assert.rejects(plan.complete(profile, chat), error => error.providerStatus === status &&
      error.bodyShape === 'detail' && !error.message.includes('sensitive'));
  }
});

test('local-only mode, missing permission, stale registrations and unlisted models stop before inference', async () => {
  let calls = 0;
  const local = createPlanProvider({localOnly:true, auth:{async credential() { calls++; }}, fetchImpl:async () => { calls++; }});
  await assert.rejects(local.listModels(), /local-only/);
  await assert.rejects(local.complete(profile, chat), /local-only/);
  const denied = createPlanProvider({auth:{async credential() { throw new Error('Plan permission required.'); }}, fetchImpl:async () => { calls++; }});
  await assert.rejects(denied.complete(profile, chat), /permission required/);
  assert.equal(calls, 0);
  const {plan, requests} = harness();
  await assert.rejects(plan.complete({...profile,planAccountId:null}, chat), /account changed/);
  await assert.rejects(plan.complete({...profile,planAccountId:'other'}, chat), /account changed/);
  assert.equal(requests.length, 0);
  await assert.rejects(plan.complete({...profile,model:'hidden'}, chat), /eligible model/);
  assert.deepEqual(requests.map(x => x.method), ['GET']);
});

test('admission rejection pauses the rejected bearer, permits token rotation and isolates diagnostics by account', async () => {
  let account = 'workspace-a';
  let token = 'fake-rejected';
  const {fetchImpl, requests} = harness(() => Response.json({detail:'untrusted admission diagnostic'}, {status:401}),
    () => sse(delta('OK after rotation'), completed()));
  const plan = createPlanProvider({fetchImpl, auth:{async credential() { return {profileId:account, accessToken:token}; }}});
  await assert.rejects(plan.complete(profile, chat), /rejected/);
  const diagnosis = plan.lastIssue(account);
  assert.equal(diagnosis.kind, 'access');
  assert.doesNotMatch(JSON.stringify(diagnosis), /fake-rejected|untrusted/);
  await assert.rejects(plan.listModels(), /rejected/);
  assert.equal(requests.length, 2);
  account = 'workspace-b';
  assert.equal(plan.lastIssue(account), null);
  assert.equal((await plan.listModels()).length, 2);
  account = 'workspace-a';
  token = 'fake-renewed';
  assert.equal((await plan.complete(profile, chat)).text, 'OK after rotation');
  assert.equal(plan.lastIssue(account), null);
  const {plan: outage} = harness(() => sse({type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}));
  await assert.rejects(outage.complete(profile, chat), /limit was reached/);
  assert.equal(outage.lastIssue('registration-one').kind, 'request');
  assert.equal((await outage.listModels()).length, 2);
  outage.clearIssue('registration-one');
  assert.equal(outage.lastIssue('registration-one'), null);
});
