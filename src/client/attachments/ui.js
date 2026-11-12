export function createAttachments({R,h,t,Icon}){
// React and shared controls come from the DSH host factory.
// onInsert(markdown) changes the parent's draft; uploads only associate files.
function attachmentText(key, values={}){
 let text=t(key);for(const [name,value]of Object.entries(values))text=text.replaceAll('{'+name+'}',String(value));return text;
}
function attachmentSize(size){
 if(!Number.isFinite(size)||size<0)return '—';
 const units=['B','KiB','MiB','GiB'];let value=size,index=0;
 while(value>=1024&&index<units.length-1){value/=1024;index++;}
 return (index===0?String(Math.round(value)):value.toFixed(value>=10?0:1))+' '+units[index];
}
function attachmentServerUrl(value){
 if(typeof value!=='string'||!value.trim()||/[\u0000-\u0020\u007f]/.test(value))return null;
 try{const url=new URL(value,window.location.origin);return /^https?:$/.test(url.protocol)&&url.origin===window.location.origin&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
function AttachmentMark({size=18}){
 return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:'m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9m-6 12 9-9'}));
}
function AttachmentPanel({ownerId,disabled=false,onInsert}){
 const ownerType='note';
 const ownerKey=ownerType+':'+(ownerId||''),validOwner=typeof ownerId==='string'&&!!ownerId;
 const alive=R.useRef(false),generation=R.useRef(0),operationRef=R.useRef(''),controllers=R.useRef(new Set()),batchRef=R.useRef(null),dragDepth=R.useRef(0);
 const latest=R.useRef(null);latest.current={ownerKey,disabled,onInsert};
 const fileInput=R.useRef(null),manualInput=R.useRef(null),ids=R.useId();
 const [scope,setScope]=R.useState(ownerKey),[phase,setPhase]=R.useState(''),[listing,setListing]=R.useState({items:[],total:0,nextOffset:0,loaded:false});
 const [notice,setNotice]=R.useState(null),[failures,setFailures]=R.useState([]),[progress,setProgress]=R.useState(null),[confirmId,setConfirmId]=R.useState(null),[manualCopy,setManualCopy]=R.useState(null),[dragging,setDragging]=R.useState(false);
 const visible=scope===ownerKey,busy=visible&&!!phase,writable=validOwner&&!disabled;
 const items=visible?listing.items:[],total=visible?listing.total:0;
 function current(token){return alive.current&&generation.current===token&&latest.current.ownerKey===ownerKey;}
 function detail(error){return typeof error?.message==='string'?error.message:typeof error==='string'?error:'';}
 function begin(next){
  if(!alive.current||latest.current.ownerKey!==ownerKey||operationRef.current||!validOwner)return null;
  operationRef.current=next;const token=++generation.current;setPhase(next);setNotice(null);return token;
 }
 function finish(token){if(current(token)){operationRef.current='';setPhase('');}}
 async function request(input,token,file,batch){
  if(!current(token))throw new Error(t('attUnavailable'));
  const controller=new AbortController();controllers.current.add(controller);if(batch)batch.controller=controller;
  try{
   const path=file?'/api/dsh-note/attachment-upload?ownerType='+encodeURIComponent(ownerType)+'&ownerId='+encodeURIComponent(ownerId)+'&name='+encodeURIComponent(file.name):'/api/dsh-note/attachments';
   const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':file?'application/octet-stream':'application/json'},body:file||JSON.stringify(input),signal:controller.signal});
   let data;try{data=await response.json();}catch{throw new Error(attachmentText('attInvalidResponse',{status:response.status}));}
   if(!response.ok||data?.ok!==true){const message=typeof data?.error==='string'?data.error:typeof data?.message==='string'?data.message:t('attRequestFailed');throw Object.assign(new Error(message),{code:data?.code||(response.status===409?'CONFLICT':'ERROR')});}
   return data;
  }finally{controllers.current.delete(controller);if(batch?.controller===controller)batch.controller=null;}
 }
 async function loadPage(offset,token,append=false){
  const data=await request({action:'list',ownerType,ownerId,offset,limit:50},token);
  if(!Array.isArray(data.attachments)||!Number.isSafeInteger(data.total)||data.total<0||data.offset!==offset||data.limit!==50)throw new Error(t('attRequestFailed'));
  if(!current(token))return false;
  setListing(previous=>{
   const rows=append?previous.items.concat(data.attachments):data.attachments;
   const unique=new Map();for(const row of rows)unique.set(row.id,row);
   return {items:[...unique.values()],total:data.total,nextOffset:data.offset+data.limit,loaded:true};
  });return true;
 }
 R.useEffect(()=>{
  alive.current=true;const token=++generation.current;operationRef.current=validOwner?'loading':'';
  setScope(ownerKey);setPhase(validOwner?'loading':'');setListing({items:[],total:0,nextOffset:0,loaded:false});setNotice(null);setFailures([]);setProgress(null);setConfirmId(null);setManualCopy(null);setDragging(false);dragDepth.current=0;
  if(validOwner)void loadPage(0,token).catch(error=>{if(current(token))setNotice({key:'attLoadFailed',detail:detail(error),kind:'error'});}).finally(()=>finish(token));
  return()=>{alive.current=false;generation.current++;operationRef.current='';if(batchRef.current)batchRef.current.cancelled=true;batchRef.current=null;for(const controller of controllers.current)controller.abort();controllers.current.clear();};
 },[ownerType,ownerId]);
 R.useEffect(()=>{
  if(disabled){setConfirmId(null);setDragging(false);dragDepth.current=0;cancelUpload();}
 },[disabled]);
 R.useEffect(()=>{if(manualCopy&&scope===ownerKey){manualInput.current?.focus();manualInput.current?.select();}},[manualCopy,scope,ownerKey]);
 async function reload(append=false){
  const token=begin('loading');if(token===null)return;
  try{await loadPage(append?listing.nextOffset:0,token,append);}
  catch(error){if(current(token))setNotice({key:'attLoadFailed',detail:detail(error),kind:'error'});}
  finally{finish(token);}
 }
 function cancelUpload(){
  const batch=batchRef.current;if(!batch||batch.cancelled)return;
  batch.cancelled=true;batch.controller?.abort();
  if(current(batch.token))setProgress(previous=>previous?{...previous,stopping:true}:previous);
 }
 async function uploadFiles(files){
  if(!files.length||!writable||latest.current.disabled)return;
  const token=begin('uploading');if(token===null)return;
  const batch={token,cancelled:false,controller:null};batchRef.current=batch;let confirmed=0;
  setConfirmId(null);setFailures([]);setManualCopy(null);
  try{
   for(let index=0;index<files.length;index++){
    if(!current(token)||batch.cancelled)break;
    const file=files[index];setProgress({name:file.name,index:index+1,total:files.length,stopping:false});
    try{await request(null,token,file,batch);if(current(token))confirmed++;}
    catch(error){if(!current(token)||batch.cancelled)break;setFailures(previous=>previous.concat({name:file.name,message:detail(error)||t('attUploadFailed')}));}
   }
  }finally{
   if(current(token)){
    batchRef.current=null;setProgress(null);setPhase('refreshing');
    // A dropped/aborted response can follow a committed Host write. Reconcile with a fresh list.
    try{await loadPage(0,token);if(current(token))setNotice({key:batch.cancelled?'attUploadStopped':'attUploadFinished',values:{count:confirmed},kind:'status'});}
    catch(error){if(current(token))setNotice({key:'attUploadRefreshFailed',detail:detail(error),kind:'error'});}
    finally{finish(token);}
   }
  }
 }
 function chooseFiles(event){const files=Array.from(event.currentTarget.files||[]);event.currentTarget.value='';void uploadFiles(files);}
 function hasDraggedFiles(event){return Array.from(event.dataTransfer?.types||[]).includes('Files');}
 function dragEnter(event){if(!hasDraggedFiles(event))return;event.preventDefault();event.stopPropagation();dragDepth.current++;if(writable&&!operationRef.current)setDragging(true);}
 function dragOver(event){if(!hasDraggedFiles(event))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=writable&&!operationRef.current?'copy':'none';}
 function dragLeave(event){if(!hasDraggedFiles(event))return;event.preventDefault();event.stopPropagation();dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setDragging(false);}
 function dropFiles(event){
  const files=Array.from(event.dataTransfer?.files||[]);if(!files.length&&!hasDraggedFiles(event))return;
  event.preventDefault();event.stopPropagation();dragDepth.current=0;setDragging(false);void uploadFiles(files);
 }
 async function removeAttachment(attachment){
  if(!writable||latest.current.disabled)return;const token=begin('removing');if(token===null)return;
  let removed=false,problem=null;
  try{await request({action:'remove',ownerType,ownerId,id:attachment.id,revision:attachment.revision},token);removed=true;}
  catch(error){problem=error;}
  if(!current(token))return;
  setConfirmId(null);
  try{
   await loadPage(0,token);
   if(current(token))setNotice(removed?{key:'attRemoved',kind:'status'}:{key:problem?.code==='CONFLICT'?'attConflict':'attRemoveFailed',detail:detail(problem),kind:'error'});
  }catch(error){if(current(token))setNotice({key:removed?'attRemovedRefreshFailed':problem?.code==='CONFLICT'?'attConflictRefreshFailed':'attRemoveFailed',detail:[detail(problem),detail(error)].filter(Boolean).join('\n'),kind:'error'});}
  finally{finish(token);}
 }
 async function copyReference(attachment){
  const token=begin('copying');if(token===null)return;
  try{
   if(typeof attachment.markdown!=='string'||!attachment.markdown)throw new Error(t('attMissingReference'));
   if(!navigator.clipboard?.writeText)throw new Error(t('attClipboardUnavailable'));
   await navigator.clipboard.writeText(attachment.markdown);
   if(current(token)){setManualCopy(null);setNotice({key:'attCopied',kind:'status'});}
  }catch(error){if(current(token)){
   if(typeof attachment.markdown==='string'&&attachment.markdown){setManualCopy({name:attachment.name,markdown:attachment.markdown});setNotice({key:'attManualCopy',detail:detail(error),kind:'status'});}
   else setNotice({key:'attCopyFailed',detail:detail(error),kind:'error'});
  }}finally{finish(token);}
 }
 async function insertReference(attachment){
  if(!writable||latest.current.disabled||typeof latest.current.onInsert!=='function')return;
  const token=begin('inserting');if(token===null)return;
  try{
   if(typeof attachment.markdown!=='string'||!attachment.markdown)throw new Error(t('attMissingReference'));
   const accepted=await latest.current.onInsert(attachment.markdown);
   if(accepted===false)throw new Error(t('attInsertRejected'));
   if(current(token))setNotice({key:'attInserted',kind:'status'});
  }catch(error){if(current(token))setNotice({key:'attInsertFailed',detail:detail(error),kind:'error'});}
  finally{finish(token);}
 }
 function renderRow(attachment){
  const image=/^image\/(png|jpeg|gif|webp)$/.test(attachment.mediaType),pdf=attachment.mediaType==='application/pdf';
  const openUrl=attachmentServerUrl(attachment.url),downloadUrl=attachmentServerUrl(attachment.downloadUrl),reference=typeof attachment.markdown==='string'&&!!attachment.markdown;
  const href=(image||pdf)&&openUrl?openUrl:downloadUrl;
  return h('li',{key:attachment.id,className:'att-row'},
   image&&openUrl?h('img',{className:'att-thumb',src:openUrl,alt:'',loading:'lazy',decoding:'async',width:28,height:28}):h('span',{className:'att-file-icon','aria-hidden':true},h(Icon,{name:'note',size:16})),
   h('div',{className:'att-row-main'},
    href?h('a',{className:'att-name',href,title:attachment.name,target:'_blank',rel:'noopener noreferrer','aria-label':attachmentText('attViewNamed',{name:attachment.name})},attachment.name):h('span',{className:'att-name',title:attachment.name},attachment.name),
    h('span',{className:'att-meta'},attachmentSize(attachment.size)+' · '+(pdf?'PDF':attachment.mediaType||t('attFile')))),
   h('div',{className:'att-actions'},
    typeof onInsert==='function'&&h('button',{type:'button',className:'att-action',disabled:busy||!writable||!reference,onClick:()=>insertReference(attachment)},t('attInsert')),
    h('button',{type:'button',className:'att-action',disabled:busy||!reference,onClick:()=>copyReference(attachment)},t('attCopyReference')),
    downloadUrl&&h('a',{className:'att-action att-icon-action',href:downloadUrl,download:attachment.name,title:t('attDownload'),'aria-label':t('attDownload')},h(Icon,{name:'download',size:13})),
    writable&&h('button',{type:'button',className:'att-action att-icon-action att-remove',disabled:busy,title:t('attRemove'),'aria-label':t('attRemove'),'aria-expanded':confirmId===attachment.id,onClick:()=>setConfirmId(previous=>previous===attachment.id?null:attachment.id)},h(Icon,{name:'close',size:13}))),
   !downloadUrl&&h('p',{className:'att-hint'},t('attUrlUnavailable')),
   writable&&confirmId===attachment.id&&h('div',{className:'att-confirm',role:'group','aria-label':t('attRemoveConfirm')},h('p',null,t('attRemoveHint')),h('div',{className:'att-actions'},h('button',{type:'button',className:'att-action att-remove',disabled:busy,onClick:()=>removeAttachment(attachment)},t('attConfirmRemove')),h('button',{type:'button',className:'att-action',disabled:busy,onClick:()=>setConfirmId(null)},t('attCancel')))));
 }
 const working=busy&&!progress&&phase!=='loading';
 return h('section',{className:'tm-attachments tm-bs'+(visible&&dragging?' is-dragging':'')+(items.length?'':' is-empty'),'aria-labelledby':ids+'-title',onDragEnter:dragEnter,onDragOver:dragOver,onDragLeave:dragLeave,onDrop:dropFiles},
  h('header',{className:'att-header'},h('div',{className:'att-heading'},h(AttachmentMark,{size:15}),h('h3',{id:ids+'-title'},t('attTitle')),validOwner&&visible&&listing.loaded&&total>0&&h('span',{className:'att-count'},total)),h('div',{className:'att-actions'},validOwner&&h('button',{type:'button',className:'att-action att-icon-action',disabled:busy,onClick:()=>reload(false),title:t('attRefresh'),'aria-label':t('attRefresh')},h(Icon,{name:'refresh',size:13})),writable&&h('button',{type:'button',className:'att-action att-add',disabled:busy,onClick:()=>fileInput.current?.click()},h(Icon,{name:'plus',size:13}),t('attAdd')))),
  !validOwner?h('p',{className:'att-hint'},t(!ownerId?'attSaveNote':'attInvalidOwner')):h(R.Fragment,null,
   visible&&notice&&h('div',{className:'att-notice'+(notice.kind==='error'?' is-error':''),role:notice.kind==='error'?'alert':'status','aria-live':notice.kind==='error'?'assertive':'polite'},h('p',null,attachmentText(notice.key,notice.values)),notice.detail&&h('p',{className:'att-detail'},notice.detail)),
   visible&&failures.length>0&&h('div',{className:'att-notice is-error',role:'alert'},h('div',{className:'att-header'},h('strong',null,t('attBatchFailures')),h('button',{type:'button',className:'att-action','aria-label':t('attDismissFailures'),onClick:()=>setFailures([])},h(Icon,{name:'close',size:13}))),h('ul',{className:'att-failures'},...failures.map((failure,index)=>h('li',{key:index},h('strong',null,failure.name),h('span',null,failure.message)))),h('p',{className:'att-hint'},t('attBatchFailureHint'))),
   visible&&progress&&h('div',{className:'att-progress',role:'status','aria-live':'polite'},h('div',null,h('span',null,attachmentText(progress.stopping?'attStopping':'attUploading',{index:progress.index,total:progress.total})),h('strong',null,progress.name)),h('button',{type:'button',className:'att-action',disabled:progress.stopping,onClick:cancelUpload},h(Icon,{name:'close',size:13}),t('attStopUpload'))),
   (items.length>0||working)&&h('div',{className:'att-list-area','aria-busy':busy},items.length>0&&h('ul',{className:'att-list'},...items.map(renderRow)),working&&h('p',{className:'att-hint',role:'status','aria-live':'polite'},t(phase==='refreshing'?'attReconciling':phase==='removing'?'attRemoving':phase==='inserting'?'attInserting':phase==='copying'?'attCopying':'attLoading'))),
   visible&&notice?.kind==='error'&&h('button',{type:'button',className:'att-action',disabled:busy,onClick:()=>reload(false)},h(Icon,{name:'refresh',size:13}),t('attRetry')),
   visible&&listing.loaded&&listing.nextOffset<total&&h('footer',{className:'att-footer'},h('span',null,attachmentText('attCount',{shown:items.length,total})),h('button',{type:'button',className:'att-action',disabled:busy,onClick:()=>reload(true)},t('attLoadMore'))),
   visible&&manualCopy&&h('div',{className:'att-manual-copy'},h('div',{className:'att-header'},h('label',{htmlFor:ids+'-copy'},t('attManualCopyLabel')),h('button',{type:'button',className:'att-action','aria-label':t('attCloseCopy'),onClick:()=>setManualCopy(null)},h(Icon,{name:'close',size:13}))),h('p',{className:'att-hint',id:ids+'-copy-hint'},manualCopy.name,' · ',t('attManualCopyHint')),h('textarea',{ref:manualInput,id:ids+'-copy',readOnly:true,rows:3,value:manualCopy.markdown,'aria-describedby':ids+'-copy-hint',onFocus:event=>event.currentTarget.select()}))),
  h('input',{ref:fileInput,type:'file',multiple:true,hidden:true,disabled:!writable||busy,'aria-label':t('attAdd'),onChange:chooseFiles}));
}

return {AttachmentPanel};
}
