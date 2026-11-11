function displayLabel(value){
 let end=Math.min(value.length,300);
 // Labels are display metadata. Match the Host's UTF-16 limit without splitting
 // an emoji's surrogate pair; source locations, questions and body stay intact.
 if(end<value.length&&value.charCodeAt(end-1)>=0xD800&&value.charCodeAt(end-1)<=0xDBFF&&value.charCodeAt(end)>=0xDC00&&value.charCodeAt(end)<=0xDFFF)end--;
 return value.slice(0,end);
}
export function normalizeTopicReference(value){
 if(!value||typeof value!=='object')throw new TypeError('Invalid topic reference');
 const label=typeof value.label==='string'&&value.label?{label:displayLabel(value.label)}:{};
 if(value.kind==='note'&&typeof value.atomId==='string'&&value.atomId)return {kind:'note',atomId:value.atomId,...label};
 if(value.kind==='discussion'&&typeof value.sessionId==='string'&&value.sessionId&&Number.isSafeInteger(value.seq)&&value.seq>=0)return {kind:'discussion',sessionId:value.sessionId,seq:value.seq,...label};
 throw new TypeError('Invalid topic reference');
}
export function topicReferenceKey(reference){
 const value=normalizeTopicReference(reference);
 return value.kind==='note'?JSON.stringify(['note',value.atomId]):JSON.stringify(['discussion',value.sessionId,value.seq]);
}
export function applyReferenceOperation(references,operation){
 const items=references.map(normalizeTopicReference),key=topicReferenceKey(operation.reference),index=items.findIndex(item=>topicReferenceKey(item)===key);
 if(operation.kind==='add'){if(index<0)items.push(normalizeTopicReference(operation.reference));return items;}
 if(operation.kind==='remove')return items.filter(item=>topicReferenceKey(item)!==key);
 if(operation.kind==='move'){
  if(![-1,1].includes(operation.direction))throw new TypeError('Invalid reference direction');
  if(index<0)return items;
  const next=index+operation.direction;
  if(next<0||next>=items.length)return items;
  [items[index],items[next]]=[items[next],items[index]];return items;
 }
 throw new TypeError('Invalid reference operation');
}
const TOPICS='/api/dsh-note/topics',DISCUSSIONS='/api/dsh-note/discussions';

