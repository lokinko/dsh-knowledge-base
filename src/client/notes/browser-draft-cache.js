import {NoteDraftCache} from './legacy-draft-cache.js';
import {createIndexedDBDraftDriver,createWorkerDraftDriver,newerDraft} from './idb-draft-driver.js';

export {createIndexedDBDraftDriver} from './idb-draft-driver.js';
import {NOTE_DRAFT_PREFIX as PREFIX,normalizeNoteFields,validateDraftIdentity,noteDraftKey,decodeLegacyDraft,cloneDraftRecord} from './draft-record.js';

const CHANNEL='dsh-note-drafts.v2';
const WORKER_SOURCE=typeof __NOTE_DRAFT_WORKER_SOURCE__==='string'?__NOTE_DRAFT_WORKER_SOURCE__:'';

/** Prefer the inline Worker driver; keep the main-thread driver as fallback. */
export function createDraftDriver({indexedDBGetter=()=>globalThis.indexedDB,workerSource=WORKER_SOURCE}={}){
 const local=()=>createIndexedDBDraftDriver({indexedDBGetter});
 return workerSource&&typeof Worker==='function'?createWorkerDraftDriver({workerSource,fallback:local}):local();
}
const message=error=>error?.message||String(error);
function validStored(value){
 try{
  if(!value||value.version!==2||typeof value.raw!=='string'||!value.raw.startsWith('v2:'))return null;
  validateDraftIdentity(value.noteId,value.writerId,value.baseRevision);
  if(value.key!==noteDraftKey(value.noteId,value.writerId)||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))return null;
  return {...value,fields:normalizeNoteFields(value.fields),volatile:false,pending:false};
 }catch{return null;}
}

/**
 * Browser cache: writes synchronously enter memory, then coalesce into IDB.
 * No pending write is described as durable. The legacy cache stays unchanged.
 * Inject driverFactory/timers/channelFactory for deterministic protocol tests.
 */
