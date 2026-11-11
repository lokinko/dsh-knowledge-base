// Manual algorithm-cost benchmark, not a measurement of browser localStorage.
// Run: node tests/performance/client-drafts.bench.mjs
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {NoteDraftCache,NoteEditSession} from '../../src/client/notes/edit-session.js';

function memoryStorage(){
 const values=new Map();
 return {writes:0,bytes:0,get length(){return values.size;},key:index=>[...values.keys()][index]??null,getItem:key=>values.get(key)??null,setItem(key,value){this.writes++;this.bytes+=Buffer.byteLength(value);values.set(key,value);},removeItem:key=>values.delete(key)};
}
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
for(const size of [100_000,1_000_000,5_000_000]){
 const storage=memoryStorage(),cache=new NoteDraftCache({storageGetter:()=>storage});
 const original='正文🙂\r\n'.repeat(Math.ceil(size/6)).slice(0,size);
 const session=new NoteEditSession({note:{id:'benchmark',revision:1,title:'Long note',content:original},writerId:'benchmark-writer',cache,save:async()=>{throw new Error('Benchmark must not call server');},paused:true});
 const samples=[];
 for(let index=0;index<25;index++){
  const content=original+'\n'+index;
  const before=performance.now();session.change({content});samples.push(performance.now()-before);
  assert.equal(new NoteDraftCache({storageGetter:()=>storage}).latest('benchmark').fields.content,content);
  assert.equal(session.snapshot().cacheDurable,true);
 }
 assert.equal(storage.writes,25);
 console.log(JSON.stringify({utf16Characters:size,samples:samples.length,p50Ms:+percentile(samples,.5).toFixed(3),p95Ms:+percentile(samples,.95).toFixed(3),jsonUtf8Bytes:storage.bytes,writes:storage.writes,measurement:'synchronous validation, JSON serialization and in-memory storage only; excludes browser localStorage I/O and rendering'}));
 session.abandon();
}
