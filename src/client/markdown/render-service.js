import {renderDocument,getMarkdownHeadings} from './renderer.js';

export const ASYNC_MARKDOWN_THRESHOLD=20000;

export function createRenderService({workerSource,createWorker,threshold=ASYNC_MARKDOWN_THRESHOLD}={}){
  let worker=null,objectUrl=null,failed=false,disposed=false,nextId=0,activeId=null;
  const pending=new Map(),queued=new Map(),channels=new Map(),defaultConsumer={};
  const sourceCode=workerSource??(typeof __NOTE_RENDER_WORKER_SOURCE__==='string'?__NOTE_RENDER_WORKER_SOURCE__:'');
  const consumerKey=consumer=>consumer??defaultConsumer;
  function channelFor(consumer){
    const key=consumerKey(consumer);
    if(!channels.has(key))channels.set(key,{key,epoch:0,render:null,headings:null});
    return channels.get(key);
  }
  function abortError(message='Markdown request cancelled'){return Object.assign(new Error(message),{name:'AbortError'});}
  function dispatch(){
    if(activeId!==null||!worker||!queued.size)return;
    // FIFO across consumers and operation kinds. Replaced edits rejoin at the
    // back, so a frequently edited preview cannot starve a history or outline.
    const [id,message]=queued.entries().next().value;
    queued.delete(id);activeId=id;
    try{worker.postMessage(message);}catch(error){failWorker(error);}
  }
  function stopWorker(){
    worker?.terminate();worker=null;
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  }
  function failWorker(error){
    failed=true;stopWorker();
    for(const request of pending.values())request.reject(error);
    pending.clear();queued.clear();activeId=null;
  }
  function ensureWorker(){
    if(worker||failed||disposed)return worker;
    try{
      if(createWorker)worker=createWorker();
      else{
        if(!sourceCode||typeof Worker!=='function'||typeof Blob!=='function')return null;
        objectUrl=URL.createObjectURL(new Blob([sourceCode],{type:'text/javascript'}));
        worker=new Worker(objectUrl,{name:'dsh-note-markdown'});
      }
      worker.onmessage=event=>{
        const response=event.data;
        if(response?.id!==activeId)return;
        // A cancelled consumer's active parse still occupies the worker until
        // this response arrives. It must release the slot even with no waiter.
        const request=pending.get(response.id);
        pending.delete(response.id);activeId=null;
        if(request){if(response.error)request.reject(new Error(response.error));else request.resolve(response.value);}
        dispatch();
      };
      worker.onerror=()=>failWorker(new Error('Markdown worker failed'));
      worker.onmessageerror=()=>failWorker(new Error('Markdown worker response failed'));
    }catch(error){failWorker(error);}
    return worker;
  }
  function request(kind,source,options,channel){
    const epoch=channel.epoch;
    const checkActive=()=>{if(disposed||epoch!==channel.epoch)throw abortError();};
    if(disposed)return Promise.reject(abortError('Markdown renderer disposed'));
    const fallback=()=>{checkActive();return kind==='headings'?getMarkdownHeadings(source):renderDocument(source,options);};
    if(source.length<threshold||!ensureWorker())return Promise.resolve().then(fallback);
    return new Promise((resolve,reject)=>{
      for(const [id,message] of queued){
        const previous=pending.get(id);
        if(previous?.channel!==channel||message.kind!==kind)continue;
        previous.reject(abortError('Markdown request superseded'));
        pending.delete(id);queued.delete(id);
      }
      const id=++nextId;pending.set(id,{resolve,reject,channel});
      // Consumer identities stay on the main thread: they may be objects or
      // Symbols and are neither parser options nor structured-clone payloads.
      queued.set(id,{id,kind,source,options});dispatch();
    }).then(value=>{checkActive();return value;}).catch(error=>{
      checkActive();
      // Local parser fallback also covers CSPs that forbid Blob workers. No eval.
      if(error.name==='AbortError')throw error;
      return fallback();
    });
  }
  function render(source,options={}){
    source=String(source??'');
    const prefix=typeof options.headingPrefix==='string'?options.headingPrefix:'',channel=channelFor(options.consumer);
    if(channel.render?.source===source&&channel.render.prefix===prefix)return channel.render.promise;
    const promise=request('render',source,{headingPrefix:prefix},channel);
    channel.render={source,prefix,promise};return promise;
  }
  function headings(source,{consumer}={}){
    source=String(source??'');
    const channel=channelFor(consumer);
    if(channel.render?.source===source)return channel.render.promise.then(value=>value.headings);
    if(channel.headings?.source===source)return channel.headings.promise;
    const promise=request('headings',source,undefined,channel);
    channel.headings={source,promise};return promise;
  }
  function cancel(consumer){
    const key=consumerKey(consumer),channel=channels.get(key);if(!channel)return;
    channel.epoch++;channels.delete(key);
    for(const [id,request] of pending){
      if(request.channel!==channel)continue;
      request.reject(abortError());pending.delete(id);queued.delete(id);
    }
    channel.render=null;channel.headings=null;
    // Never free activeId early: the worker cannot interrupt its synchronous
    // parser. Its eventual response advances unrelated consumers in FIFO order.
    dispatch();
  }
  function dispose(){
    if(disposed)return;
    disposed=true;stopWorker();
    for(const request of pending.values())request.reject(abortError('Markdown renderer disposed'));
    pending.clear();queued.clear();channels.clear();activeId=null;
  }
  return {render,headings,cancel,dispose,threshold};
}
