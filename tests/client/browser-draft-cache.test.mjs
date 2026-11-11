import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserNoteDraftCache} from '../../src/client/notes/browser-draft-cache.js';
import {NoteDraftCache,NoteEditSession,noteDraftKey} from '../../src/client/notes/edit-session.js';

const fields=(content='original')=>({title:'Title',content,category:'document',tags:['one'],pinned:false,journalDate:''});
const note=()=>({id:'note',revision:3,...fields(),updatedAt:'2026-01-01T00:00:00Z'});
const input=(content='changed',writerId='writer')=>({noteId:'note',writerId,baseRevision:3,fields:fields(content)});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turns=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
class Storage{
 data=new Map();reads=0;scans=0;writes=0;failRead=false;failWrite=false;
 get length(){if(this.failRead)throw new Error('legacy read blocked');return this.data.size;}
 key(index){this.scans++;return [...this.data.keys()][index]??null;}
 getItem(key){this.reads++;if(this.failRead)throw new Error('legacy read blocked');return this.data.get(key)??null;}
 setItem(key,value){this.writes++;if(this.failWrite)throw new Error('legacy quota');this.data.set(key,value);}
 removeItem(key){this.data.delete(key);}
}
class Timers{
 jobs=new Map();next=0;
 set=(fn,delay)=>{const id=this.next++;this.jobs.set(id,{fn,delay});return id;};
 clear=id=>this.jobs.delete(id);
 tick(){for(const [id,{fn}] of [...this.jobs]){this.jobs.delete(id);fn();}}
}
function database(){
 const records=new Map(),calls=[];let holding=false,failures=0,loadError=null;
 const waiting=[];
 function apply(operations){
  if(failures){failures--;throw new Error('IDB quota');}
  const next=new Map([...records].map(([key,value])=>[key,structuredClone(value)])),outcomes=[];
  for(const operation of operations){
   const key=operation.key||operation.record.key,old=next.get(key);
   if(operation.type==='remove'){
    const accepted=!old||old.raw===operation.raw;if(accepted)next.delete(key);
    outcomes.push({type:'remove',key,raw:operation.raw,accepted});
   }else{
    const record=operation.record,accepted=!old||record.updatedAt>old.updatedAt||(record.updatedAt===old.updatedAt&&record.raw>=old.raw);
    if(accepted)next.set(key,structuredClone(record));outcomes.push({type:'put',key,raw:record.raw,accepted});
   }
  }
  records.clear();for(const entry of next)records.set(...entry);return outcomes;
 }
 const driver={load:async()=>{if(loadError)throw loadError;return [...records.values()].map(value=>structuredClone(value));},get:async key=>structuredClone(records.get(key)),close(){},commit(operations){calls.push(operations);if(!holding)return Promise.resolve().then(()=>apply(operations));const gate=deferred();waiting.push({gate,operations});return gate.promise;}};
 return {records,calls,driver,get waiting(){return waiting.length;},hold(value=true){holding=value;},fail(){failures++;},failLoad(){loadError=new Error('IDB read failed');},recoverLoad(){loadError=null;},release(){const next=waiting.shift();assert(next,'a transaction must be waiting');try{next.gate.resolve(apply(next.operations));}catch(error){next.gate.reject(error);}}};
}
let nextToken=0;
function setup({db=database(),storage=new Storage(),...options}={}){
 const timers=new Timers();
 const cache=new BrowserNoteDraftCache({storageGetter:()=>storage,driverFactory:async()=>db.driver,setTimer:timers.set,clearTimer:timers.clear,tokenFactory:()=>String(++nextToken),channelFactory:()=>null,eventTarget:null,...options});
 return {cache,db,storage,timers};
}
function session(cache,{save=async payload=>({ok:true,note:{id:payload.id,revision:payload.revision+1}}),writerId='writer',paused=false}={}){
 const timers=new Timers();return new NoteEditSession({note:note(),cache,save,paused,writerId,setTimer:timers.set,clearTimer:timers.clear});
}

