import {BrowserNoteDraftCache} from './browser-draft-cache.js';
import {noteFieldsEqual} from './draft-record.js';
export function createNotesServices({ctx,t}){
const pad=n=>String(n).padStart(2,'0');
const noteCache=new BrowserNoteDraftCache({storageGetter:()=>window.localStorage,indexedDBGetter:()=>window.indexedDB});
const subscribeRecords=listener=>noteCache.subscribeRecords(listener);
const noteControllers=new Set();let notesDisposed=false;
ctx.effect(()=>{const warn=e=>{try{if(noteCache.records().some(record=>record.volatile)){e.preventDefault();e.returnValue='';void noteCache.flush();}}catch{}};window.addEventListener('beforeunload',warn);return()=>{notesDisposed=true;window.removeEventListener('beforeunload',warn);for(const controller of noteControllers)controller.abort();noteControllers.clear();void noteCache.close();};});
async function notebookRequest(path,input){
 if(notesDisposed)throw new Error('Notebook unavailable');
 const controller=new AbortController();noteControllers.add(controller);const timeout=setTimeout(()=>controller.abort(),path==='/api/dsh-note/note-storage'?600000:120000);
 try{
  const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal});
  let data;try{data=await response.json();}catch{throw Object.assign(new Error(t(response.status===404?'nbStorageHostUnavailable':'nbError')+' (HTTP '+response.status+')'),{code:response.status===404?'SERVICE_UNAVAILABLE':'ERROR'});}
  if(!response.ok||!data?.ok)throw Object.assign(new Error(data?.error||t(response.status===404?'nbStorageHostUnavailable':'nbError')),{code:data?.code||(response.status===409?'CONFLICT':response.status===404?'SERVICE_UNAVAILABLE':'ERROR')});return data;
 }finally{clearTimeout(timeout);noteControllers.delete(controller);}
}
const notesRequest=input=>notebookRequest('/api/dsh-note/notes',input);
const noteCategoryKey={document:'nbDocument',reading:'nbReading',code:'nbCode',journal:'nbJournal'};
// Intl formatter construction costs far more than formatting. Editors render
// this on every keystroke and lists on every row, so reuse one per locale.
let timeFormat=null;
function noteTime(value){if(!value)return '';try{const locale=ctx.locale.getSnapshot().active;if(timeFormat?.locale!==locale)timeFormat={locale,format:new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})};return timeFormat.format.format(new Date(value));}catch{return '';}}
function localCalendar(){const date=new Date();return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate());}
return {noteCache,subscribeRecords,notebookRequest,notesRequest,noteFieldsEqual,noteCategoryKey,noteTime,localCalendar};
}
