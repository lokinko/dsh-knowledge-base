import assert from 'node:assert/strict';
import test from 'node:test';
import {renderDocument,renderMarkdown,getMarkdownHeadings,setMarkdownTaskAt,setMarkdownTask} from '../../src/client/markdown/renderer.js';
import {createRenderService} from '../../src/client/markdown/render-service.js';
import {handleRenderRequest} from '../../src/client/markdown/render-worker.js';

const fixture='# Header\r\n\r\n> ## Nested\r\n> [reference][ref]\r\n\r\n- [ ] parent\r\n  - [X] child\r\n\r\n| A | B |\r\n| - | - |\r\n| $x^2$ | **bold** |\r\n\r\n```js\r\nconst value = 1;\r\n```\r\n\r\n[ref]: https://example.com/path\r\n';
test('single parse block rendering retains full document semantics and raw task positions',()=>{
  const document=renderDocument(fixture,{headingPrefix:'doc'});
  assert.equal(document.blocks.map(block=>block.html).join(''),renderMarkdown(fixture,{headingPrefix:'doc'}));
  assert.deepEqual(document.headings,getMarkdownHeadings(fixture));
  assert.deepEqual(document.blocks.flatMap(block=>block.headingIndices),[0,1]);
  for(const block of document.blocks){assert.ok(block.heightEstimate>0);assert.ok(block.sourceEnd>=block.sourceStart);}
  for(let index=0;index<2;index++)assert.equal(setMarkdownTaskAt(fixture,document.taskPositions,index,index===0),setMarkdownTask(fixture,index,index===0));
  assert.equal(setMarkdownTaskAt(fixture,document.taskPositions,300,true),fixture);
  assert.equal(setMarkdownTaskAt(fixture,[1],0,true),fixture);
  assert.ok(document.blocks.map(block=>block.html).join('').includes('href="https://example.com/path"'));
});

test('large ordered lists batch complete items, continue numbering and retain nested tasks',()=>{
  const source=Array.from({length:123},(_,index)=>`${index+7}. [ ] Item ${index}\n    - nested **${index}**`).join('\n');
  const document=renderDocument(source);
  assert.equal(document.blocks.length,4);
  assert.deepEqual(document.blocks.map(block=>/<ol(?: start="(\d+)")?/.exec(block.html)?.[1]||'1'),['7','47','87','127']);
  assert.equal(document.taskPositions.length,123);
  const html=document.blocks.map(block=>block.html).join('');
  assert.equal((html.match(/class="task-list-item-checkbox"/g)||[]).length,123);
  assert.equal((html.match(/<strong>/g)||[]).length,123);
  for(const block of document.blocks){assert.equal((block.html.match(/<ol/g)||[]).length,(block.html.match(/<\/ol>/g)||[]).length);assert.equal((block.html.match(/<ul/g)||[]).length,(block.html.match(/<\/ul>/g)||[]).length);}
  assert.equal(setMarkdownTaskAt(source,document.taskPositions,122,true),source.replace('129. [ ]','129. [x]'));
});

test('worker protocol renders safe output and headings without browser globals',()=>{
  const response=handleRenderRequest({id:17,kind:'render',source:fixture,options:{headingPrefix:'worker'}});
  assert.equal(response.id,17);assert.deepEqual(response.value,renderDocument(fixture,{headingPrefix:'worker'}));
  assert.deepEqual(handleRenderRequest({id:18,kind:'headings',source:fixture}).value,getMarkdownHeadings(fixture));
  const unsafe=handleRenderRequest({id:19,kind:'render',source:'<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))'}).value.blocks.map(block=>block.html).join('');
  assert.ok(!unsafe.includes('<img src=x'));assert.ok(!unsafe.includes('href="javascript:'));
});

function fakeWorker(){
  return {messages:[],terminated:false,postMessage(message){this.messages.push(message);},terminate(){this.terminated=true;},respond(index){this.onmessage({data:handleRenderRequest(this.messages[index])});}};
}
test('card previews use the worker even for short excerpts, reuse results and isolate document semantics',async()=>{
 const worker=fakeWorker(),service=createRenderService({createWorker:()=>worker}),consumer={};
 const first=service.card('# Same\n\n$x^2$',{consumer,title:'Same'});
 assert.equal(worker.messages.length,1);assert.equal(worker.messages[0].kind,'card');
 assert.equal(service.card('# Same\n\n$x^2$',{consumer,title:'Same'}),first);
 worker.respond(0);const html=await first;assert.match(html,/katex/);assert.doesNotMatch(html,/<h1>/);
 const changed=service.card('# Same\n\n$x^2$',{consumer,title:'Other'});worker.respond(1);assert.match(await changed,/<h1>/);
 service.cancel(consumer);service.dispose();
 const local=createRenderService({createWorker(){throw new Error('Blocked worker');}});
 assert.match(await local.card('$x^2$'),/katex/);local.dispose();
});
test('service coalesces queued edits, ignores unrelated ids and reuses current render headings',async()=>{
  const worker=fakeWorker(),service=createRenderService({threshold:1,createWorker:()=>worker});
  const first=service.render('# First'),superseded=service.render('# Superseded');
  const discarded=assert.rejects(superseded,{name:'AbortError'});
  const second=service.render('# Second'),headings=service.headings('# Second');
  assert.equal(worker.messages.length,1);
  worker.onmessage({data:{id:999,value:{}}});assert.equal(worker.messages.length,1);
  worker.respond(0);assert.equal(worker.messages.length,2);worker.respond(1);
  assert.equal((await first).headings[0].title,'First');assert.equal((await second).headings[0].title,'Second');
  assert.equal((await headings)[0].title,'Second');await discarded;service.dispose();assert.ok(worker.terminated);
});