test('body edits coalesce without JSON serialization or repeated legacy scans; durability follows commit',async()=>{
 const {cache,db,storage,timers}=setup();await cache.ready;
 const baseline={reads:storage.reads,scans:storage.scans};
 const body='正文🙂\r\n'.repeat(250000),stringify=JSON.stringify;let final;
 JSON.stringify=()=>{throw new Error('whole-body JSON must not run');};
 try{
  for(let i=0;i<30;i++){final=cache.write(input(body+i));assert.equal(cache.latest('note').fields.content,body+i);assert.equal(cache.records().length,1);}
 }finally{JSON.stringify=stringify;}
 assert.equal(final.volatile,true);assert.equal(final.pending,true);assert.equal(timers.jobs.size,1);assert.equal(db.calls.length,0);
 assert.deepEqual({reads:storage.reads,scans:storage.scans},baseline);assert.equal(storage.writes,0);
 assert.equal(await cache.flush(),true);assert.equal(db.calls.length,1);assert.equal(db.calls[0].length,1);
 assert.equal(cache.latest('note').raw,final.raw);assert.equal(cache.latest('note').volatile,false);
 assert.equal(db.records.get(final.key).fields.content,body+29);
 const recovered=setup({db,storage});await recovered.cache.ready;assert.equal(recovered.cache.latest('note').fields.content,body+29);
 await recovered.cache.close();await cache.close();
});

test('failed transaction retains exact memory text, honest durability and explicit retry recovery',async()=>{
 const {cache,db,timers}=setup();await cache.ready;db.fail();
 const record=cache.write(input('  # raw\r\n中文🙂\u0000\t\\literal  '));
 assert.equal(await cache.flush(),false);const failed=cache.pending('note','writer');
 assert.equal(failed.raw,record.raw);assert.equal(failed.fields.content,record.fields.content);assert.equal(failed.volatile,true);assert.equal(failed.pending,false);assert.match(failed.error,/quota/);
 assert.equal(timers.jobs.size,0,'a failure must not create an infinite retry loop');
 assert.equal(await cache.retry(),true);assert.equal(cache.latest('note').volatile,false);
 assert.equal(db.records.get(record.key).fields.content,record.fields.content);await cache.close();
});

test('an old commit cannot mark a newer generation durable or replace its fields',async()=>{
 const {cache,db}=setup();await cache.ready;db.hold();const editor=session(cache);
 editor.change({content:'first'});const first=cache.latest('note'),firstCommit=cache.flush();await turns();
 editor.change({content:'second'});const second=cache.latest('note');
 db.release();await turns();
 assert.equal(db.waiting,1);assert.equal(editor.snapshot().fields.content,'second');assert.equal(editor.snapshot().cacheDurable,false);assert.equal(editor.snapshot().cachePending,true);
 assert.notEqual(first.raw,second.raw);db.release();await firstCommit;
 assert.equal(editor.snapshot().cacheDurable,true);assert.equal(editor.snapshot().cachePending,false);assert.equal(cache.latest('note').raw,second.raw);
 editor.abandon();db.hold(false);await cache.close();
});

test('remove before a queued put cancels it, and remove during flight is CAS-cleaned after commit',async()=>{
 const {cache,db}=setup();await cache.ready;
 const queued=cache.write(input('queued'));cache.remove(queued);await cache.flush();assert.equal(db.records.has(queued.key),false);
 db.hold();const flying=cache.write(input('flying')),work=cache.flush();await turns();cache.remove(flying);
 db.release();await turns();assert.equal(cache.records().length,0);assert.equal(db.waiting,1);
 db.release();await work;assert.equal(db.records.has(flying.key),false);
 db.hold(false);await cache.close();
});

test('raw-guard cleanup cannot delete a newer same-writer snapshot, and writers remain separate',async()=>{
 const {cache,db}=setup();await cache.ready;
 const old=cache.write(input('old')),newer=cache.write(input('new'));
 cache.remove(old);cache.write(input('other writer','other'));await cache.flush();
 assert.equal(db.records.get(newer.key).raw,newer.raw);assert.equal(cache.records().length,2);
 cache.remove(newer);
 const external={...db.records.get(newer.key),raw:'v2:external',updatedAt:'2999-01-01T00:00:00.000Z'};db.records.set(newer.key,external);
 await cache.flush();assert.equal(db.records.get(newer.key).raw,external.raw);assert.equal(db.records.has(noteDraftKey('note','other')),true);
 await cache.close();
});

