import {NoteEditSession} from './edit-session.js';

export function createNoteEditor({R,h,t,Icon,Button,AutoTextarea,MarkdownField,DocumentOutline,CategoryPicker,AttachmentPanel,NotesHistory,noteCache,notesRequest,noteFieldsEqual,noteTime}){
function NoteEditor({note,draft,onSaved,onReplace,onClose,onTrashed,focusTitle=false,fontSize,onSession,onToggleChat,focused=false,onToggleFocus,categories,onManageCategories,onActions,onOpenNavigation}){
 const fieldActions=R.useRef(null);
 const [outlineOpen,setOutlineOpen]=R.useState(false);
 const headingPrefix='nb-heading-'+R.useId().replace(/[^a-zA-Z0-9_-]/g,'');
 async function navigateHeading(heading){
   await fieldActions.current?.revealHeading(heading);
 }

 const [session]=R.useState(()=>new NoteEditSession({note,draft:note.trashedAt?null:draft,paused:true,cache:noteCache,save:async payload=>{let result;try{result=await notesRequest(payload);}catch(error){if(error.code==='TRASHED'||error.code==='NOT_FOUND')throw Object.assign(error,{code:'CONFLICT'});if(error.code!=='CONFLICT')throw error;const latest=await notesRequest({action:'get',id:note.id});if(latest.note.trashedAt||!noteFieldsEqual(latest.note,payload))throw error;result=latest;}onSaved(result.note);return result;}}));
 const [state,setState]=R.useState(()=>session.snapshot()),[operation,setOperation]=R.useState(false),[saving,setSaving]=R.useState(false),[notice,setNotice]=R.useState(''),[inputError,setInputError]=R.useState(''),[history,setHistory]=R.useState(false),[confirmTrash,setConfirmTrash]=R.useState(false),[confirmLatest,setConfirmLatest]=R.useState(false),[tags,setTags]=R.useState(()=>session.snapshot().fields.tags.join(', ')),[tagError,setTagError]=R.useState(false);
 const alive=R.useRef(false),titleInput=R.useRef(null),tagInput=R.useRef(null),download=R.useRef(null),downloadUrls=R.useRef(new Set()),downloadTimers=R.useRef(new Set());
 R.useEffect(()=>{alive.current=true;session.start();const detach=onSession?.(session);setState(session.snapshot());const unsubscribe=session.subscribe(snapshot=>setState(snapshot||session.snapshot()));const guard=e=>{const snapshot=session.snapshot();if(snapshot.dirty&&!snapshot.cacheDurable){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',guard);if(focusTitle)titleInput.current?.focus({preventScroll:true});return()=>{detach?.();unsubscribe();window.removeEventListener('beforeunload',guard);alive.current=false;queueMicrotask(()=>{if(!alive.current)void session.pause();});for(const timer of downloadTimers.current)clearTimeout(timer);downloadTimers.current.clear();for(const url of downloadUrls.current)URL.revokeObjectURL(url);downloadUrls.current.clear();};},[session]);
 R.useEffect(()=>{if(document.activeElement!==tagInput.current)setTags(state.fields.tags.join(', '));},[state.fields.tags]);
 const locked=operation||!!note.trashedAt,fields=state.fields;
 function change(patch){try{session.change(patch);setNotice('');setInputError('');return true;}catch(error){setInputError(String(error?.message||error));setNotice('nbInvalid');return false;}}
 function editTags(value){setTags(value);const parsed=[...new Set(value.split(/[,，]/).map(tag=>tag.trim().replace(/^#+/,'')).filter(Boolean))];const invalid=parsed.length>20||parsed.some(tag=>tag.length>40);setTagError(invalid);if(!invalid)change({tags:parsed});}
 async function save(){if(operation||note.trashedAt)return;setSaving(true);setOperation(true);setNotice('');try{if(tagError||!await session.flush())throw new Error();await notesRequest({action:'checkpoint',id:note.id,revision:session.snapshot().baseRevision});setNotice('nbSnapshotSaved');onSaved();}catch{setNotice('nbSaveFailed');}finally{setSaving(false);setOperation(false);}}
 async function trash(){setOperation(true);setNotice('');try{if(!await session.flush())throw new Error();await notesRequest({action:'trash',id:note.id,revision:session.snapshot().baseRevision});session.abandon();onTrashed();}catch{setNotice('nbSaveFailed');}finally{setOperation(false);}}
 async function restoreTrash(){setOperation(true);setNotice('');try{await notesRequest({action:'restore',id:note.id,revision:note.revision});const latest=await notesRequest({action:'get',id:note.id});session.abandon();onReplace(latest.note);onSaved();}catch{setNotice('nbError');}finally{setOperation(false);}}
 async function copy(){setOperation(true);setNotice('');try{const snapshot=session.snapshot().fields;const result=await notesRequest({action:'create',...snapshot,title:(snapshot.title||t('nbUntitled')).slice(0,190)+' '+t('nbCopySuffix')});const fresh=await notesRequest({action:'get',id:result.note.id});session.abandon();onReplace(fresh.note);onSaved();}catch{setNotice('nbError');}finally{setOperation(false);}}
 async function latest(){setOperation(true);setNotice('');try{const result=await notesRequest({action:'get',id:note.id});session.abandon();onReplace(result.note);}catch{setNotice('nbError');}finally{setOperation(false);}}
 function exportNote(){const data=session.snapshot().fields;let name=(data.title||t('nbUntitled')).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/,'').slice(0,120)||'note';if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='note-'+name;const url=URL.createObjectURL(new Blob([data.content],{type:'text/markdown;charset=utf-8'}));downloadUrls.current.add(url);download.current.href=url;download.current.download=name+'.md';download.current.click();const timer=setTimeout(()=>{URL.revokeObjectURL(url);downloadUrls.current.delete(url);downloadTimers.current.delete(timer);},1000);downloadTimers.current.add(timer);}
 R.useLayoutEffect(()=>{onActions?.({save,exportNote,togglePreview:()=>fieldActions.current?.toggleMode(),split:()=>fieldActions.current?.chooseMode('split'),toggleOutline:()=>setOutlineOpen(value=>!value),runCommand:id=>fieldActions.current?.runCommand(id)});return()=>onActions?.(null);});
 const status=state.conflict?'nbConflict':state.status==='saved'?'nbSaved':state.status==='saving'?'nbSaving':state.status==='offline'?'nbOffline':state.cachePending?'wbCaching':!state.cacheDurable?'nbCacheFailed':'nbCached';
 return h('section',{className:'nb-editor tm-bs'+(outlineOpen?' has-outline':''),onKeyDown:e=>{
    if(e.nativeEvent.isComposing||e.keyCode===229)return;
     if(e.key==='Escape'&&outlineOpen&&!e.target.closest('dialog')){e.preventDefault();e.stopPropagation();setOutlineOpen(false);return;}
    if((e.ctrlKey||e.metaKey)&&(e.key.toLowerCase()==='s'||e.key==='Enter')){e.preventDefault();save();}
  }},
    h('header',{className:'nb-editor-head'},
      h('div',{className:'nb-editor-identity'},
        h('button',{type:'button',className:'em-btn btn btn-sm nb-mobile-back',title:t('nbBackList'),'aria-label':t('nbBackList'),onClick:onClose},
          h(Icon,{name:'back',size:16}),h('span',null,t('nbBackList'))),
        h('strong',{className:'nb-editor-title',title:fields.title||t('nbUntitled')},fields.title||t('nbUntitled')),
        h('span',{className:'nb-editor-category',title:categories.categoryLabel(fields.category)},categories.categoryLabel(fields.category)),
        h('span',{className:'nb-save-state'+(state.conflict||(state.dirty&&((!state.cacheDurable&&!state.cachePending)||state.status==='offline'))?' is-warning':''),role:'status'},
          t(status)+(state.status==='saved'&&state.updatedAt?' · '+noteTime(state.updatedAt):''))),
      h('div',{className:'nb-editor-actions'},
        h(Button,{icon:'folder',label:t('wbDirectoryTab'),className:'nb-open-navigation',onClick:onOpenNavigation}),
        h(Button,{icon:focused?'unfocus':'focus',label:t(focused?'nbFocusExit':'nbFocusEnter'),pressed:focused,onClick:onToggleFocus}),
        h(Button,{icon:'list',label:t(outlineOpen?'nbOutlineHide':'nbOutlineShow'),pressed:outlineOpen,expanded:outlineOpen,controls:headingPrefix+'-outline',className:'nb-outline-toggle',onClick:()=>setOutlineOpen(value=>!value)}),
        h(Button,{icon:'chat',label:t('coauthorToggle'),onClick:onToggleChat}),
        h(Button,{icon:'pin',label:t(fields.pinned?'nbUnpin':'nbPin'),pressed:fields.pinned,disabled:locked,onClick:()=>change({pinned:!fields.pinned})}),
        h(Button,{icon:'history',label:t('nbHistory'),onClick:()=>setHistory(true),disabled:operation}),
        h(Button,{icon:'download',label:t('nbExport'),onClick:exportNote}),
        note.trashedAt?h('button',{type:'button',className:'em-btn em-save btn btn-sm btn-primary',disabled:operation,onClick:restoreTrash},t('nbRestore')):
          h(R.Fragment,null,
            h(Button,{icon:'trash',label:t('nbTrashAction'),disabled:operation,onClick:()=>setConfirmTrash(!confirmTrash)}),
            h('button',{type:'button',className:'em-btn em-save btn btn-sm btn-primary',disabled:operation,onClick:save},t('save'))))),
    (state.conflict||notice||confirmTrash||note.trashedAt)&&h('div',{className:'nb-editor-notice'},
      notice&&h('span',{role:'status'},t(notice),notice==='nbInvalid'&&inputError&&h('small',{style:{display:'block',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},inputError)),
      note.trashedAt&&h('span',null,t('nbInTrash')),
      state.conflict&&h('div',{className:'nb-conflict'},
        h('span',null,t('nbConflictHint')),
        h('button',{type:'button',className:'em-btn btn btn-sm',disabled:operation,onClick:copy},t('nbSaveCopy')),
        confirmLatest?h(R.Fragment,null,
          h('span',null,t('nbDiscardHint')),
          h('button',{type:'button',className:'em-btn btn btn-sm',disabled:operation,onClick:latest},t('nbLoadLatest')),
          h('button',{type:'button',className:'em-btn btn btn-sm',disabled:operation,onClick:()=>setConfirmLatest(false)},t('cancel'))):
          h('button',{type:'button',className:'em-btn btn btn-sm',disabled:operation,onClick:()=>setConfirmLatest(true)},t('nbLoadLatest'))),
      confirmTrash&&h('div',{className:'nb-conflict'},
        h('span',null,t('nbTrashConfirm')),
        h('button',{type:'button',className:'em-btn btn btn-sm',disabled:operation,onClick:trash},t('nbTrashAction')),
        h('button',{type:'button',className:'em-btn btn btn-sm',disabled:operation,onClick:()=>setConfirmTrash(false)},t('cancel')))),
    h('div',{className:'nb-editor-body'},
    h('div',{className:'nb-scroll em-document nb-document-stage'},
      h('div',{className:'nb-document'},
        h(AutoTextarea,{
          inputRef:titleInput,fontSize,className:'nb-title-input',rows:1,value:fields.title,maxLength:200,
          disabled:locked,placeholder:t('nbUntitled'),'aria-label':t('nbNoteTitle'),onChange:e=>change({title:e.target.value})
        }),
        h('div',{className:'nb-properties'},
          h('label',null,h('span',null,t('nbCategory')),
            h(CategoryPicker,{categories,className:'form-select form-select-sm nb-note-category',value:fields.category,disabled:locked||categories.loading||categories.busy,ariaLabel:t('nbCategory'),onChange:value=>change({category:value})})),
          h('button',{type:'button',className:'em-btn nb-category-manage',onClick:onManageCategories},t('nbCatManage')),
          fields.category==='journal'&&h('label',null,h('span',null,t('nbDate')),
            h('input',{className:'form-control form-control-sm',type:'date',value:fields.journalDate,disabled:locked,onChange:e=>change({journalDate:e.target.value})})),
          h('label',{className:'nb-tags-input'},h('span',null,t('nbTags')),
            h('input',{
              ref:tagInput,className:'form-control form-control-sm',type:'text',value:tags,maxLength:820,
              disabled:locked,placeholder:t('nbTagsHint'),'aria-invalid':tagError,onChange:e=>editTags(e.target.value),
              onBlur:()=>{if(!tagError)setTags(session.snapshot().fields.tags.join(', '));}
            }))),
        tagError&&h('p',{className:'nb-warning'},t('nbTagsLimit')),
        h(MarkdownField,{
          value:fields.content,onChange:content=>change({content}),busy:!!note.trashedAt||(operation&&!saving),fontSize,maxLength:null,fieldRef:fieldActions,
          autoGrow:false,startEditing:fields.content.length>100000,label:t('nbContent'),headingPrefix,
          textareaProps:{className:'nb-content-input nb-source-viewport',rows:12,placeholder:t('nbWritePlaceholder')}
        }),
        h(AttachmentPanel,{ownerId:note.id,disabled:locked,
          onInsert:markdown=>{const content=session.snapshot().fields.content;let from=content.length;while(from>0&&content[from-1]==='\n')from--;if(!fieldActions.current?.applyRawChange({from,to:content.length,insert:'\n\n'+markdown+'\n'}))setNotice('nbError');}}),
        h('footer',{className:'nb-doc-footer'},
          h('span',null,fields.content.length.toLocaleString()+' '+t('nbChars')),
          h('span',null,noteTime(note.createdAt)+' · '+t('nbAutoHint'))))),
      outlineOpen&&h(DocumentOutline,{content:fields.content,headingPrefix,onNavigate:navigateHeading})),
    h('a',{ref:download,hidden:true}),
    history&&h(NotesHistory,{note,session,onClose:()=>setHistory(false),onReplace}));
}
return {NoteEditor};
}