/** Coordinates requests independently from React, with explicit topic/library scopes. */
export class TopicsController{
 constructor(request){
  this.request=request;this.listeners=new Set();this.active=false;this.epoch=0;this.listSeq=0;this.openSeq=0;this.searchSeq=0;this.readSeq=0;this.writeSeq=0;this.writing=false;
  this.state={libraryId:null,topics:[],total:0,selectedId:null,current:null,loading:false,busy:false,coauthorBusy:false,error:null,notice:null,newQuestion:'',questionInput:'',query:'',results:[],searching:false,discussionAvailable:true,selectedSource:null,read:null,reading:false,readError:null,candidate:null};
 }
 snapshot(){return this.state;}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 _set(patch){this.state={...this.state,...patch};for(const listener of [...this.listeners])listener(this.state);}
 start(){if(this.active)return;this.active=true;this._set({busy:false,coauthorBusy:false,reading:false,searching:false});void this.refresh();}
 stop(){this.active=false;this.epoch++;this.listSeq++;this.openSeq++;this.searchSeq++;this.readSeq++;this.writeSeq++;this.writing=false;this.listeners.clear();}
 input(name,value){if(['newQuestion','questionInput','query'].includes(name))this._set({[name]:value});}
 _scope(){return {epoch:this.epoch,seq:this.openSeq,id:this.state.selectedId,libraryId:this.state.libraryId};}
 _current(scope){return this.active&&scope.epoch===this.epoch&&scope.seq===this.openSeq&&scope.id===this.state.selectedId&&scope.libraryId===this.state.libraryId;}
 _library(response,expected){
  if(typeof response?.libraryId!=='string'||!response.libraryId)throw new Error('Invalid library identity');
  if(expected&&response.libraryId!==expected){
   this.epoch++;this.openSeq++;this.searchSeq++;this.readSeq++;this.writeSeq++;this.writing=false;
   this._set({libraryId:response.libraryId,topics:[],total:0,selectedId:null,current:null,loading:false,busy:false,coauthorBusy:false,results:[],selectedSource:null,read:null,reading:false,searching:false,candidate:null,error:'tpLibraryChanged'});
   return false;
  }
  return true;
 }
 _topic(value){
  if(!value||typeof value.id!=='string'||typeof value.question!=='string'||!Number.isSafeInteger(value.revision)||!Array.isArray(value.references))throw new Error('Invalid topic response');
  return {...value,references:value.references.map(normalizeTopicReference)};
 }
 _summary(value){
  if(!value||typeof value.id!=='string'||typeof value.question!=='string'||!Number.isSafeInteger(value.revision))throw new Error('Invalid topic summary');
  return {...value,...(Array.isArray(value.references)?{references:value.references.map(normalizeTopicReference),referenceCount:value.references.length}:{referenceCount:Number.isSafeInteger(value.referenceCount)?value.referenceCount:0})};
 }
 _questionPatch(topic){return this.state.questionInput===this.state.current?.question?{questionInput:topic.question}:{};}
 _upsert(topic){const item=this._summary(topic),exists=this.state.topics.some(value=>value.id===topic.id);return {topics:exists?this.state.topics.map(value=>value.id===topic.id?item:value):[item,...this.state.topics],total:this.state.total+(exists?0:1)};}
 async refresh(){
  const ticket=++this.listSeq,epoch=this.epoch;this._set({loading:true,error:null});
  try{
   const response=await this.request(TOPICS,{action:'list'});
   if(!this.active||ticket!==this.listSeq||epoch!==this.epoch)return false;
   if(!this._library(response,null))return false;
   const changed=this.state.libraryId&&this.state.libraryId!==response.libraryId;
   if(changed){this.epoch++;this.openSeq++;this.searchSeq++;this.readSeq++;this.writeSeq++;this.writing=false;}
   this._set({libraryId:response.libraryId,topics:(response.topics||[]).map(value=>{const summary=this._summary(value),known=!changed&&this.state.topics.find(item=>item.id===summary.id);return known&&known.revision>summary.revision?known:summary;}),total:response.total??response.topics?.length??0,loading:false,...(changed?{selectedId:null,current:null,busy:false,coauthorBusy:false,results:[],selectedSource:null,read:null,reading:false,searching:false,candidate:null,notice:'tpLibraryChanged'}:{})});
   if(!changed&&this.state.current&&!this.writing)await this._reloadCurrent(this._scope());
   return true;
  }catch(error){if(this.active&&ticket===this.listSeq&&epoch===this.epoch)this._set({loading:false,error:'tpLoadFailed'});return false;}
 }
 async open(id){
  const libraryId=this.state.libraryId,seq=++this.openSeq,epoch=this.epoch;this.searchSeq++;this.readSeq++;
  this._set({selectedId:id,current:null,loading:true,error:null,notice:null,query:'',results:[],selectedSource:null,read:null,reading:false,readError:null,searching:false,candidate:null,coauthorBusy:false});
  try{
   const response=await this.request(TOPICS,{action:'get',id,libraryId});
   if(!this.active||seq!==this.openSeq||epoch!==this.epoch)return false;
   if(!this._library(response,libraryId))return false;
   const topic=this._topic(response.topic);if(topic.id!==id)throw new Error('Topic identity mismatch');
   this._set({current:topic,questionInput:topic.question,loading:false,...this._upsert(topic)});return true;
  }catch(error){if(this.active&&seq===this.openSeq&&epoch===this.epoch)this._set({loading:false,error:'tpLoadFailed'});return false;}
 }
 async create(){
  const question=this.state.newQuestion.trim(),libraryId=this.state.libraryId;if(this.writing||!libraryId||!question||question.length>500)return false;
  const ticket=++this.writeSeq,epoch=this.epoch,selection=this.openSeq;this.writing=true;this._set({busy:true,error:null,notice:null});
  try{
   const response=await this.request(TOPICS,{action:'create',question,libraryId});
   if(!this.active||ticket!==this.writeSeq||epoch!==this.epoch||selection!==this.openSeq)return false;
   if(!this._library(response,libraryId))return false;
   const topic=this._topic(response.topic);this.openSeq++;this.searchSeq++;this.readSeq++;this.listSeq++;
   this._set({current:topic,loading:false,selectedId:topic.id,questionInput:topic.question,newQuestion:'',query:'',results:[],selectedSource:null,read:null,reading:false,readError:null,candidate:null,...this._upsert(topic)});return true;
  }catch(error){if(this.active&&ticket===this.writeSeq&&epoch===this.epoch)this._set({error:'tpSaveFailed'});return false;}
  finally{if(ticket===this.writeSeq){this.writing=false;if(this.active)this._set({busy:false});}}
 }
 async _reloadCurrent(scope){
  try{
   const response=await this.request(TOPICS,{action:'get',id:scope.id,libraryId:scope.libraryId});
   if(!this._current(scope)||!this._library(response,scope.libraryId))return;
   const topic=this._topic(response.topic);if(topic.id!==scope.id||topic.revision<this.state.current.revision)return;
   // Preserve edited rename text and reference operations for explicit retry.
   this._set({...this._questionPatch(topic),current:topic,...this._upsert(topic)});
  }catch{/* The saved state and pending input remain visible for a later retry. */}
 }
 async _mutate(action,patch){
  if(this.writing||this.state.coauthorBusy||!this.state.current)return false;
  const scope=this._scope(),revision=this.state.current.revision,ticket=++this.writeSeq;
  this.writing=true;this._set({busy:true,error:null,notice:null});
  try{
   const response=await this.request(TOPICS,{...patch,action,id:scope.id,revision,libraryId:scope.libraryId});
   if(!this._current(scope)||ticket!==this.writeSeq)return false;
   if(!this._library(response,scope.libraryId))return false;
   if(action==='delete'){
    this.openSeq++;this.searchSeq++;this.readSeq++;this.listSeq++;
    this._set({topics:this.state.topics.filter(topic=>topic.id!==scope.id),total:Math.max(0,this.state.total-1),loading:false,selectedId:null,current:null,selectedSource:null,read:null,reading:false,results:[],candidate:null,notice:'tpDeleted'});return true;
   }
   const topic=this._topic(response.topic);if(topic.id!==scope.id)throw new Error('Topic identity mismatch');
   if(topic.revision<this.state.current.revision)return false;
   this.listSeq++;
   this._set({current:topic,loading:false,...(patch.question!==undefined?{questionInput:topic.question}:this._questionPatch(topic)),candidate:null,notice:'tpSaved',...this._upsert(topic)});return true;
  }catch(error){
   if(this._current(scope)&&ticket===this.writeSeq){if(error?.code==='CONFLICT'){await this._reloadCurrent(scope);if(this._current(scope))this._set({error:'tpConflict'});}else this._set({error:'tpSaveFailed'});}
   return false;
  }finally{if(ticket===this.writeSeq){this.writing=false;if(this.active)this._set({busy:false});}}
 }
 rename(){const question=this.state.questionInput.trim();if(!question||question.length>500)return Promise.resolve(false);return this._mutate('update',{question});}
 delete(){return this._mutate('delete',{});}
 references(operation){
  if(this.writing||this.state.coauthorBusy||!this.state.current)return Promise.resolve(false);
  const references=applyReferenceOperation(this.state.current.references,operation);
  if(references.length===this.state.current.references.length&&references.every((reference,index)=>topicReferenceKey(reference)===topicReferenceKey(this.state.current.references[index]))){this._set({candidate:null,notice:'tpSaved'});return Promise.resolve(true);}
  const candidate={topicId:this.state.current.id,libraryId:this.state.libraryId,operation};this._set({candidate});
  return this._mutate('update',{references});
 }
 retryReferences(){const candidate=this.state.candidate;if(!candidate||candidate.topicId!==this.state.current?.id||candidate.libraryId!==this.state.libraryId)return Promise.resolve(false);return this.references(candidate.operation);}
 async search(){
  const query=this.state.query.trim(),scope=this._scope(),seq=++this.searchSeq;if(!query||!this.state.current)return false;
  this._set({searching:true,error:null});
  try{
   const response=await this.request(DISCUSSIONS,{action:'search',query,topicId:scope.id,limit:40});
   if(!this._current(scope)||seq!==this.searchSeq)return false;
   if(!this._library(response,scope.libraryId))return false;
   this._set({results:(response.results||[]).filter(result=>{try{normalizeTopicReference(result.reference);return true;}catch{return false;}}),discussionAvailable:response.discussionAvailable!==false,searching:false});return true;
  }catch{if(this._current(scope)&&seq===this.searchSeq)this._set({searching:false,error:'tpSearchFailed'});return false;}
 }
 async readSource(source,more=false){
  const reference=normalizeTopicReference(source.reference||source),scope=this._scope(),seq=++this.readSeq,key=topicReferenceKey(reference);
  const previous=more&&this.state.selectedSource&&topicReferenceKey(this.state.selectedSource.reference)===key?this.state.read:null;
  this._set({selectedSource:{...source,reference},reading:true,readError:null,...(!more?{read:null}:{})});
  try{
   const response=await this.request(DISCUSSIONS,{action:'read',reference,limit:20000,...(previous?.nextStart!=null?{start:previous.nextStart}:{})});
   if(!this._current(scope)||seq!==this.readSeq)return false;
   if(response.libraryId&&!this._library(response,scope.libraryId))return false;
   if(typeof response.content!=='string'||(response.reference&&topicReferenceKey(response.reference)!==key))throw new Error('Source identity mismatch');
   this._set({read:{...previous,...response,reference,nextStart:response.nextStart??null,content:(previous?.content||'')+response.content},reading:false});return true;
  }catch{if(this._current(scope)&&seq===this.readSeq)this._set({reading:false,readError:'tpSourceMissing'});return false;}
 }
 addSelected(){
  const selected=this.state.selectedSource,read=this.state.read;
  if(!selected||!read||this.state.reading||this.state.readError||topicReferenceKey(selected.reference)!==topicReferenceKey(read.reference))return Promise.resolve(false);
  const reference={...selected.reference,label:read.title||selected.title||selected.reference.label};
  return this.references({kind:'add',reference:normalizeTopicReference(reference)});
 }
 coauthorBusy(value){this._set({coauthorBusy:!!value});}
 receiveTopic(topic,libraryId=this.state.libraryId){
  if(!this.active||libraryId!==this.state.libraryId||topic?.id!==this.state.current?.id||!Number.isSafeInteger(topic.revision)||topic.revision<this.state.current.revision)return false;
  const normalized=this._topic(topic);this._set({...this._questionPatch(normalized),current:normalized,...this._upsert(normalized)});return true;
 }
}