test('legacy drafts recover once and are preserved until a replacement IDB transaction succeeds',async()=>{
 const storage=new Storage(),legacy=new NoteDraftCache({storageGetter:()=>storage});
 const source=legacy.write(input('legacy body'));
 const {cache,db}=setup({storage});await cache.ready;
 assert.equal(cache.latest('note').raw,source.raw);assert.equal(cache.latest('note').fields.content,'legacy body');
 db.fail();const replacement=cache.write(input('IDB replacement'));
 await cache.flush();assert.equal(storage.getItem(source.key),source.raw);
 await cache.retry();assert.equal(storage.getItem(source.key),null);assert.equal(db.records.get(source.key).raw,replacement.raw);
 await cache.close();
});

test('IDB opening failure uses a durable legacy fallback, including writes accepted during initialization',async()=>{
 const opening=deferred(),storage=new Storage();const {cache}=setup({storage,driverFactory:()=>opening.promise});
 const pending=cache.write(input('typed before initialization'));opening.reject(new Error('IDB unavailable'));await cache.ready;
 assert.equal(cache.latest('note').raw,pending.raw);assert.equal(cache.latest('note').volatile,false);
 const next=cache.write(input('synchronous fallback'));
 assert.equal(next.volatile,false);assert.equal(next.pending,false);
 const recovered=new NoteDraftCache({storageGetter:()=>storage});assert.equal(recovered.latest('note').fields.content,'synchronous fallback');
 cache.remove(next);assert.equal(storage.getItem(next.key),null);await cache.close();
});

test('fallback recovery exposes an incomplete-IDB warning and retry migrates without changing the captured raw token',async()=>{
 const db=database();let available=false;
 const {cache,storage}=setup({db,driverFactory:async()=>{if(!available)throw new Error('IDB temporarily blocked');return db.driver;}});
 await cache.ready;assert.match(cache.recoveryWarning,/existing IndexedDB drafts/);
 const record=cache.write(input('durable legacy fallback'));assert.equal(record.volatile,false);
 available=true;assert.equal(await cache.retry(),true);assert.equal(cache.recoveryWarning,null);
 assert.equal(cache.latest('note').raw,record.raw);assert.equal(db.records.get(record.key).raw,record.raw);
 cache.remove(record);await cache.flush();assert.equal(cache.records().length,0);assert.equal(storage.getItem(record.key),null);await cache.close();
});

test('unavailable fallback remains visible as volatile and recovers after localStorage becomes writable',async()=>{
 const storage=new Storage();storage.failWrite=true;
 const {cache}=setup({storage,driverFactory:async()=>{throw new Error('IDB unavailable');}});await cache.ready;
 const failed=cache.write(input('keep me'));assert.equal(failed.volatile,true);assert.equal(failed.pending,false);
 assert.equal(await cache.flush(),false);storage.failWrite=false;assert.equal(await cache.retry(),true);
 assert.equal(cache.latest('note').fields.content,'keep me');assert.equal(cache.latest('note').volatile,false);await cache.close();
});

test('initial database read failure rejects ready instead of presenting an empty recovered library',async()=>{
 const db=database();db.failLoad();const {cache}=setup({db});
 await assert.rejects(cache.ready,/IDB read failed/);assert.throws(()=>cache.records(),/IDB read failed/);
 const record=cache.write(input('new input survives'));assert.equal(record.volatile,true);assert.equal(record.pending,false);assert.equal(cache.records()[0].fields.content,'new input survives');
 assert.equal(await cache.flush(),false);
 db.recoverLoad();assert.equal(await cache.retry(),true);assert.equal(cache.latest('note').volatile,false);assert.equal(db.records.get(record.key).fields.content,'new input survives');await cache.close();
});

test('all-storage initialization failure rejects recovery while retaining future input in memory',async()=>{
 const storage=new Storage();storage.failRead=true;
 const {cache}=setup({storage,driverFactory:async()=>{throw new Error('IDB blocked');}});
 await assert.rejects(cache.ready,/Draft recovery failed/);assert.throws(()=>cache.records(),/Draft recovery failed/);
 const record=cache.write(input('memory only'));assert.equal(record.volatile,true);assert.equal(record.pending,false);await cache.close();
});

test('server acknowledgment cancels pending local snapshots without letting late commits revive saved drafts',async()=>{
 const {cache,db}=setup();await cache.ready;db.hold();const editor=session(cache);
 editor.change({content:'server saves exact text'});const local=cache.flush();await turns();
 assert.equal(await editor.flush(),true);assert.equal(editor.snapshot().cacheDurable,true);assert.equal(editor.snapshot().cachePending,false);assert.equal(cache.records().length,0);
 db.release();await turns();db.release();await local;assert.equal(db.records.size,0);
 editor.abandon();db.hold(false);await cache.close();
});

