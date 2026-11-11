import {categoryChildren} from '../categories/tree.js';

export const DIRECTORY_ROW_HEIGHT=32;
export const DIRECTORY_PAGE_SIZE=100;
export const DIRECTORY_OVERSCAN=8;

// Directory caches contain list metadata only. They never fetch or retain Markdown bodies.
function metadata(note){const {content,...rest}=note;return rest;}
export class DirectoryNoteCache {
 constructor(loadNotes){this.loadNotes=loadNotes;this.entries=new Map();this.listeners=new Set();this.epoch=0;this.active=true;}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 notify(){if(this.active)for(const listener of this.listeners)listener();}
 resume(){this.active=true;}
 dispose(){this.active=false;this.epoch++;this.entries.clear();this.listeners.clear();}
 get(id){return this.entries.get(id);}
 invalidate(ids){
  if(!ids)this.epoch++;
  // Targeted invalidation preserves unrelated pages and their in-flight reads.
  for(const id of this.entries.keys())if(!ids||ids.includes(id))this.entries.delete(id);
  this.notify();
 }
 async load(id,{more=false}={}){
  if(!this.active)return null;
  const previous=this.entries.get(id);
  if(previous?.status==='loading')return previous.request;
  if(!more&&previous?.status==='ready')return previous;
  if(more&&previous&&previous.notes.length>=previous.total)return previous;
  const offset=more?(previous?.notes.length||0):0;
  const epoch=this.epoch;
  const entry={notes:offset?(previous?.notes||[]):[],total:previous?.total??0,status:'loading',error:null,request:null};
  this.entries.set(id,entry);
  // Defer invoking the caller so the loading entry exists even for synchronous throws.
  const request=Promise.resolve().then(()=>this.loadNotes(id,{offset,limit:DIRECTORY_PAGE_SIZE})).then(result=>{
   if(!this.active||epoch!==this.epoch||this.entries.get(id)!==entry)return null;
   if(!Array.isArray(result?.notes)||!Number.isSafeInteger(result?.total)||result.total<0)throw new Error('Invalid directory note response');
   const unique=new Map(entry.notes.map(note=>[note.id,note]));
   for(const note of result.notes){
    if(typeof note?.id!=='string'||!Number.isSafeInteger(note.revision)||note.category!==id)throw new Error('Invalid directory note metadata');
    unique.set(note.id,metadata(note));
   }
   // Empty pages before total would otherwise cause endless retries at the same offset.
   if((result.notes.length===0||offset>0&&unique.size<=entry.notes.length)&&offset<result.total)throw new Error('Directory page did not advance');
   const next={notes:[...unique.values()],total:result.total,status:'ready',error:null,request:null};
   this.entries.set(id,next);this.notify();return next;
  }).catch(error=>{
   if(!this.active||epoch!==this.epoch||this.entries.get(id)!==entry)return null;
   const next={...entry,status:'error',error,request:null};
   this.entries.set(id,next);this.notify();return null;
  });
  entry.request=request;this.notify();return request;
 }
}

/** Visible rows only; closed folders never enumerate or fetch their notes. */
export function directoryRows(tree,expanded,cache,labelOf=item=>item.name||item.id,query=''){
 const children=new Map(),byId=new Map(tree.items.map(item=>[item.id,item]));
 for(const item of tree.items){const siblings=children.get(item.parentId)||[];siblings.push(item);children.set(item.parentId,siblings);}
 for(const siblings of children.values())siblings.sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
 const search=query.trim().toLocaleLowerCase(),included=new Set(),matchingNotes=new Set();
 if(search){
  const include=id=>{const seen=new Set();while(id!==null&&byId.has(id)&&!seen.has(id)){seen.add(id);included.add(id);id=byId.get(id).parentId;}};
  for(const item of tree.items){
   if(labelOf(item).toLocaleLowerCase().includes(search))include(item.id);
   for(const note of cache.get(item.id)?.notes||[])if((note.title||'').toLocaleLowerCase().includes(search)){include(item.id);matchingNotes.add(note.id);}
  }
 }
 const rows=[],seen=new Set();
 function visit(parentId,depth){
  for(const item of children.get(parentId)||[]){
   if(seen.has(item.id)||search&&!included.has(item.id))continue;
   seen.add(item.id);
   const open=search?true:expanded.has(item.id),entry=cache.get(item.id);
   rows.push({kind:'category',key:'category:'+item.id,category:item,label:labelOf(item),depth,open});
   if(!open)continue;
   visit(item.id,depth+1);
   for(const note of entry?.notes||[]){
    if(search&&!matchingNotes.has(note.id))continue;
    rows.push({kind:'note',key:'note:'+note.id,note,categoryId:item.id,depth:depth+1});
   }
   if(search)continue;
   if(!entry||entry.status==='idle'||entry.status==='loading')rows.push({kind:'loading',key:'status:'+item.id,categoryId:item.id,depth:depth+1});
   else if(entry.status==='error')rows.push({kind:'retry',key:'status:'+item.id,categoryId:item.id,depth:depth+1,error:entry.error});
   else if(entry.notes.length<entry.total)rows.push({kind:'more',key:'more:'+item.id,categoryId:item.id,depth:depth+1,total:entry.total,loaded:entry.notes.length});
   else if(entry.notes.length===0&&!(children.get(item.id)||[]).length)rows.push({kind:'empty',key:'empty:'+item.id,categoryId:item.id,depth:depth+1});
  }
 }
 visit(null,0);return rows;
}
export function directoryWindow(count,scrollTop,height,overscan=DIRECTORY_OVERSCAN){
 const viewport=Math.max(DIRECTORY_ROW_HEIGHT,height||DIRECTORY_ROW_HEIGHT);
 const top=Math.min(Math.max(0,scrollTop||0),Math.max(0,count*DIRECTORY_ROW_HEIGHT-viewport));
 const start=Math.max(0,Math.floor(top/DIRECTORY_ROW_HEIGHT)-overscan);
 const end=Math.min(count,Math.ceil((top+viewport)/DIRECTORY_ROW_HEIGHT)+overscan);
 return {start,end,top: start*DIRECTORY_ROW_HEIGHT,bottom:(count-end)*DIRECTORY_ROW_HEIGHT,scrollTop:top};
}
export function categoryAncestors(tree,id){
 const byId=new Map(tree.items.map(item=>[item.id,item])),result=[],seen=new Set();
 while(byId.has(id)&&!seen.has(id)){seen.add(id);result.push(id);id=byId.get(id).parentId;}
 return result;
}
export function visibleExpandedCategories(tree,expanded){
 return tree.items.filter(item=>expanded.has(item.id)&&categoryAncestors(tree,item.id).every(id=>expanded.has(id))).map(item=>item.id);
}
export function categoryMoveInverse(tree,id){
 const item=tree.items.find(item=>item.id===id);if(!item)return null;
 const siblings=categoryChildren(tree,item.parentId),index=siblings.findIndex(item=>item.id===id);
 return {id,parentId:item.parentId,beforeId:siblings[index+1]?.id??null};
}
export function categoryUndoAllowed(history,tree){return Boolean(history&&tree.revision===history.expectedRevision&&tree.items.some(item=>item.id===history.inverse.id));}
