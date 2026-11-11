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
 try{const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal});const data=await response.json();if(!response.ok||!data.ok)throw Object.assign(new Error(data.error||t('nbError')),{code:data.code||(response.status===409?'CONFLICT':response.status===404?'NOT_FOUND':'ERROR')});return data;}finally{clearTimeout(timeout);noteControllers.delete(controller);}
}
const notesRequest=input=>notebookRequest('/api/dsh-note/notes',input);
const noteCategoryKey={document:'nbDocument',reading:'nbReading',code:'nbCode',journal:'nbJournal'};
function noteTime(value){if(!value)return '';try{return new Intl.DateTimeFormat(ctx.locale.getSnapshot().active,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}catch{return '';}}
function localCalendar(){const date=new Date();return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate());}
return {noteCache,subscribeRecords,notebookRequest,notesRequest,noteFieldsEqual,noteCategoryKey,noteTime,localCalendar};
}