test('consumer channels isolate queued previews and replacements preserve FIFO fairness',async()=>{
  const worker=fakeWorker(),service=createRenderService({threshold:1,createWorker:()=>worker});
  const a=Symbol('main preview'),b={name:'history'};
  const first=service.render('# A1',{consumer:a});
  const second=service.render('# A2',{consumer:a});
  const discarded=assert.rejects(second,{name:'AbortError'});
  const history=service.render('# B',{consumer:b});
  // B joins independently. Only another edit in channel A can supersede A2.
  const third=service.render('# A3',{consumer:a});
  await discarded;assert.equal(worker.messages.length,1);
  worker.respond(0);assert.equal(worker.messages[1].source,'# B');
  worker.respond(1);assert.equal(worker.messages[2].source,'# A3');worker.respond(2);
  assert.equal((await first).headings[0].title,'A1');
  assert.equal((await history).headings[0].title,'B');assert.equal((await third).headings[0].title,'A3');
  assert.ok(!('consumer' in worker.messages[0].options));service.dispose();
});

test('history arriving after a queued main edit cannot strand the main preview',async()=>{
  const worker=fakeWorker(),service=createRenderService({threshold:1,createWorker:()=>worker});
  const a={},b={};
  const first=service.render('# A1',{consumer:a}),main=service.render('# A2',{consumer:a}),history=service.render('# B',{consumer:b});
  worker.respond(0);assert.equal(worker.messages[1].source,'# A2');
  worker.respond(1);assert.equal(worker.messages[2].source,'# B');worker.respond(2);
  assert.equal((await main).headings[0].title,'A2');await first;await history;service.dispose();
});

test('cancel removes only its consumer queue and active result still releases the worker slot',async()=>{
  const worker=fakeWorker(),service=createRenderService({threshold:1,createWorker:()=>worker});
  const a={},b={},c={};
  const active=service.render('# active A',{consumer:a}),queued=service.render('# queued A',{consumer:a});
  const activeCancelled=assert.rejects(active,{name:'AbortError'}),queuedCancelled=assert.rejects(queued,{name:'AbortError'});
  const history=service.render('# history B',{consumer:b}),outline=service.headings('# outline C',{consumer:c});
  service.cancel(a);assert.equal(worker.messages.length,1);
  worker.respond(0);assert.equal(worker.messages[1].source,'# history B');
  worker.respond(1);assert.equal(worker.messages[2].kind,'headings');worker.respond(2);
  await activeCancelled;await queuedCancelled;assert.equal((await history).headings[0].title,'history B');assert.equal((await outline)[0].title,'outline C');
  const again=service.render('# queued A',{consumer:a});worker.respond(3);assert.equal((await again).headings[0].title,'queued A');service.dispose();
});

test('identical documents in different consumers do not share cancellation or poisoned cache entries',async()=>{
  const worker=fakeWorker(),service=createRenderService({threshold:1,createWorker:()=>worker}),a={},b={};
  const first=service.render('# Same',{consumer:a}),second=service.render('# Same',{consumer:b});
  const cancelled=assert.rejects(second,{name:'AbortError'});service.cancel(b);worker.respond(0);await first;await cancelled;
  assert.equal(worker.messages.length,1);
  const retry=service.render('# Same',{consumer:b});worker.respond(1);assert.equal((await retry).headings[0].title,'Same');service.dispose();
  const local=createRenderService(),consumer={};const pending=local.render('# Local',{consumer});local.cancel(consumer);await assert.rejects(pending,{name:'AbortError'});local.dispose();
});

test('worker failure safely falls back and disposal rejects pending requests',async()=>{
  const worker=fakeWorker(),service=createRenderService({threshold:1,createWorker:()=>worker});
  const render=service.render(fixture);worker.onerror();
  assert.deepEqual(await render,renderDocument(fixture));assert.ok(worker.terminated);service.dispose();
  const another=fakeWorker(),closed=createRenderService({threshold:1,createWorker:()=>another});
  const pending=closed.render('# pending');closed.dispose();
  await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(closed.render('# after disposal'),{name:'AbortError'});
});

test('small documents bypass worker startup and unavailable workers keep the same semantics',async()=>{
  let starts=0;const service=createRenderService({createWorker:()=>{starts++;throw Error('CSP');}});
  assert.deepEqual(await service.render(fixture),renderDocument(fixture));assert.equal(starts,0);
  const large=fixture.repeat(150);assert.deepEqual(await service.render(large),renderDocument(large));assert.equal(starts,1);service.dispose();
});
