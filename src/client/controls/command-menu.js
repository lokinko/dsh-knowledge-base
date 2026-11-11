export function createCommandMenus({R,h,t,Icon,notesRequest,noteTime}){
 const platformKey=()=>/Mac|iPhone|iPad/.test(navigator.platform)?'⌘':'Ctrl';
 const pretty=keys=>(keys||'').replaceAll('Mod',platformKey());
 function CommandMenu({mode='commands',actions=[],onOpenNote,onClose,categoryLabel}){
  const dialog=R.useRef(null),input=R.useRef(null),request=R.useRef(0),pendingChoose=R.useRef(null);
  const [resolvedQuery,setResolvedQuery]=R.useState(null);
  const [query,setQuery]=R.useState(''),[notes,setNotes]=R.useState([]),[loading,setLoading]=R.useState(mode==='notes'),[error,setError]=R.useState(false),[selected,setSelected]=R.useState(0);
  R.useEffect(()=>{dialog.current.showModal();input.current?.focus();return()=>{request.current++;dialog.current?.close();};},[]);
  R.useEffect(()=>{
   if(mode!=='notes')return;
   const sequence=++request.current;setLoading(true);setError(false);
   const timer=setTimeout(()=>{notesRequest({action:'list',query:query.trim(),limit:30}).then(result=>{if(sequence===request.current){setNotes(result.notes);setResolvedQuery(query);setLoading(false);}}).catch(()=>{if(sequence===request.current){setError(true);setLoading(false);}});},query?140:0);
   return()=>{clearTimeout(timer);request.current++;};
  },[query,mode]);
  const matches=mode==='notes'?notes:actions.filter(action=>(action.label+' '+(action.keys||'')).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  R.useEffect(()=>setSelected(0),[query,mode]);
  R.useEffect(()=>{setSelected(value=>Math.min(value,Math.max(0,matches.length-1)));dialog.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[selected,matches.length]);
  const ready=mode!=='notes'||(!loading&&!error&&resolvedQuery===query);
  R.useEffect(()=>{const intent=pendingChoose.current;if(ready&&intent?.query===query){pendingChoose.current=null;choose(matches[Math.min(intent.index,matches.length-1)]);}},[ready,notes,query]);
  function choose(item){if(!item||!ready)return;onClose();if(mode==='notes')onOpenNote(item);else item.run();}
  return h('dialog',{ref:dialog,className:'nb-command-dialog tm-bs','aria-label':t(mode==='notes'?'wbQuickOpen':'wbCommands'),onCancel:event=>{event.preventDefault();onClose();},onKeyDown:event=>{
   if(event.nativeEvent?.isComposing||event.keyCode===229)return;
   if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const step=event.key==='ArrowDown'?1:-1;setSelected(value=>matches.length?(value+step+matches.length)%matches.length:0);}
   else if(event.key==='Enter'){event.preventDefault();if(!ready){pendingChoose.current={query,index:selected};return;}choose(matches[Math.min(selected,matches.length-1)]);}
  }},
   h('header',{className:'nb-command-head'},h(Icon,{name:mode==='notes'?'search':'list',size:18}),h('input',{ref:input,type:'search',value:query,'aria-label':t(mode==='notes'?'wbFindNote':'wbFindCommand'),placeholder:t(mode==='notes'?'wbFindNote':'wbFindCommand'),onChange:event=>{pendingChoose.current=null;setQuery(event.target.value);},'aria-controls':'nb-command-options','aria-activedescendant':matches.length?'nb-command-option-'+Math.min(selected,matches.length-1):undefined}),h('button',{type:'button',className:'em-btn',onClick:onClose,'aria-label':t('close')},'Esc')),
   h('div',{id:'nb-command-options',className:'nb-command-results',role:'listbox','aria-label':t(mode==='notes'?'wbQuickOpen':'wbCommands'),'aria-busy':loading},
    error?h('p',{role:'alert'},t('nbError')):matches.length?matches.map((item,index)=>h('button',{key:item.id,id:'nb-command-option-'+index,type:'button',role:'option',disabled:!ready,'aria-selected':index===selected,className:'nb-command-option'+(index===selected?' is-selected':''),onMouseEnter:()=>setSelected(index),onClick:()=>choose(item)},
     h(Icon,{name:mode==='notes'?'note':item.icon||'list',size:16}),h('span',{className:'nb-command-option-text'},h('strong',null,mode==='notes'?(item.title||t('nbUntitled')):item.label),mode==='notes'&&h('small',null,categoryLabel?.(item.category)+' · '+noteTime(item.updatedAt))),mode!=='notes'&&item.keys&&h('kbd',null,pretty(item.keys)))):h('p',{className:'nb-command-empty'},t(loading?'loading':'wbNothing'))),
   h('footer',null,h('span',null,'↑ ↓ '+t('wbNavigate')),h('span',null,'Enter '+t('wbChoose'))));
 }
 function ShortcutHelp({actions=[],onClose}){
  const dialog=R.useRef(null);
  R.useEffect(()=>{dialog.current.showModal();return()=>dialog.current?.close();},[]);
  const editorKeys=[['Mod+B','wbBold'],['Mod+I','wbItalic'],['Mod+K','wbLink'],['Mod+F','wbFindInDocument'],['Mod+G','wbNextMatch'],['Mod+Z','wbUndo'],['Mod+Shift+Z','wbRedo'],['Tab / Shift+Tab','wbIndent'],['/','wbSlash']];
  return h('dialog',{ref:dialog,className:'nb-shortcut-dialog tm-bs','aria-label':t('wbShortcuts'),onCancel:event=>{event.preventDefault();onClose();}},
   h('header',null,h('h2',null,t('wbShortcuts')),h('button',{type:'button',className:'em-btn',onClick:onClose,'aria-label':t('close')},'×')),
   h('div',{className:'nb-shortcut-list'},...actions.filter(action=>action.keys).map(action=>h('div',{key:action.id},h('span',null,action.label),h('kbd',null,pretty(action.keys)))),...editorKeys.map(([keys,label])=>h('div',{key:label},h('span',null,t(label)),h('kbd',null,pretty(keys))))));
 }
 return {CommandMenu,ShortcutHelp};
}
