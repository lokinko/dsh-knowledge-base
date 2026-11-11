import {NoteNavigation} from './navigation.js';
import {groupLibraryNotes} from '../studio/sections.js';
import {createNotesHistory} from './history.js';
import {createNoteEditor} from './editor.js';

export function createNotesUI({R,h,t,Icon,Button,AutoTextarea,MarkdownField,MarkdownPreview,DocumentOutline,useCategories,CategoryNavigation,CategoryPicker,CategoryManager,DirectoryPanel,CommandMenu,ShortcutHelp,AttachmentPanel,NoteStorageSettings,NotebookHero,NoteLibraryCard,CoauthorPanel,noteCache,notesRequest,noteFieldsEqual,noteTime,localCalendar}){
const {NotesHistory}=createNotesHistory({R,h,t,Button,MarkdownPreview,notesRequest,noteTime});
const {NoteEditor}=createNoteEditor({R,h,t,Icon,Button,AutoTextarea,MarkdownField,DocumentOutline,CategoryPicker,AttachmentPanel,NotesHistory,noteCache,notesRequest,noteFieldsEqual,noteTime});
function NotesWorkspace({appearance,slotProps,initialNoteId,onInitialConsumed,initialCreateToken,onInitialCreateConsumed}){
 const categoryState=useCategories();
 const [categoryManager,setCategoryManager]=R.useState(false);
 const [directoryEpoch,setDirectoryEpoch]=R.useState(0),[navigationOpen,setNavigationOpen]=R.useState(false);
 const [navigationTab,setNavigationTab]=R.useState(()=>{try{return localStorage.getItem('dsh.note.navigation-tab')==='directory'?'directory':'notes';}catch{return 'notes';}}),[commandMode,setCommandMode]=R.useState(null),[shortcutsOpen,setShortcutsOpen]=R.useState(false);
 const editorCommands=R.useRef(null);
 function chooseNavigation(tab){setNavigationTab(tab);try{localStorage.setItem('dsh.note.navigation-tab',tab);}catch{}}
 const isCategory=id=>categoryState.tree.items.some(item=>item.id===id);
 const [chatOpen,setChatOpen]=R.useState(()=>{try{return localStorage.getItem('dsh.todo-manager.chat-open')==='true';}catch{return false;}}),[chatFocused,setChatFocused]=R.useState(false),[narrow,setNarrow]=R.useState(false),[coauthorMeta,setCoauthorMeta]=R.useState(null);
 const splitRef=R.useRef(null),editorRef=R.useRef(null);
 const [storageSettings,setStorageSettings]=R.useState(false);
 const [focused,setFocused]=R.useState(false);
 const catalogScroll=R.useRef(null),catalogSections=R.useRef(new Map());
 const [activeSection,setActiveSection]=R.useState('');
 const [libraryLayout,setLibraryLayout]=R.useState(()=>{try{return localStorage.getItem('dsh.todo-manager.notes-layout')==='list'?'list':'grid';}catch{return 'grid';}});
 function chooseLayout(value){setLibraryLayout(value);try{localStorage.setItem('dsh.todo-manager.notes-layout',value);}catch{}}
 const [navigation]=R.useState(()=>new NoteNavigation());
 const [view,setView]=R.useState('all'),[query,setQuery]=R.useState(''),[tag,setTag]=R.useState(''),[offset,setOffset]=R.useState(0),[data,setData]=R.useState({notes:[],total:0,counts:{}}),[opened,setOpened]=R.useState(null),[drafts,setDrafts]=R.useState([]),[loading,setLoading]=R.useState(true),[busy,setBusy]=R.useState(false),[error,setError]=R.useState('');
 const mounted=R.useRef(true),sequence=R.useRef(0),fileInput=R.useRef(null),refreshTimer=R.useRef(0),refreshRef=R.useRef(null);
 function refreshDrafts(){try{const latest=new Map();for(const record of noteCache.records())latest.set(record.noteId,record);setDrafts([...latest.values()].reverse());}catch{}}
 const refresh=R.useCallback(async()=>{const current=++sequence.current;setLoading(true);try{const result=await notesRequest({action:'list',limit:50,offset,query:query.trim(),...(isCategory(view)?{category:view}:{}),...(view==='pinned'?{pinnedOnly:true}:{}),trashed:view==='trash',...(tag.trim().replace(/^#+/,'')?{tag:tag.trim().replace(/^#+/,'')}:{})});if(mounted.current&&current===sequence.current){setData(result);setError('');}}catch{if(mounted.current&&current===sequence.current)setError('nbError');}finally{if(mounted.current&&current===sequence.current)setLoading(false);}},[view,query,tag,offset,categoryState.tree.revision]);
 refreshRef.current=refresh;
 R.useEffect(()=>{const timer=setTimeout(refresh,180);refreshDrafts();return()=>clearTimeout(timer);},[refresh]);
 R.useEffect(()=>{let active=true,timer=0;const update=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(active)refreshDrafts();},120);};noteCache.ready?.then(()=>{if(active)refreshDrafts();},()=>{if(active)setError('wbDraftUnavailable');});const off=noteCache.subscribeRecords?.(update);return()=>{active=false;clearTimeout(timer);off?.();};},[]);
 R.useEffect(()=>{mounted.current=true;const focus=()=>{categoryState.refresh();setDirectoryEpoch(value=>value+1);refreshRef.current();refreshDrafts();syncRemote();};window.addEventListener('focus',focus);window.addEventListener('storage',refreshDrafts);return()=>{mounted.current=false;navigation.cancelPending();sequence.current++;clearTimeout(refreshTimer.current);window.removeEventListener('focus',focus);window.removeEventListener('storage',refreshDrafts);};},[]);
 function changed(saved){if(!mounted.current)return;if(saved?.id)setCoauthorMeta(previous=>previous?.id===saved.id&&previous.title===saved.title?previous:{id:saved.id,title:saved.title});refreshDrafts();clearTimeout(refreshTimer.current);refreshTimer.current=setTimeout(()=>{refreshDrafts();refreshRef.current();},400);}
   function attachEditor(session){editorRef.current=session;return()=>{if(editorRef.current===session)editorRef.current=null;};}
  async function syncRemote(){const entry=navigation.current,session=editorRef.current;if(!entry?.note||!session||session.noteId!==entry.note.id)return;try{if(session.snapshot().status==='saving')await session.flush();if(!mounted.current||navigation.current?.token!==entry.token||editorRef.current!==session)return;const latest=await notesRequest({action:'get',id:entry.note.id});if(!mounted.current||navigation.current?.token!==entry.token||editorRef.current!==session)return;if(Boolean(latest.note.trashedAt)!==Boolean(entry.note.trashedAt)){if(!session.snapshot().dirty)replaceFrom(entry,latest.note);else setError('coauthorRemoteChanged');return;}const accepted=session.receiveRemote(latest.note);changed(accepted?latest.note:undefined);}catch{}}
  function toggleChat(){
     if(focused){setFocused(false);setChatOpen(true);setChatFocused(narrow);return;}
     if(narrow){setChatOpen(true);setChatFocused(value=>!value);}else{setChatFocused(false);setChatOpen(value=>!value);}
   }
  R.useEffect(()=>{try{localStorage.setItem('dsh.todo-manager.chat-open',String(chatOpen));}catch{}},[chatOpen]);
  R.useLayoutEffect(()=>{const node=splitRef.current;if(!node)return;const measure=()=>setNarrow(node.getBoundingClientRect().width<=900);measure();const observer=typeof ResizeObserver==='function'?new ResizeObserver(measure):null;observer?.observe(node);return()=>observer?.disconnect();},[]);
  R.useEffect(()=>{if(initialNoteId){openNote(initialNoteId);onInitialConsumed?.();}},[initialNoteId]);
  R.useEffect(()=>{if(initialCreateToken){create('document');onInitialCreateConsumed?.();}},[initialCreateToken]);
function replaceFrom(entry,note,focusTitle=false){if(!mounted.current)return;const next=navigation.replace(entry.token,{note,focusTitle});if(!next)return;setOpened(next);refreshDrafts();changed();}
 function closeNote(){navigation.back();setOpened(null);setNavigationOpen(false);setFocused(false);refreshDrafts();}
 function trashedFrom(entry){if(mounted.current&&navigation.closeFrom(entry.token)){setOpened(null);refreshDrafts();}changed();}
 async function openNote(id,record,focusTitle=false,expectedIntent,ignoreDraft=false){
  if(expectedIntent!==undefined&&!navigation.accepts(expectedIntent))return;
  if(!record&&!ignoreDraft){const kept=navigation.keepCurrent(id);if(kept){setOpened(kept);setNavigationOpen(false);setError('');return;}}
  const current=expectedIntent??navigation.begin();setError('');
  try{try{await noteCache.ready;}catch{throw Object.assign(new Error('Draft recovery unavailable'),{code:'DRAFT_UNAVAILABLE'});}if(record)record=noteCache.records().find(latest=>latest.key===record.key)||null;const result=await notesRequest({action:'get',id});if(!mounted.current||!navigation.accepts(current))return;let cached=ignoreDraft?null:record;try{if(!ignoreDraft)cached??=noteCache.latest(id);}catch{}
   if(cached&&noteFieldsEqual(cached.fields,result.note)){noteCache.remove(cached);cached=null;}
   const entry=cached&&result.note.trashedAt?{orphan:cached,trashedNote:result.note}:{note:result.note,draft:cached,focusTitle};const next=navigation.open(current,entry);if(next){setOpened(next);setNavigationOpen(false);}
  }catch(problem){if(mounted.current&&navigation.accepts(current)){if(problem.code==='DRAFT_UNAVAILABLE'){setError('wbDraftUnavailable');return;}let recover=record;try{recover??=noteCache.latest(id);}catch{}if(recover&&problem.code==='NOT_FOUND'){const next=navigation.open(current,{orphan:recover});if(next)setOpened(next);}else setError('nbError');}}
 }
 function chooseView(next){setView(next);setOffset(0);closeNote();setChatFocused(false);}
 async function create(category){if(busy)return;const intent=navigation.begin();setBusy(true);setError('');try{let result;if(category==='journal')result=await notesRequest({action:'journal',date:localCalendar()});else{const content=category==='reading'?t('nbReadingTemplate'):category==='code'?t('nbCodeTemplate'):'';result=await notesRequest({action:'create',category:category||'document',title:t(category==='reading'?'nbNewReading':category==='code'?'nbNewCode':'nbUntitled'),content});}await openNote(result.note.id,null,true,intent);changed();}catch{setError('nbError');}finally{if(mounted.current)setBusy(false);}}
 async function importNote(e){const file=e.target.files?.[0];e.target.value='';if(!file)return;const intent=navigation.begin();setBusy(true);setError('');try{const content=await file.text();const result=await notesRequest({action:'create',title:file.name.replace(/\.(md|markdown|txt)$/i,'').slice(0,200)||t('nbUntitled'),content,category:isCategory(view)?view:'document'});await openNote(result.note.id,null,false,intent);changed();}catch{setError('nbImportFailed');}finally{if(mounted.current)setBusy(false);}}
 async function copyOrphan(){if(!opened?.orphan)return;const intent=navigation.begin();setBusy(true);try{const record=opened.orphan;const created=await notesRequest({action:'create',...record.fields});noteCache.remove(record);await openNote(created.note.id,null,false,intent);changed();}catch{setError('nbError');}finally{if(mounted.current)setBusy(false);}}
  async function retryDrafts(){setBusy(true);try{if(await noteCache.retry?.()){refreshDrafts();setError('');}else setError('wbDraftUnavailable');}catch{setError('wbDraftUnavailable');}finally{if(mounted.current)setBusy(false);}}
 async function moveDirectoryNote(metadata,targetId){
  try{
   let result;const session=editorRef.current;
   if(session?.noteId===metadata.id){if(!await session.flush())return null;session.change({category:targetId});if(!await session.flush())return null;const snapshot=session.snapshot();result={...metadata,category:targetId,title:snapshot.fields.title,revision:snapshot.baseRevision,updatedAt:snapshot.updatedAt};}
   else result=(await notesRequest({action:'update',id:metadata.id,revision:metadata.revision,category:targetId})).note;
   changed(result);return result;
  }catch{setError('nbError');setDirectoryEpoch(value=>value+1);return null;}
 }
 const loadDirectoryNotes=R.useCallback((category,{offset=0,limit=100}={})=>notesRequest({action:'list',category,includeDescendants:false,offset,limit}),[]);
 const categories=[['all','nbAll','book'],['pinned','nbPinned','pin'],['document','nbDocument','note'],['reading','nbReading','book'],['code','nbCode','code'],['journal','nbJournal','calendar'],['trash','nbTrash','trash']];
  const currentLabel=isCategory(view)?categoryState.categoryLabel(view):t(categories.find(item=>item[0]===view)?.[1]||'nbAll');
  const newNote=()=>create(isCategory(view)?view:'document');
  const actions=[
   {id:'quick-open',label:t('wbQuickOpen'),keys:'Mod+P',icon:'search',run:()=>setCommandMode('notes')},
   {id:'new',label:t('nbNew'),keys:'Mod+Shift+N',icon:'plus',run:newNote},
   {id:'search',label:t('wbSearchNotes'),keys:'Mod+Shift+F',icon:'search',run:()=>{chooseNavigation('notes');requestAnimationFrame(()=>splitRef.current?.querySelector('.nb-search')?.focus());}},
   {id:'folders',label:t('nbCatManage'),icon:'folder',run:()=>setCategoryManager(true)},
   {id:'storage',label:t('nbStorageTitle'),icon:'folder',run:()=>setStorageSettings(true)},
   {id:'shortcuts',label:t('wbShortcuts'),keys:'Mod+/',icon:'list',run:()=>setShortcutsOpen(true)},
   ...(opened?.note?[
    {id:'save',label:t('save'),keys:'Mod+S',icon:'check',run:()=>editorCommands.current?.save()},
    {id:'undo',label:t('wbUndo'),icon:'back',run:()=>editorCommands.current?.runCommand('undo')},
    {id:'redo',label:t('wbRedo'),icon:'refresh',run:()=>editorCommands.current?.runCommand('redo')},
    {id:'find-document',label:t('wbFindInDocument'),icon:'search',run:()=>editorCommands.current?.runCommand('search')},
    {id:'preview',label:t('wbTogglePreview'),keys:'Mod+E',icon:'note',run:()=>editorCommands.current?.togglePreview()},
    {id:'split',label:t('wbToggleSplit'),icon:'matrix',run:()=>editorCommands.current?.split()},
    {id:'outline',label:t('wbToggleOutline'),keys:'Mod+Shift+O',icon:'list',run:()=>editorCommands.current?.toggleOutline()},
    {id:'focus',label:t('wbToggleFocus'),keys:'Mod+Shift+Enter',icon:'focus',run:()=>setFocused(value=>!value)},
    {id:'export',label:t('nbExport'),icon:'download',run:()=>editorCommands.current?.exportNote()},
   ]:[]),
  ];
  function handleWorkspaceKey(event){
   if(event.defaultPrevented||event.nativeEvent?.isComposing||event.keyCode===229||event.altKey||event.target.closest?.('.nb-coauthor,dialog'))return;
   if(!event.ctrlKey&&!event.metaKey)return;
   const key=event.key.toLowerCase();let action;
   if(key==='p'){event.preventDefault();event.stopPropagation();setCommandMode(event.shiftKey?'commands':'notes');return;}
   if(key==='/'||event.code==='Slash')action='shortcuts';
   else if(event.shiftKey&&key==='n')action='new';
   else if(event.shiftKey&&key==='f')action='search';
   else if(event.shiftKey&&key==='o')action='outline';
   else if(event.shiftKey&&key==='enter')action='focus';
   else if(!event.shiftKey&&key==='e')action='preview';
   else if(!event.shiftKey&&(key==='s'||key==='enter'))action='save';
   else if(!event.shiftKey&&key==='f'&&!event.target.closest?.('.cm-editor'))action='find-document';
   else if(!event.target.closest?.('.cm-editor')&&event.target.closest?.('.nb-writing-field')&&(key==='z'||key==='y'))action=key==='y'||event.shiftKey?'redo':'undo';
   const found=actions.find(item=>item.id===action);
   if(found){event.preventDefault();event.stopPropagation();found.run();}
  }
  const sections=R.useMemo(()=>groupLibraryNotes(data.notes,view),[data.notes,view]);
  const currentSection=sections.some(section=>section.key===activeSection)?activeSection:sections[0]?.key;
  function scrollCatalog(key){
    const list=catalogScroll.current,section=catalogSections.current.get(key);
    if(!list||!section)return;
    const top=section.getBoundingClientRect().top-list.getBoundingClientRect().top+list.scrollTop;
    list.scrollTo({top,behavior:'auto'});
    setActiveSection(key);
  }
  function trackCatalog(){
    const list=catalogScroll.current;if(!list)return;
    const top=list.getBoundingClientRect().top+40;
    let key=sections[0]?.key;
    for(const section of sections){
      const node=catalogSections.current.get(section.key);
      if(node&&node.getBoundingClientRect().top<=top)key=section.key;
    }
    if(key)setActiveSection(key);
  }
  function renderCard(note){
    return h(NoteLibraryCard,{key:note.id,note,categoryLabel:categoryState.categoryLabel,active:opened?.note?.id===note.id,busy,onOpen:()=>openNote(note.id)});
  }
  function navigationItem([key,label,icon]){
    return h('button',{
      key,type:'button',className:'nb-nav-item nav-link'+(view===key?' is-active active':''),
      title:t(label),'aria-label':t(label),'aria-current':view===key?'page':undefined,onClick:()=>chooseView(key)
    },h(Icon,{name:icon,size:16}),h('span',{className:'nb-nav-label'},t(label)),
      key!=='pinned'&&h('small',{className:'nb-nav-count'},data.counts[key]??0));
  }
  function toolButton(icon,label,onClick,disabled=false){
    return h('button',{type:'button',className:'nb-nav-item',title:t(label),'aria-label':t(label),disabled,onClick},
      h(Icon,{name:icon,size:16}),h('span',{className:'nb-nav-label'},t(label)));
  }
  const sidebar=h('aside',{className:'nb-categories tm-bs','aria-label':t('nbLibraryTab')},
    h('div',{className:'nb-sidebar-head'},
      h('h2',null,h('span',{className:'nb-library-mark'},h(Icon,{name:'book',size:15})),t('nbLibrary')),
      h('button',{type:'button',className:'nb-new btn btn-primary',title:t('nbNew'),'aria-label':t('nbNew'),disabled:busy,onClick:newNote},
        h(Icon,{name:'plus',size:16}),h('span',{className:'nb-nav-label'},t('nbNew')))),
    h('nav',{className:'nb-sidebar-nav nav nav-pills flex-column','aria-label':t('nbWorkspaceNavigation')},
      h('section',{className:'nb-nav-group'},
        h('h3',{className:'nb-nav-group-title'},t('nbLibraryGroup')),...categories.slice(0,2).map(navigationItem)),
      h('section',{className:'nb-nav-group'},
        h('h3',{className:'nb-nav-group-title'},t('nbCategory')),
        h(CategoryNavigation,{categories:categoryState,value:view,onChange:chooseView,counts:data.counts,onManage:()=>setCategoryManager(true),disabled:categoryState.loading})),
      h('section',{className:'nb-nav-group nb-category-foot'},
        h('h3',{className:'nb-nav-group-title'},t('nbToolsGroup')),navigationItem(categories[6]),
        toolButton('calendar','nbToday',()=>create('journal'),busy),
        toolButton('upload','nbImport',()=>fileInput.current?.click(),busy),
        toolButton('folder','nbStorageTitle',()=>setStorageSettings(true)))));
  const directoryVisible=!!opened&&navigationTab==='directory'&&view!=='trash';
  const list=h('section',{className:'nb-list-panel tm-bs'+(directoryVisible?' is-directory':''),'aria-label':t('nbLibraryTab')},
    h('header',{className:'nb-list-head'},
      h('div',{className:'nb-list-heading'},
        h('div',null,h('h2',{title:currentLabel},h('span',{className:'nb-list-category-label'},currentLabel),h('span',{className:'nb-view-count'},data.total)),
          !opened&&h(NotebookHero,{counts:data.counts,total:data.total,loading})),
        h('div',{className:'nb-list-actions'},
          h('button',{type:'button',className:'em-icon nb-command-trigger','aria-label':t('wbCommands'),title:t('wbCommands')+' · Ctrl+Shift+P',onClick:()=>setCommandMode('commands')},'⋯'),
          h(Button,{icon:'list',label:t('nbCatManage'),className:'nb-category-manage',onClick:()=>setCategoryManager(true)}),
          h(Button,{icon:'folder',label:t('nbStorageTitle'),className:'nb-compact-tools',onClick:()=>setStorageSettings(true)}),
          h(Button,{icon:'refresh',label:t('refresh'),onClick:()=>{setDirectoryEpoch(value=>value+1);refresh();syncRemote();},disabled:loading}),
          h(Button,{icon:'upload',label:t('nbImport'),onClick:()=>fileInput.current?.click(),disabled:busy}),
          h(Button,{icon:'plus',label:t('nbNew'),disabled:busy,onClick:newNote}))),
      h('div',{className:'nb-list-controls',hidden:directoryVisible},
        h('input',{type:'search',className:'nb-search form-control',value:query,placeholder:t('nbSearch'),'aria-label':t('nbSearch'),onChange:e=>{setQuery(e.target.value);setOffset(0);}}),
        h('div',{className:'nb-list-filters'},
          h(CategoryPicker,{categories:categoryState,className:'nb-mobile-category form-select form-select-sm',value:view,ariaLabel:t('nbCategory'),includeViews:true,onChange:value=>{if(opened){setView(value);setOffset(0);}else chooseView(value);}}),
          h('input',{className:'nb-tag-filter form-control form-control-sm',type:'search',value:tag,maxLength:41,placeholder:t('nbTagFilter'),'aria-label':t('nbTagFilter'),onChange:e=>{setTag(e.target.value);setOffset(0);}}),
          h('div',{className:'btn-group nb-layout-switch',role:'group','aria-label':t('nbLayout')},
            h(Button,{icon:'matrix',label:t('nbGrid'),pressed:libraryLayout==='grid',onClick:()=>chooseLayout('grid')}),
            h(Button,{icon:'list',label:t('nbList'),pressed:libraryLayout==='list',onClick:()=>chooseLayout('list')})))),
      !opened&&h('nav',{className:'nb-filter-strip','aria-label':t('nbQuickFilters')},
        ...[...categories.slice(0,2).map(([key,label])=>({id:key,label:t(label)})),...categoryState.flattened.filter(item=>item.parentId===null).slice(0,6)].map(item=>h('button',{
          key:item.id,type:'button',className:'nb-filter-chip',title:item.label,'aria-pressed':view===item.id,onClick:()=>chooseView(item.id)
        },h('span',{className:'nb-filter-chip-label'},item.label),item.id!=='pinned'&&h('span',null,data.counts[item.id]??0)))),
      drafts.length>0&&h('details',{className:'nb-drafts'},
        h('summary',null,t('pendingDrafts')+' · '+drafts.length),
        ...drafts.map(record=>h('button',{key:record.key,type:'button',onClick:()=>openNote(record.noteId,record)},record.fields.title||t('nbUntitled'))))),
    opened&&h('div',{className:'nb-navigation-bar'},
      h('div',{className:'nb-navigation-tabs',role:'tablist','aria-label':t('wbLibraryPane')},...['notes','directory'].map(tab=>h('button',{key:tab,type:'button',role:'tab','aria-selected':navigationTab===tab,onClick:()=>chooseNavigation(tab)},t(tab==='notes'?'wbNotesTab':'wbDirectoryTab')))),
      h('div',{className:'nb-navigation-tools'},h(Button,{icon:'back',label:t('wbBackWriting'),className:'nb-close-navigation',onClick:()=>setNavigationOpen(false)}),h('button',{type:'button',className:'em-icon',title:t('wbShortcuts'),'aria-label':t('wbShortcuts'),onClick:()=>setShortcutsOpen(true)},'?'))),
    error&&h('p',{className:'nb-warning',role:'alert'},t(error),error==='wbDraftUnavailable'&&h('button',{type:'button',className:'em-btn',disabled:busy,onClick:retryDrafts},t('wbRetryDrafts'))),
    noteCache.recoveryWarning&&h('p',{className:'nb-warning',role:'alert'},t('wbDraftRecoveryWarning'),h('button',{type:'button',className:'em-btn',disabled:busy,onClick:retryDrafts},t('wbRetryDrafts'))),
    categoryState.error&&h('p',{className:'nb-warning',role:'alert'},categoryState.error),
    directoryVisible?h('div',{className:'nb-directory-host'},h(DirectoryPanel,{categories:categoryState,activeCategory:view,activeNoteId:opened?.note?.id,onSelectCategory:id=>{setView(id);setOffset(0);},onOpenNote:note=>openNote(note.id),onCreateNote:create,onManage:()=>setCategoryManager(true),loadNotes:loadDirectoryNotes,onMoveNote:moveDirectoryNote,refreshToken:String(data.counts.all)+':'+String(data.counts.trash)+':'+directoryEpoch,disabled:busy})):h('div',{className:'nb-collection-layout'},
      h('div',{ref:catalogScroll,className:'nb-note-list','aria-busy':loading,onScroll:trackCatalog},
        loading&&!data.notes.length?h('p',{className:'nb-muted',role:'status'},t('loading')):
        data.notes.length?(opened?data.notes.map(renderCard):sections.map(section=>h('section',{
          key:section.key,className:'nb-note-section','data-section':section.key,
          ref:node=>{if(node)catalogSections.current.set(section.key,node);else catalogSections.current.delete(section.key);}
        },
          h('header',{className:'nb-note-section-head'},h('h3',null,t(section.label)),h('span',null,section.notes.length)),
          h('div',{className:'nb-note-section-grid'},...section.notes.map(renderCard))))):
        h('div',{className:'nb-list-empty'},
          h(Icon,{name:'note',size:26}),h('p',null,t(query||tag?'nbNoResults':'nbNoNotes')),
          h('p',{className:'nb-muted'},t('nbStudioEmptyHint')),
          (query||tag)&&h('button',{type:'button',className:'em-btn btn btn-sm',onClick:()=>{setQuery('');setTag('');setOffset(0);}},t('nbStudioClearFilters')),
          h('button',{type:'button',className:'em-btn btn btn-sm',disabled:busy,onClick:newNote},t('nbNew')))),
      !opened&&sections.length>0&&h('aside',{className:'nb-collection-index','aria-label':t('nbOnThisPage')},
        h('h3',null,t('nbOnThisPage')),
        h('nav',null,...sections.map(section=>h('button',{
          key:section.key,type:'button',className:'nb-collection-link',
          'aria-current':currentSection===section.key?'location':undefined,onClick:()=>scrollCatalog(section.key)
        },h('span',null,t(section.label)),h('small',null,section.notes.length)))),
        h('p',{className:'nb-collection-summary'},t('nbVisibleNotes')+' '+data.notes.length+' / '+data.total))),
    !directoryVisible&&h('footer',{className:'nb-list-foot'},h('span',null,data.total+' '+t('nbNotesCount')),
      h('div',null,
        h('button',{type:'button',className:'em-btn btn btn-sm',title:t('nbStudioPrevious'),'aria-label':t('nbStudioPrevious'),disabled:offset===0||loading,onClick:()=>setOffset(Math.max(0,offset-50))},h(Icon,{name:'back',size:16})),
        h('button',{type:'button',className:'em-btn btn btn-sm',title:t('nbStudioNext'),'aria-label':t('nbStudioNext'),disabled:offset+50>=data.total||loading,onClick:()=>setOffset(offset+50)},h(Icon,{name:'chevron',size:16})))));
  const documentPanel=opened&&h('main',{className:'nb-document-panel','aria-label':t('nbContent')},
    opened.note?h(NoteEditor,{
      key:opened.token,note:opened.note,draft:opened.draft,focusTitle:opened.focusTitle,fontSize:appearance.fontSize,
      categories:categoryState,onManageCategories:()=>setCategoryManager(true),onActions:actions=>{editorCommands.current=actions;},onOpenNavigation:()=>{chooseNavigation('directory');setNavigationOpen(true);setFocused(false);},onSession:attachEditor,onToggleChat:toggleChat,focused,onToggleFocus:()=>setFocused(value=>!value),onSaved:changed,onReplace:note=>replaceFrom(opened,note),onClose:closeNote,onTrashed:()=>trashedFrom(opened)
    }):opened.orphan&&h('div',{className:'nb-orphan'},
      h('button',{type:'button',className:'em-btn btn btn-sm',title:t('nbBackList'),onClick:closeNote},h(Icon,{name:'back',size:16}),t('nbBackList')),
      h('h2',null,opened.orphan.fields.title||t('nbUntitled')),
      h('p',null,t(opened.trashedNote?'nbTrashedDraft':'nbOrphan')),
      opened.trashedNote&&h('button',{type:'button',className:'em-btn btn btn-sm',onClick:()=>openNote(opened.trashedNote.id,null,false,undefined,true)},t('nbViewSaved')),
      h('button',{type:'button',className:'em-btn em-save btn btn-sm btn-primary',disabled:busy,onClick:copyOrphan},t('nbSaveCopy')),
      h(MarkdownPreview,{value:opened.orphan.fields.content,busy:true,onChange:()=>{},label:t('nbContent')})));
  const library=h('div',{className:'nb-workspace layout-'+libraryLayout+(opened?' has-note':'')+(opened&&focused?' is-focused':'')+(navigationOpen?' navigation-open':'')},
    sidebar,list,documentPanel,
    h('input',{ref:fileInput,type:'file',accept:'.md,.markdown,.txt,text/markdown,text/plain',hidden:true,onChange:importNote}));
 const linkedNote=opened?.note&&(coauthorMeta?.id===opened.note.id?{...opened.note,title:coauthorMeta.title}:opened.note);
 return h('div',{ref:splitRef,onKeyDownCapture:handleWorkspaceKey,className:'nb-main-split'+(opened?' has-document':'')+(chatOpen&&chatFocused?' chat-focused':'')+(opened&&focused?' focus-mode':'')},h('div',{className:'nb-main-left'},library),commandMode&&h(CommandMenu,{key:commandMode,mode:commandMode,actions,onOpenNote:note=>openNote(note.id),categoryLabel:categoryState.categoryLabel,onClose:()=>setCommandMode(null)}),shortcutsOpen&&h(ShortcutHelp,{actions,onClose:()=>setShortcutsOpen(false)}),categoryManager&&h(CategoryManager,{categories:categoryState,onClose:()=>setCategoryManager(false)}),storageSettings&&h(NoteStorageSettings,{onClose:()=>setStorageSettings(false),beforeApply:async()=>!editorRef.current||await editorRef.current.flush(),onApplied:async()=>{await categoryState.refresh();refreshDrafts();await refreshRef.current();}}),chatOpen&&linkedNote&&h(CoauthorPanel,{note:linkedNote,slotProps,onIdle:syncRemote,onToggle:toggleChat}));
}

return {NotesWorkspace};
}