export class BrowserNoteDraftCache{
 constructor({storageGetter=()=>globalThis.localStorage,indexedDBGetter=()=>globalThis.indexedDB,
  driverFactory=()=>createDraftDriver({indexedDBGetter}),delay=30,setTimer=setTimeout,clearTimer=clearTimeout,
  tokenFactory=()=>globalThis.crypto.randomUUID(),channelFactory=()=>typeof window!=='undefined'&&typeof BroadcastChannel==='function'?new BroadcastChannel(CHANNEL):null,
  eventTarget=typeof window!=='undefined'?window:null}={}){
  if(!Number.isFinite(delay)||delay<0)throw new TypeError('Invalid persistence delay');
  this._legacy=new NoteDraftCache({storageGetter});this._driverFactory=driverFactory;this._delay=delay;
  this._setTimer=(...args)=>Reflect.apply(setTimer,globalThis,args);this._clearTimer=(...args)=>Reflect.apply(clearTimer,globalThis,args);this._tokenFactory=tokenFactory;
  this._memory=new Map();this._legacyRecords=new Map();this._idbRecords=new Map();this._inFlightPuts=new Map();this._puts=new Map();this._deletes=new Map();this._removed=new Map();
  this._listeners=new Set();this._recordListeners=new Set();this._lastWriteTime=0;this._timer=null;this._flight=null;this._driver=null;this._mode='initializing';this._closed=false;this._indexScheduled=false;
  this.initializationError=null;this.persistenceError=null;this.recoveryWarning=null;this._eventTarget=eventTarget;
  this._storageEvent=event=>{if(typeof event.key==='string'&&event.key.startsWith(PREFIX))this._legacyChanged(event.key,event.newValue);};
  eventTarget?.addEventListener('storage',this._storageEvent);
  try{this._channel=channelFactory();if(this._channel)this._channel.onmessage=event=>{if(Array.isArray(event.data?.keys))void this._refreshKeys(event.data.keys);};}catch{this._channel=null;}
  this.ready=this._initialize();
  // Consumers may attach their recovery UI after service creation. Keep the
  // rejection observable through ready without generating an unhandled rejection.
  this.ready.catch(()=>{});
 }
 async _initialize(){
  let legacyError;
  try{for(const record of this._legacy.records()){this._legacyRecords.set(record.key,record);this._mergeLoaded(record);}}catch(error){legacyError=error;}
  try{this._driver=await this._driverFactory();}
  catch(error){
   if(legacyError){this._mode='failed';this.initializationError=new Error('Draft recovery failed: '+message(error)+'; '+message(legacyError));this._notifyRecords();throw this.initializationError;}
   this._mode='localStorage';this.persistenceError=error;
   this.recoveryWarning='IndexedDB drafts could not be read. New edits use compatible local storage; existing IndexedDB drafts may still need recovery.';
   for(const record of [...this._puts.values()])this._writeFallback(record);
   this._puts.clear();this._notifyRecords();return this;
  }
  try{
   const stored=await this._driver.load();
   for(const value of stored){const record=validStored(value);if(record){this._idbRecords.set(record.key,record);this._mergeLoaded(record);}}
   if(legacyError)throw new Error('Legacy draft recovery failed: '+message(legacyError));
   this._mode='indexedDB';this.recoveryWarning=null;this._notifyRecords();if(this._puts.size||this._deletes.size)this._schedule();return this;
  }catch(error){this._mode='failed';this.initializationError=error;this._notifyRecords();throw error;}
 }
 _mergeLoaded(record){
  this._lastWriteTime=Math.max(this._lastWriteTime,Date.parse(record.updatedAt));
  if(this._removed.get(record.key)?.has(record.raw))return;
  const local=this._memory.get(record.key);
  // Local input accepted during initialization must never be replaced by a read.
  if(local?.volatile||this._puts.has(record.key)||local?.legacyRaw===record.raw)return;
  if(newerDraft(record,local)){this._memory.set(record.key,record);this._lastWriteTime=Math.max(this._lastWriteTime,Date.parse(record.updatedAt));}
 }
 records(){
  if(this.initializationError&&!this._memory.size)throw this.initializationError;
  return [...this._memory.values()].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.key.localeCompare(b.key)).map(cloneDraftRecord);
 }
 latest(noteId){if(this.initializationError&&!this._memory.size)throw this.initializationError;let latest=null;for(const record of this._memory.values())if(record.noteId===noteId&&(!latest||record.updatedAt>latest.updatedAt||(record.updatedAt===latest.updatedAt&&record.key>latest.key)))latest=record;return cloneDraftRecord(latest);}
 pending(noteId,writerId){const record=this._memory.get(noteDraftKey(noteId,writerId));return record?.volatile?cloneDraftRecord(record):null;}
 subscribe(listener){if(typeof listener!=='function')throw new TypeError('Listener must be a function');this._listeners.add(listener);return()=>this._listeners.delete(listener);}
 subscribeRecords(listener){if(typeof listener!=='function')throw new TypeError('Listener must be a function');this._recordListeners.add(listener);return()=>this._recordListeners.delete(listener);}
 _notify(record){for(const listener of [...this._listeners]){try{listener(cloneDraftRecord(record));}catch{/* A UI listener cannot abort persistence. */}}}
 _notifyRecords(){
  if(this._indexScheduled)return;this._indexScheduled=true;
  queueMicrotask(()=>{this._indexScheduled=false;for(const listener of [...this._recordListeners]){try{listener();}catch{}}});
 }
 write({noteId,writerId,baseRevision,fields}){
  if(this._closed)throw new Error('Draft cache is closed');
  validateDraftIdentity(noteId,writerId,baseRevision);const normalized=normalizeNoteFields(fields);
  this._lastWriteTime=Math.max(Date.now(),this._lastWriteTime+1);
  const record={version:2,noteId,writerId,baseRevision,fields:normalized,updatedAt:new Date(this._lastWriteTime).toISOString(),key:noteDraftKey(noteId,writerId),raw:'v2:'+this._tokenFactory(),volatile:true,pending:true};
  const previous=this._memory.get(record.key);this._memory.set(record.key,record);
  if(this._mode==='localStorage')this._writeFallback(record);
  else{this._puts.set(record.key,record);if(this._mode==='failed'){record.pending=false;record.error=message(this.initializationError);}else this._schedule();}
  // Workspace subscribers need additions/title changes, not every body edit.
  if(!previous||previous.fields.title!==record.fields.title)this._notifyRecords();
  return cloneDraftRecord(this._memory.get(record.key));
 }
 _writeFallback(record){
  const disk=this._legacy.write(record);
  const current=this._memory.get(record.key);
  if(current?.raw!==record.raw)return;
  const updated={...record,volatile:disk.volatile,pending:false,legacyRaw:disk.raw,...(disk.volatile?{error:'Legacy draft storage write failed'}:{})};
  this._memory.set(record.key,updated);this._legacyRecords.set(record.key,disk);this._notify(updated);this._notifyRecords();
 }
 _schedule(){if(this._timer!==null||this._flight||this._closed||this._mode!=='indexedDB')return;this._timer=this._setTimer(()=>{this._timer=null;void this.flush();},this._delay);}
 _cancelTimer(){if(this._timer!==null)this._clearTimer(this._timer);this._timer=null;}
 async flush(){
  this._cancelTimer();
  try{await this.ready;}catch{return false;}
  if(this._mode==='localStorage')return ![...this._memory.values()].some(record=>record.volatile);
  if(this._flight)return this._flight;
  const work=this._drain();this._flight=work;let succeeded=false;
  try{const result=await work;succeeded=result;return result;}finally{this._flight=null;if(this._puts.size||(succeeded&&this._deletes.size))this._schedule();}
 }
 async _drain(){
  while(this._puts.size||this._deletes.size){
   const puts=[...this._puts.values()],deletes=[...this._deletes.values()].flatMap(values=>[...values.values()]);
   this._puts.clear();this._deletes.clear();this._inFlightPuts=new Map(puts.map(record=>[record.key,record]));
   const operations=[...deletes.map(record=>({type:'remove',key:record.key,raw:record.raw})),...puts.map(record=>({type:'put',record:{...record,volatile:false,pending:false}}))];
   try{
    const outcomes=await this._driver.commit(operations);this.persistenceError=null;
    for(const record of puts){
     const current=this._memory.get(record.key),outcome=outcomes.find(result=>result.type==='put'&&result.key===record.key&&result.raw===record.raw);
     const accepted=outcome?.accepted===true;
     if(accepted)this._idbRecords.set(record.key,{...record,volatile:false,pending:false});
     if(current?.raw!==record.raw)continue;
     const updated={...current,volatile:!accepted,pending:false,...(!accepted?{error:'A newer draft already exists for this writer'}:{})};
     delete updated.error;if(!accepted)updated.error='A newer draft already exists for this writer';
     this._memory.set(record.key,updated);this._notify(updated);
     if(accepted)this._cleanupLegacy(record);
    }
    for(const record of deletes){
     if(this._idbRecords.get(record.key)?.raw===record.raw)this._idbRecords.delete(record.key);
     const removed=this._removed.get(record.key);removed?.delete(record.raw);if(!removed?.size)this._removed.delete(record.key);
    }
    this._broadcast(operations.map(operation=>operation.key||operation.record.key));
   }catch(error){
    this.persistenceError=error;
    for(const record of puts){const current=this._memory.get(record.key);if(current?.raw===record.raw){const failed={...current,volatile:true,pending:false,error:message(error)};this._memory.set(record.key,failed);this._notify(failed);}}
    for(const record of deletes)this._queueDelete(record);
    this._notifyRecords();return false;
   }finally{this._inFlightPuts.clear();}
  }
  return ![...this._memory.values()].some(record=>record.volatile);
 }
 _queueDelete(record){if(!this._deletes.has(record.key))this._deletes.set(record.key,new Map());this._deletes.get(record.key).set(record.raw,record);}
 _cleanupLegacy(record){
  const legacy=this._legacyRecords.get(record.key);
  if(legacy&&legacy.updatedAt<=record.updatedAt&&this._legacy.remove(legacy))this._legacyRecords.delete(record.key);
 }
 remove(record){
  if(!record||typeof record.key!=='string'||!record.key.startsWith(PREFIX)||typeof record.raw!=='string')return false;
  if(this._memory.get(record.key)?.raw===record.raw)this._memory.delete(record.key);
  if(this._puts.get(record.key)?.raw===record.raw)this._puts.delete(record.key);
  const legacy=this._legacyRecords.get(record.key);
  if(legacy&&(legacy.raw===record.raw||record.legacyRaw===legacy.raw||(record.version===2&&legacy.updatedAt<=record.updatedAt))){if(this._legacy.remove(legacy))this._legacyRecords.delete(record.key);}
  if(this._mode!=='localStorage'){
   // The newest accepted snapshot may not have reached IDB yet. A successful
   // server save also supersedes the older IDB snapshot we actually observed.
   // Delete each captured raw separately, never an unobserved/newer writer value.
   const persisted=this._idbRecords.get(record.key),flying=this._inFlightPuts.get(record.key);
   const candidates=[...(record.version===2?[record]:[]),...[persisted,flying].filter(value=>value&&value.updatedAt<=record.updatedAt)];
   for(const candidate of candidates){
    if(!this._removed.has(candidate.key))this._removed.set(candidate.key,new Set());this._removed.get(candidate.key).add(candidate.raw);
    this._queueDelete(candidate);
   }
   if(candidates.length)this._schedule();
  }
  this._notifyRecords();return true;
 }
 async retry(){
  if(this._closed)return false;
  if(this._mode==='failed'||(this._mode==='localStorage'&&this.recoveryWarning)||this.persistenceError?.name==='InvalidStateError'){
   const upgradingFallback=this._mode==='localStorage';
   this._driver?.close();this._driver=null;this.initializationError=null;this._mode='initializing';
   for(const record of this._memory.values())if(record.volatile){const pending={...record,pending:true};delete pending.error;this._memory.set(record.key,pending);this._puts.set(record.key,pending);this._notify(pending);}
   if(upgradingFallback)for(const record of this._memory.values())if(record.version===2&&!record.volatile)this._puts.set(record.key,record);
   this.ready=this._initialize();this.ready.catch(()=>{});
   try{await this.ready;}catch{return false;}
  }
  for(const record of this._memory.values())if(record.volatile){
   if(this._mode==='localStorage')this._writeFallback(record);
   else{const pending={...record,pending:true};delete pending.error;this._memory.set(record.key,pending);this._puts.set(record.key,pending);this._notify(pending);}
  }
  return this.flush();
 }
 _legacyChanged(key,raw){
  const current=this._memory.get(key),previous=this._legacyRecords.get(key),record=decodeLegacyDraft(key,raw);
  if(record)this._legacyRecords.set(key,record);else this._legacyRecords.delete(key);
  if(current?.volatile||current?.version===2)return;
  if(record)this._memory.set(key,record);else if(current?.raw===previous?.raw)this._memory.delete(key);
  this._notifyRecords();
 }
 async _refreshKeys(keys){
  try{await this.ready;if(this._mode!=='indexedDB')return;
   for(const key of new Set(keys.filter(key=>typeof key==='string'&&key.startsWith(PREFIX)))){
    const local=this._memory.get(key);if(local?.volatile||this._puts.has(key))continue;
    const record=validStored(await this._driver.get(key));
    if(record){this._idbRecords.set(key,record);this._mergeLoaded(record);}else{this._idbRecords.delete(key);if(this._memory.get(key)===local&&local?.version===2)this._memory.delete(key);}
   }
   this._notifyRecords();
  }catch(error){this.persistenceError=error;}
 }
 _broadcast(keys){try{this._channel?.postMessage({keys:[...new Set(keys)]});}catch{}}
 async close(){this._eventTarget?.removeEventListener('storage',this._storageEvent);this._channel?.close();const durable=await this.flush();this._closed=true;this._cancelTimer();this._driver?.close();this._listeners.clear();this._recordListeners.clear();return durable;}
}
