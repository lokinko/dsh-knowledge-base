// IndexedDB draft persistence. The same driver runs on the main thread or in a
// dedicated Worker; both expose {load,get,commit,close} with identical results.
export const DRAFT_DATABASE='dsh-note-drafts';
const STORE='drafts';
export const newerDraft=(a,b)=>!b||a.updatedAt>b.updatedAt||(a.updatedAt===b.updatedAt&&a.raw>=b.raw);
const newer=newerDraft;

/** All reads/checks/writes in commit execute in one IDB readwrite transaction. */
export function createIndexedDBDraftDriver({indexedDBGetter=()=>globalThis.indexedDB,databaseName=DRAFT_DATABASE}={}){
 return new Promise((resolve,reject)=>{
  let request,settled=false;
  try{const indexedDB=indexedDBGetter();if(!indexedDB)throw new Error('IndexedDB is unavailable');request=indexedDB.open(databaseName,1);}catch(error){reject(error);return;}
  request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'key'});};
  request.onerror=()=>{settled=true;reject(request.error||new Error('Cannot open draft database'));};
  request.onblocked=()=>{settled=true;reject(new Error('Draft database upgrade is blocked by another window'));};
  request.onsuccess=()=>{
   const db=request.result;
   if(settled){db.close();return;}
   db.onversionchange=()=>db.close();
   const read=(key,all=false)=>new Promise((yes,no)=>{
    let tx,operation,result;
    try{tx=db.transaction(STORE,'readonly');operation=all?tx.objectStore(STORE).getAll():tx.objectStore(STORE).get(key);}catch(error){no(error);return;}
    operation.onsuccess=()=>{result=operation.result;};
    tx.oncomplete=()=>yes(result);
    tx.onabort=()=>no(tx.error||operation.error||new Error('Draft read failed'));
    tx.onerror=()=>{};
   });
   resolve({load:()=>read(null,true),get:key=>read(key),close:()=>db.close(),commit:operations=>new Promise((yes,no)=>{
    let tx;const outcomes=[];
    try{
     // Chromium honors strict durability; transaction completion is the boundary.
     try{tx=db.transaction(STORE,'readwrite',{durability:'strict'});}catch{tx=db.transaction(STORE,'readwrite');}
     const store=tx.objectStore(STORE);
     for(const operation of operations){
      const get=store.get(operation.key||operation.record.key);
      get.onsuccess=()=>{
       const existing=get.result;
       if(operation.type==='remove'){
        const removed=!existing||existing.raw===operation.raw;
        if(existing&&removed)store.delete(operation.key);
        outcomes.push({type:'remove',key:operation.key,raw:operation.raw,accepted:removed});
       }else{
        const accepted=newer(operation.record,existing);
        if(accepted)store.put(operation.record);
        outcomes.push({type:'put',key:operation.record.key,raw:operation.record.raw,accepted});
       }
      };
     }
    }catch(error){try{tx?.abort();}catch{}no(error);return;}
    tx.oncomplete=()=>yes(outcomes);
    tx.onabort=()=>no(tx.error||new Error('Draft transaction failed'));
    tx.onerror=()=>{};
   })});
  };
 });
}


function remoteError(value){
 return Object.assign(new Error(value?.message||'Draft worker request failed'),{name:value?.name||'Error'});
}

/**
 * Run the IndexedDB driver in a Worker. Structured clone of a large draft and
 * the commit's read-back of the previous record then cost another core, not
 * the frame that follows a keystroke. Any Worker failure before the database
 * opens (unsupported, CSP, missing IDB) falls back to the main-thread driver.
 */
export function createWorkerDraftDriver({workerSource,createWorker,databaseName=DRAFT_DATABASE,fallback}={}){
 let worker=null,objectUrl=null,nextId=0,dead=null;
 const pending=new Map();
 function stop(){worker?.terminate();worker=null;if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}}
 function fail(error){
  // A lost Worker is a closed connection: InvalidStateError lets the cache's
  // retry reopen persistence instead of treating the failure as permanent.
  dead??=Object.assign(new Error(error?.message||'Draft worker stopped'),{name:'InvalidStateError'});
  stop();for(const request of pending.values())request.reject(dead);pending.clear();
 }
 function call(op,payload){
  if(dead)return Promise.reject(dead);
  return new Promise((resolve,reject)=>{
   const id=++nextId;pending.set(id,{resolve,reject});
   try{worker.postMessage({id,op,...payload});}catch(error){pending.delete(id);reject(error);}
  });
 }
 const open=new Promise((resolve,reject)=>{
  try{
   if(createWorker)worker=createWorker();
   else{
    if(!workerSource||typeof Worker!=='function'||typeof Blob!=='function'||typeof URL?.createObjectURL!=='function')throw new Error('Draft worker unavailable');
    objectUrl=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
    worker=new Worker(objectUrl,{name:'dsh-note-drafts'});
   }
  }catch(error){reject(error);return;}
  worker.onmessage=event=>{
   const response=event.data,request=pending.get(response?.id);if(!request)return;
   pending.delete(response.id);
   if(response.error)request.reject(remoteError(response.error));else request.resolve(response.value);
  };
  worker.onerror=event=>{event?.preventDefault?.();fail(new Error(event?.message||'Draft worker failed'));};
  worker.onmessageerror=()=>fail(new Error('Draft worker response failed'));
  call('open',{databaseName}).then(resolve,reject);
 }).then(()=>({
  load:()=>call('load'),
  get:key=>call('get',{key}),
  commit:operations=>call('commit',{operations}),
  close:()=>{if(worker&&!dead){try{worker.postMessage({op:'close'});}catch{}}dead??=Object.assign(new Error('Draft database closed'),{name:'InvalidStateError'});stop();for(const request of pending.values())request.reject(dead);pending.clear();},
 }));
 return fallback?open.catch(error=>{stop();return fallback(error);}):open;
}

/** Worker side of createWorkerDraftDriver. */
export function serveDraftDriver(scope,{driverFactory=options=>createIndexedDBDraftDriver(options)}={}){
 let driver=null;
 const errorOf=error=>({name:error?.name||'Error',message:error?.message||String(error)});
 scope.onmessage=async event=>{
  const {id,op,...payload}=event.data||{};
  if(op==='close'){driver?.close();driver=null;scope.close?.();return;}
  try{
   let value;
   if(op==='open'){driver??=await driverFactory({indexedDBGetter:()=>scope.indexedDB,databaseName:payload.databaseName});value=true;}
   else if(!driver)throw Object.assign(new Error('Draft database is not open'),{name:'InvalidStateError'});
   else if(op==='load')value=await driver.load();
   else if(op==='get')value=await driver.get(payload.key);
   else if(op==='commit')value=await driver.commit(payload.operations);
   else throw new Error('Unknown draft operation: '+op);
   scope.postMessage({id,value});
  }catch(error){scope.postMessage({id,error:errorOf(error)});}
 };
}