test('server-saving a newer pending draft also removes observed older IDB and in-flight snapshots',async()=>{
 for(const inFlight of [false,true]){
  const {cache,db}=setup();await cache.ready;const editor=session(cache);
  editor.change({content:'older durable snapshot'});await cache.flush();
  let work;
  if(inFlight){db.hold();editor.change({content:'intermediate in-flight snapshot'});work=cache.flush();await turns();}
  editor.change({content:'newest server snapshot before IDB'});assert.equal(await editor.flush(),true);assert.equal(cache.records().length,0);
  if(inFlight){db.release();await turns();db.release();await work;db.hold(false);}else await cache.flush();
  assert.equal(db.records.size,0,'no superseded snapshot may reappear on reload');
  const recovered=setup({db});await recovered.cache.ready;assert.deepEqual(recovered.cache.records(),[]);await recovered.cache.close();
  editor.abandon();await cache.close();
 }
});

test('async durability notifications preserve remote conflicts and offline save errors',async()=>{
 for(const mode of ['conflict','offline']){
  const {cache}=setup();await cache.ready;
  const editor=session(cache,{save:async()=>{throw new Error('remote offline');}});editor.change({content:'local exact'});
  if(mode==='conflict')editor.receiveRemote({...note(),revision:7,content:'remote edit'});else await editor.flush();
  const before=editor.snapshot();assert.equal(before.cacheDurable,false);await cache.flush();const after=editor.snapshot();
  assert.equal(after.cacheDurable,true);assert.equal(after.status,before.status);assert.deepEqual(after.error,before.error);assert.deepEqual(after.conflict,before.conflict);assert.equal(after.fields.content,'local exact');
  editor.abandon();await cache.close();
 }
});

test('cross-tab commit notifications update memory indexes and never replace pending local input',async()=>{
 const channels=new Set(),channelFactory=()=>{const channel={onmessage:null,postMessage(data){for(const other of channels)if(other!==channel)queueMicrotask(()=>other.onmessage?.({data}));},close(){channels.delete(channel);}};channels.add(channel);return channel;};
 const db=database(),first=setup({db,channelFactory}),second=setup({db,channelFactory});await Promise.all([first.cache.ready,second.cache.ready]);
 const record=first.cache.write(input('from first tab','first-writer'));await first.cache.flush();await turns();
 assert.equal(second.cache.latest('note').fields.content,'from first tab');
 const local=second.cache.write(input('pending local','second-writer'));
 first.cache.write(input('another remote edit','first-writer'));await first.cache.flush();await turns();
 assert.equal(second.cache.pending('note','second-writer').raw,local.raw);
 assert.equal(second.cache.records().find(value=>value.writerId==='second-writer').fields.content,'pending local');
 first.cache.remove(first.cache.records().find(value=>value.writerId==='first-writer'));await first.cache.flush();await turns();
 assert.equal(second.cache.records().some(value=>value.key===record.key),false);assert.equal(second.cache.records().length,1);
 await second.cache.flush();await first.cache.close();await second.cache.close();assert.equal(channels.size,0);
});

test('a failed cleanup is retried explicitly without resurrecting the record or looping timers',async()=>{
 const {cache,db,timers}=setup();await cache.ready;
 const record=cache.write(input('saved remotely'));await cache.flush();cache.remove(record);db.fail();
 assert.equal(await cache.flush(),false);assert.equal(cache.records().length,0);assert.equal(timers.jobs.size,0);assert.equal(db.records.has(record.key),true);
 assert.equal(await cache.retry(),true);assert.equal(db.records.has(record.key),false);await cache.close();
});

test('opening and pausing many large editors keeps global cache listeners bounded',async()=>{
 const {cache}=setup();await cache.ready;
 for(let index=0;index<24;index++){
  const editor=session(cache,{paused:true,writerId:'large-'+index});
  assert.equal(cache._listeners.size,0,'a constructor awaiting mount must not bind');
  editor.start();editor.start();assert.equal(cache._listeners.size,1);
  editor.change({content:'large raw body\r\n'.repeat(130000)+index});
  const paused=editor.pause();assert.equal(cache._listeners.size,0,'pause must release the global closure immediately');
  await paused;assert.equal(cache._listeners.size,0);await cache.flush();
 }
 assert.equal(cache._listeners.size,0);await cache.close();
});

