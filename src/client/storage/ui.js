import {createDirectoryPicker} from './directory-picker.js';

export function createStorageSettings({R,h,t,Icon,notebookRequest}){
const {DirectoryPicker}=createDirectoryPicker({R,h,t,Icon,notebookRequest});
// The DSH entry provides the host React instance and shared request service.
function NoteStorageSettings({onClose,beforeApply,onApplied,onApplyingChange}){
 const pathInput=R.useRef(null),alive=R.useRef(false),generation=R.useRef(0),operation=R.useRef('loading');
 const callbacks=R.useRef({onClose,beforeApply,onApplied});callbacks.current={onClose,beforeApply,onApplied};
 const ids=R.useId(),pathId=ids+'-path',hintId=ids+'-hint',messageId=ids+'-message';
 const [status,setStatus]=R.useState(null),[directory,setDirectory]=R.useState(''),[phase,setPhase]=R.useState('loading'),[message,setMessage]=R.useState(null),[checked,setChecked]=R.useState(null);
 const [pickerOpen,setPickerOpen]=R.useState(false);
 const endpoint='/api/dsh-note/note-storage';
 const busy=phase!==''||pickerOpen,applying=phase==='applying';
 function current(token){return alive.current&&generation.current===token;}
 function begin(next){if(operation.current)return null;operation.current=next;const token=++generation.current;setPhase(next);setMessage(null);return token;}
 function finish(token){if(current(token)){operation.current='';setPhase('');}}
 function detail(error){return typeof error?.message==='string'?error.message:String(error??'');}
 function errorKey(error,fallback){return ({INVALID_DIRECTORY:'nbStorageInvalidDirectory',DIRECTORY_BUSY:'nbStorageDirectoryBusy',LOCKED:'nbStorageDirectoryBusy',SERVICE_UNAVAILABLE:'nbStorageHostUnavailable',CONFLICT:'nbStorageConflict'})[error?.code]||fallback;}
 function readStatus(){return notebookRequest(endpoint,{action:'status'});}
 function close(){if(operation.current==='applying')return;callbacks.current.onClose?.();}
 async function refresh(){
  const token=begin('loading');if(token===null)return;
  try{const next=await readStatus();if(current(token)){setStatus(next);setMessage({key:'nbStorageReloaded',kind:'success'});}}
  catch(error){if(current(token))setMessage({key:errorKey(error,'nbStorageLoadError'),kind:'error',detail:detail(error)});}
  finally{finish(token);}
 }
 R.useEffect(()=>{
  alive.current=true;operation.current='loading';const token=++generation.current;
  readStatus().then(next=>{if(current(token)){setStatus(next);setDirectory(next.directory||'');}})
   .catch(error=>{if(current(token))setMessage({key:errorKey(error,'nbStorageLoadError'),kind:'error',detail:detail(error)});})
   .finally(()=>{finish(token);if(current(token))pathInput.current?.focus({preventScroll:true});});
  return()=>{alive.current=false;generation.current++;operation.current='';};
 },[]);
 R.useEffect(()=>{onApplyingChange?.(applying);},[applying]);
 R.useEffect(()=>()=>onApplyingChange?.(false),[]);
 function editDirectory(value){if(operation.current)return;setDirectory(value);setChecked(null);setMessage(null);}
 function closePicker(){setPickerOpen(false);requestAnimationFrame(()=>pathInput.current?.focus({preventScroll:true}));}
 async function check(){
  const token=begin('checking');if(token===null)return;
  try{
    const result=await notebookRequest(endpoint,{action:'check',directory:directory.trim()});
    if(result.writable===false||result.locked||['foreign','corrupt'].includes(result.ownedState)){
     const reason=[result.error,result.reason,result.message].find(value=>typeof value==='string'&&value.trim())||t(result.locked?'nbStorageDirectoryBusy':'nbStorageInvalidDirectory');
     throw Object.assign(new Error(reason),{code:result.code||(result.locked?'DIRECTORY_BUSY':'INVALID_DIRECTORY')});
    }
    if(current(token)){const canonical=typeof result.directory==='string'?result.directory:directory.trim();setDirectory(canonical);setChecked(canonical);setMessage({key:'nbStorageChecked',kind:'success'});}
   }
  catch(error){if(current(token)){setChecked(null);setMessage({key:errorKey(error,'nbStorageCheckError'),kind:'error',detail:detail(error)});}}
  finally{finish(token);}
 }
 async function apply(event){
  event.preventDefault();if(event.nativeEvent?.isComposing||!status)return;
  const token=begin('applying');if(token===null)return;
  const requested=directory.trim();let submitted=false,applied=false,appliedStatus=null;
  try{
   try{if(callbacks.current.beforeApply&&await callbacks.current.beforeApply()===false){if(current(token))setMessage({key:'nbStorageFlushError',kind:'error'});return;}}
   catch(error){if(current(token))setMessage({key:'nbStorageFlushError',kind:'error',detail:detail(error)});return;}
   if(!current(token))return;
   const latest=await readStatus();if(!current(token))return;
   setStatus(latest);
   if(latest.revision!==status.revision){setMessage({key:'nbStorageConflict',kind:'error'});return;}
   submitted=true;
   const result=await notebookRequest(endpoint,{action:'set',directory:requested,revision:latest.revision});
   applied=true;
   if(!current(token))return;
   // The acknowledged write succeeded even if a later status refresh is unavailable.
   if(Number.isSafeInteger(result.revision)&&typeof result.directory==='string')appliedStatus=result;
   else{try{appliedStatus=await readStatus();}catch{}}
   if(!current(token))return;
   if(appliedStatus){setStatus(appliedStatus);setDirectory(appliedStatus.directory||'');setChecked(null);}
   setMessage({key:appliedStatus?'nbStorageApplied':'nbStorageAppliedRefresh',kind:'success'});
  }catch(error){
   if(!current(token))return;
   // A timed-out request can finish on the Host. Refresh the pointer before retrying.
   if(submitted){try{const latest=await readStatus();if(current(token))setStatus(latest);}catch{}}
   if(current(token))setMessage({key:errorKey(error,submitted?'nbStorageApplyUnconfirmed':'nbStorageLoadError'),kind:'error',detail:detail(error)});
  }finally{
   finish(token);
   if(applied&&current(token)){
    try{await callbacks.current.onApplied?.(appliedStatus);}
    catch(error){if(current(token))setMessage({key:'nbStorageAppliedRefresh',kind:'success',detail:detail(error)});}
   }
  }
 }
 const counts=status?.counts||{};
 const candidate=directory.trim(),separator=candidate.includes('\\')?'\\':'/';
 const location=candidate?candidate.replace(/[\\/]+$/,'')+separator+'dsh-notebook':t('nbStorageDefaultLocation');
 const keepComposition=event=>{if(event.key==='Enter'&&(event.nativeEvent?.isComposing||event.keyCode===229))event.preventDefault();};
 return h('form',{className:'nb-storage-form',onSubmit:apply,'aria-describedby':hintId,'aria-busy':busy,onKeyDown:keepComposition},
   pickerOpen?h(DirectoryPicker,{initialDirectory:directory.trim()||status?.directory,onClose:closePicker,onSelect:next=>{editDirectory(next);closePicker();}}):h('div',{className:'nb-storage-body'},
    h('section',{className:'nb-storage-current','aria-label':t('nbStorageCurrent')},h('div',{className:'nb-storage-section-heading'},h('h3',null,t('nbStorageCurrent')),h('button',{type:'button',className:'btn btn-sm nb-storage-refresh',disabled:busy,onClick:refresh},h(Icon,{name:'refresh',size:12}),t('nbStorageReload'))),
     h('p',{className:'nb-storage-current-path'},phase==='loading'&&!status?t('loading'):status?(status.mode==='directory'?status.directory:t('nbStorageDefaultLocation')):t('nbStorageUnavailable')),
     status&&h('dl',{className:'nb-storage-counts'},...['notes','versions','bindings'].map(key=>h('div',{key},h('dt',null,t(key==='notes'?'nbStorageNotes':key==='versions'?'nbStorageVersions':'nbStorageBindings')),h('dd',null,Number.isSafeInteger(counts[key])?counts[key].toLocaleString():'—')))),
     !status&&message&&h('div',{id:messageId,className:'nb-storage-message is-error',role:'alert'},h('p',null,t(message.key)),message.detail&&h('pre',null,message.detail))),
    h('section',{className:'nb-storage-target'},h('label',{htmlFor:pathId,className:'nb-storage-path-label'},t('nbStorageDirectory')),h('p',{id:hintId,className:'nb-storage-hint'},t('nbStoragePathHint')),
     h('input',{ref:pathInput,id:pathId,className:'form-control nb-storage-path',type:'text',value:directory,disabled:busy,spellCheck:false,autoComplete:'off',autoCapitalize:'none',placeholder:t('nbStoragePathPlaceholder'),'aria-describedby':hintId+(message?' '+messageId:''),'aria-invalid':message?.kind==='error'&&message.key==='nbStorageInvalidDirectory'?true:undefined,onChange:event=>editDirectory(event.target.value)}),
     h('div',{className:'nb-storage-path-actions'},h('button',{type:'button',className:'btn btn-sm nb-storage-browse',disabled:busy,onClick:()=>setPickerOpen(true)},h(Icon,{name:'folder',size:13}),t('nbStorageChooseFolder')),h('button',{type:'button',className:'btn btn-sm',disabled:busy,onClick:check},h(Icon,{name:'check',size:13}),t(phase==='checking'?'nbStorageChecking':'nbStorageCheck')),h('button',{type:'button',className:'btn btn-sm nb-storage-reset',disabled:busy||!directory,onClick:()=>editDirectory('')},t('nbStorageReset'))),
     h('div',{className:'nb-storage-destination'},h('span',null,t('nbStorageDestination')),h('code',null,location)),
     checked!==null&&h('p',{className:'nb-storage-checked'},h(Icon,{name:'check',size:13}),t('nbStorageCheckedHint'))),
    h('div',{className:'nb-storage-preserve'},h(Icon,{name:'book',size:16}),h('p',null,t('nbStoragePreserve'))),
    status&&message&&h('div',{id:messageId,className:'nb-storage-message'+(message.kind==='error'?' is-error':' is-success'),role:message.kind==='error'?'alert':'status'},h('p',null,t(message.key)),message.detail&&h('pre',null,message.detail)),
    applying&&h('div',{className:'nb-storage-working',role:'status','aria-live':'polite'},h('span',{className:'nb-storage-progress','aria-hidden':true}),h('p',null,t('nbStorageApplyingHint')))),
   !pickerOpen&&h('footer',{className:'nb-storage-footer'},h('span',null,t('nbStorageApplyHint')),h('div',{className:'nb-storage-buttons'},h('button',{type:'button',className:'btn btn-sm',disabled:applying,onClick:close},t('close')),h('button',{type:'submit',className:'btn btn-sm btn-primary',disabled:busy||!status},t(applying?'nbStorageApplying':'nbStorageApply')))));
}

return {NoteStorageSettings};
}
