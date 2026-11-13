import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerDraftDriver,serveDraftDriver} from '../../src/client/notes/idb-draft-driver.js';

// A Worker pair connected through structuredClone, as real postMessage would be.
function workerPair(driverFactory){
 const scope={indexedDB:{marker:'worker-idb'},closed:false,close(){this.closed=true;}};
 const worker={terminated:false,onmessage:null,onerror:null,
  postMessage(message){const data=structuredClone(message);queueMicrotask(()=>scope.onmessage?.({data}));},
  terminate(){this.terminated=true;}};
 scope.postMessage=message=>{const data=structuredClone(message);queueMicrotask(()=>{if(!worker.terminated)worker.onmessage?.({data});});};
 serveDraftDriver(scope,{driverFactory});
 return {scope,worker};
}

test('worker draft driver proxies load, get and commit with cloned payloads', async () => {
 const stored=new Map(),opened=[];
 const {scope,worker}=workerPair(async options=>{
  opened.push({database:options.databaseName,idb:options.indexedDBGetter()});
  return {load:async()=>[...stored.values()],get:async key=>stored.get(key),close(){},
   commit:async operations=>operations.map(operation=>{stored.set(operation.record.key,operation.record);return {type:'put',key:operation.record.key,raw:operation.record.raw,accepted:true};})};
 });
 const driver=await createWorkerDraftDriver({createWorker:()=>worker,databaseName:'drafts-test'});
 assert.deepEqual(opened,[{database:'drafts-test',idb:{marker:'worker-idb'}}]);
 const record={key:'k',raw:'v2:1',fields:{content:'a\r\nb'.repeat(1000),tags:['x']}};
 assert.deepEqual(await driver.commit([{type:'put',record}]),[{type:'put',key:'k',raw:'v2:1',accepted:true}]);
 assert.notEqual(stored.get('k'),record,'the worker receives a structured clone');
 assert.deepEqual(await driver.get('k'),record);
 assert.deepEqual(await driver.load(),[record]);
 driver.close();
 assert.equal(worker.terminated,true);
 await assert.rejects(driver.get('k'),{name:'InvalidStateError'});
 assert.equal(scope.closed,true);
});

test('worker draft driver keeps remote error names and falls back before opening', async () => {
 const {worker}=workerPair(async()=>({load:async()=>[],get:async()=>{throw Object.assign(new Error('closing'),{name:'InvalidStateError'});},commit:async()=>[],close(){}}));
 const driver=await createWorkerDraftDriver({createWorker:()=>worker});
 await assert.rejects(driver.get('k'),{name:'InvalidStateError',message:'closing'});

 const local={load:async()=>['local'],get:async()=>null,commit:async()=>[],close(){}};
 const unavailable=await createWorkerDraftDriver({createWorker:()=>{throw new Error('CSP forbids blob workers');},fallback:async()=>local});
 assert.equal(unavailable,local);
 const {worker:broken}=workerPair(async()=>{throw new Error('IndexedDB unavailable in worker');});
 const fallen=await createWorkerDraftDriver({createWorker:()=>broken,fallback:async error=>{assert.match(error.message,/unavailable in worker/);return local;}});
 assert.equal(fallen,local);
 assert.equal(broken.terminated,true);
});

test('a crashed draft worker rejects in-flight work as a closed connection', async () => {
 let release;
 const {worker}=workerPair(async()=>({load:async()=>[],get:()=>new Promise(resolve=>{release=resolve;}),commit:async()=>[],close(){}}));
 const driver=await createWorkerDraftDriver({createWorker:()=>worker});
 const pending=driver.get('k');
 await new Promise(resolve=>setTimeout(resolve,0));
 worker.onerror({message:'worker crashed',preventDefault(){}});
 await assert.rejects(pending,{name:'InvalidStateError',message:'worker crashed'});
 await assert.rejects(driver.commit([]),{name:'InvalidStateError'});
 release?.(null);
});