test('resume reconciles a commit missed during pause without retaining the editor or losing offline state',async()=>{
 const {cache}=setup();await cache.ready;
 const editor=session(cache,{save:async()=>{throw new Error('server offline');}});
 editor.change({content:'pending before close'});assert.equal(editor.snapshot().cachePending,true);
 await editor.pause();assert.equal(cache._listeners.size,0);
 await cache.flush();assert.equal(editor.snapshot().cacheDurable,false,'a paused session receives no cache callbacks');
 const notices=[];editor.subscribe(value=>notices.push(value));
 const resumed=editor.start();assert.equal(cache._listeners.size,1);assert.equal(resumed.cacheDurable,true);assert.equal(resumed.cachePending,false);assert.equal(resumed.status,'offline');assert.match(resumed.error.message,/server offline/);
 const count=notices.length;editor.start();assert.equal(cache._listeners.size,1);assert.equal(notices.length,count,'repeated setup neither rebinds nor repeats a state notification');
 editor.change({content:'new edit after resume'});await cache.flush();assert.equal(editor.snapshot().cacheDurable,true);
 editor.abandon();assert.equal(cache._listeners.size,0);await cache.close();
});

test('StrictMode pause then start during a server request binds exactly once and receives the current commit',async()=>{
 const {cache}=setup();await cache.ready;const response=deferred();let saves=0;
 const editor=session(cache,{save:()=>{saves++;return response.promise;}});
 editor.change({content:'in-flight text'});const paused=editor.pause();assert.equal(cache._listeners.size,0);
 editor.start();editor.start();assert.equal(cache._listeners.size,1);await turns();assert.equal(saves,1);
 await cache.flush();assert.equal(editor.snapshot().cacheDurable,true);assert.equal(editor.snapshot().cachePending,false);assert.equal(editor.snapshot().status,'saving');
 response.reject(new Error('server unavailable'));assert.equal(await paused,false);assert.equal(editor.snapshot().status,'offline');
 await editor.pause();assert.equal(cache._listeners.size,0);editor.start();assert.equal(cache._listeners.size,1);assert.equal(editor.snapshot().cacheDurable,true);
 editor.abandon();await cache.close();
});

test('resume reconciles a failed paused transaction and retry notifications still reach only the active session',async()=>{
 const {cache,db}=setup();await cache.ready;
 const editor=session(cache,{save:async()=>{throw new Error('offline');}});editor.change({content:'recover after quota'});await editor.pause();
 db.fail();await cache.flush();assert.equal(cache._listeners.size,0);
 editor.start();assert.equal(editor.snapshot().cacheDurable,false);assert.equal(editor.snapshot().cachePending,false);
 await cache.retry();assert.equal(editor.snapshot().cacheDurable,true);assert.equal(editor.snapshot().cachePending,false);assert.equal(cache._listeners.size,1);
 editor.abandon();await cache.close();
});

test('stop and abandon detach immediately and cannot acquire new global cache subscriptions',async()=>{
 for(const operation of ['stop','abandon']){
  const {cache}=setup();await cache.ready;const response=deferred();const editor=session(cache,{save:()=>response.promise});
  editor.change({content:'retired editor'});assert.equal(cache._listeners.size,1);
  const result=editor[operation]();assert.equal(cache._listeners.size,0);editor.start();assert.equal(cache._listeners.size,0);
  response.resolve({ok:true,note:{id:'note',revision:4}});await result;await cache.flush();editor.start();assert.equal(cache._listeners.size,0);
  await cache.close();
 }
});

test('record-index notifications coalesce and do not repeat for body-only changes',async()=>{
 const {cache}=setup();await cache.ready;await turns();let notices=0;const unsubscribe=cache.subscribeRecords(()=>notices++);
 cache.write(input('one'));await turns();assert.equal(notices,1);
 cache.write(input('two'));cache.write(input('three'));await turns();assert.equal(notices,1);
 await cache.flush();assert.equal(notices,1);
 const record=cache.write({...input('four'),fields:{...fields('four'),title:'Changed title'}});await turns();assert.equal(notices,2);
 cache.remove(record);await turns();assert.equal(notices,3);unsubscribe();await cache.close();
});
