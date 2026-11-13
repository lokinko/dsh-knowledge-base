import {BUILTIN_CATEGORIES,categoryDropMove,categoryRowPosition,categoryDeleteTarget} from '../categories/tree.js';
import {DirectoryNoteCache,directoryRows,directoryWindow,categoryAncestors,visibleExpandedCategories,categoryMoveInverse,categoryUndoAllowed,DIRECTORY_ROW_HEIGHT} from './model.js';

export function createDirectoryNavigation({R,h,t,Icon,Button}){
 function DeleteCategoryDialog({deletion,busy,locked,onConfirm,onClose}){
  const dialog=R.useRef(null),cancel=R.useRef(null),heading=R.useId();
  R.useEffect(()=>{const node=dialog.current,previous=node?.ownerDocument.activeElement;if(node&&!node.open)node.showModal();cancel.current?.focus();return()=>{if(node?.open)node.close();const target=deletion.anchor?.isConnected?deletion.anchor:previous;if(target?.isConnected)target.focus({preventScroll:true});};},[]);
  return h('dialog',{ref:dialog,className:'nb-category-delete-dialog','aria-labelledby':heading,onCancel:event=>{event.preventDefault();if(!busy)onClose();}},
   h('h3',{id:heading},t('nbDirectoryDelete')+' · '+deletion.label),h('p',null,t('nbDirectoryDeleteHint').replace('{category}',()=>deletion.targetLabel)),
   h('div',{className:'nb-directory-form-actions'},h('button',{ref:cancel,type:'button',disabled:busy,onClick:onClose},t('nbDirectoryCancel')),h('button',{type:'button',className:'nb-category-delete-confirm',disabled:locked,onClick:onConfirm},t('nbDirectoryDeleteConfirm'))));
 }
 function DirectoryPanel({categories,activeCategory,activeNoteId,onSelectCategory,onOpenNote,onCreateNote,loadNotes,onMoveNote,onBeforeCategoryDelete,onCategoryDeleted,refreshToken,navigationState,disabled=false}){
  const latest=R.useRef(null);latest.current={categories,loadNotes,onMoveNote,onOpenNote,onSelectCategory,onCreateNote,onBeforeCategoryDelete,onCategoryDeleted};
  const [cache]=R.useState(()=>new DirectoryNoteCache((...args)=>latest.current.loadNotes(...args)));
  const [cacheVersion,setCacheVersion]=R.useState(0),[expanded,setExpanded]=R.useState(()=>new Set([...(navigationState?.current?.expanded||[]),...categoryAncestors(categories.tree,activeCategory)]));
  const [selected,setSelected]=R.useState(activeCategory||null),[search,setSearch]=R.useState(()=>navigationState?.current?.search||''),[scrollTop,setScrollTop]=R.useState(0),[height,setHeight]=R.useState(480);
  const [form,setForm]=R.useState(null),[name,setName]=R.useState(''),[busy,setBusy]=R.useState(false),[notice,setNotice]=R.useState(''),[history,setHistory]=R.useState(null),[drop,setDrop]=R.useState(null);
  const [menu,setMenu]=R.useState(null),[deletion,setDeletion]=R.useState(null),[menuPosition,setMenuPosition]=R.useState({left:0,top:0});
  const menuRef=R.useRef(null),menuId=R.useId();
  const viewport=R.useRef(null),field=R.useRef(null),drag=R.useRef(null),working=R.useRef(false),alive=R.useRef(true),formId=R.useId();
  const locked=disabled||busy||categories.busy||categories.loading||!categories.ready;
  R.useEffect(()=>{if(navigationState)navigationState.current={expanded,search};},[expanded,search,navigationState]);
  R.useEffect(()=>{alive.current=true;cache.resume();const off=cache.subscribe(()=>setCacheVersion(value=>value+1));return()=>{alive.current=false;off();cache.dispose();};},[cache]);
  R.useEffect(()=>{cache.invalidate();},[cache,refreshToken,categories.tree.revision]);
  R.useEffect(()=>{for(const id of visibleExpandedCategories(categories.tree,expanded))void cache.load(id);},[cache,expanded,refreshToken,categories.tree]);
  R.useEffect(()=>{
   if(!activeCategory)return;
   setSelected(activeCategory);
   setExpanded(previous=>{const next=new Set(previous);for(const id of categoryAncestors(categories.tree,activeCategory))next.add(id);return next;});
  },[activeCategory,categories.ready]);
  R.useEffect(()=>{
   const element=viewport.current;if(!element)return;
   const measure=()=>setHeight(Math.max(DIRECTORY_ROW_HEIGHT,element.clientHeight||480));measure();
   const Observer=globalThis.ResizeObserver;
   if(Observer){const observer=new Observer(measure);observer.observe(element);return()=>observer.disconnect();}
  },[]);
  R.useEffect(()=>{if(form){field.current?.focus();field.current?.select();}},[form]);
  const label=item=>categories.categoryLabel(item.id);
  // Language labels may change without a tree revision; body keystrokes do not
  // invalidate the row calculation or trigger directory requests.
  const labels=categories.flattened?.map(item=>item.label).join('\u0000')||'';
  const rows=R.useMemo(()=>directoryRows(categories.tree,expanded,cache,label,search),[categories.tree,expanded,cacheVersion,search,labels]);
  const window=directoryWindow(rows.length,scrollTop,height);
  R.useEffect(()=>{if(scrollTop!==window.scrollTop){setScrollTop(window.scrollTop);if(viewport.current)viewport.current.scrollTop=window.scrollTop;}},[rows.length,height,scrollTop]);
  const selectedCategory=categories.tree.items.find(item=>item.id===selected);
  const menuCategory=categories.tree.items.find(item=>item.id===menu?.id);
  function closeMenu(focus=false){if(focus&&menu?.anchor.isConnected)menu.anchor.focus({preventScroll:true});setMenu(null);}
  R.useLayoutEffect(()=>{
   if(!menu)return;if(!menu.anchor.isConnected||!menuCategory){setMenu(null);return;}
   const box=menu.anchor.getBoundingClientRect(),panel=menuRef.current.parentElement.getBoundingClientRect(),popup=menuRef.current.getBoundingClientRect(),win=menu.anchor.ownerDocument.defaultView;
   const leftEdge=Math.max(panel.left,0)+4,rightEdge=Math.min(panel.right,win.innerWidth)-4;
   const topEdge=Math.max(panel.top,0)+4,bottomEdge=Math.min(panel.bottom,win.innerHeight)-4;
   const top=box.bottom+4+popup.height<=bottomEdge?box.bottom+4:box.top-popup.height-4;
   setMenuPosition({left:Math.max(leftEdge,Math.min(box.right-popup.width,rightEdge-popup.width))-panel.left,top:Math.max(topEdge,Math.min(top,bottomEdge-popup.height))-panel.top});
   menuRef.current?.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  },[menu]);
  R.useEffect(()=>{
   if(!menu)return;const doc=menu.anchor.ownerDocument;
   const outside=event=>{if(!menuRef.current?.contains(event.target)&&!menu.anchor.contains(event.target))setMenu(null);};
   const resize=()=>setMenu(null);doc.addEventListener('pointerdown',outside,true);doc.defaultView.addEventListener('resize',resize);
   return()=>{doc.removeEventListener('pointerdown',outside,true);doc.defaultView.removeEventListener('resize',resize);};
  },[menu]);
  function message(key,cause){return t(key)+(cause?.message?' '+cause.message:'');}
  function begin(kind,item=null){if(locked)return;setForm({kind,id:item?.id??null});setName(kind==='rename'?item.name:'');setNotice('');}
  function toggle(id){setExpanded(previous=>{const next=new Set(previous);next.has(id)?next.delete(id):next.add(id);return next;});}
  function selectFolder(item){setSelected(item.id);onSelectCategory?.(item.id);setExpanded(previous=>previous.has(item.id)?previous:new Set([...previous,item.id]));}
  async function run(operation){
   if(working.current||disabled||latest.current.categories.busy||latest.current.categories.loading||!latest.current.categories.ready)return null;
   working.current=true;setBusy(true);setNotice('');
   try{return await operation();}catch(cause){if(alive.current)setNotice(message('nbDirectoryOperationFailed',cause));return null;}
   finally{working.current=false;if(alive.current)setBusy(false);}
  }
  async function submit(event){
   event.preventDefault();if(!form||!name.trim())return;
   const request=form.kind==='rename'?{id:form.id,name:name.trim()}:{name:name.trim(),parentId:form.id};
   const next=await run(()=>latest.current.categories.mutate(form.kind==='rename'?'update':'create',request));
   if(next&&alive.current){
    if(form.kind!=='rename'&&form.id)setExpanded(previous=>new Set([...previous,form.id]));
    setForm(null);setName('');setNotice(t('nbDirectorySaved'));
   }
  }
  function confirmDelete(item){
   closeMenu();const targetId=categoryDeleteTarget(categories.tree,item.id);if(!targetId)return;
   setForm(null);setDeletion({id:item.id,label:categories.categoryLabel(item.id),revision:categories.tree.revision,targetId,targetLabel:categories.categoryLabel(targetId),anchor:menu?.anchor});
  }
  async function deleteCategory(){
   if(!deletion||locked)return;const intent=deletion;
   const next=await run(async()=>{
    if(latest.current.onBeforeCategoryDelete&&await latest.current.onBeforeCategoryDelete()===false)throw new Error(t('nbDirectoryDeleteFlushFailed'));
    return latest.current.categories.mutate('delete',{id:intent.id,revision:intent.revision});
   });
   if(!alive.current)return;setDeletion(null);
   if(!next)return;
   const target=next.redirects?.find(item=>item.id===intent.id)?.targetId||intent.targetId;
   setHistory(null);setNotice(t('nbDirectoryDeleted'));setSelected(target);setExpanded(previous=>new Set([...previous,...categoryAncestors(next,target)]));
   if(activeCategory===intent.id)latest.current.onSelectCategory?.(target);
   try{await latest.current.onCategoryDeleted?.(next);}catch{if(alive.current)setNotice(t('nbDirectoryDeleteRefreshFailed'));}
  }
  function clearDrag(){drag.current=null;setDrop(null);}
  function startDrag(event,value){
   if(locked){event.preventDefault();return;}
   drag.current=value;event.dataTransfer.effectAllowed='move';
   event.dataTransfer.setData(value.kind==='category'?'application/x-dsh-note-category':'application/x-dsh-note-file',value.kind==='category'?value.id:value.note.id);
   setNotice('');
  }
  function dragTarget(event,item){
   const source=drag.current;if(!source||locked)return null;
   if(source.kind==='note')return item&&source.note.category!==item.id?{kind:'note',id:item.id,position:'inside'}:null;
   const position=item?categoryRowPosition(event.clientY,event.currentTarget.getBoundingClientRect()):'inside';
   return categoryDropMove(latest.current.categories.tree,source.id,item?.id??null,position)?{kind:'category',id:item?.id??null,position}:null;
  }
  function over(event,item){
   const target=dragTarget(event,item);if(!target){setDrop(null);return;}
   event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';
   setDrop(previous=>previous?.id===target.id&&previous?.position===target.position?previous:target);
  }
  async function moveCategory(move){
   const before=latest.current.categories.tree,inverse=categoryMoveInverse(before,move.id);
   const next=await run(()=>latest.current.categories.mutate('move',move));
   if(next&&alive.current&&next.revision!==before.revision){
    setHistory({inverse,expectedRevision:next.revision});setNotice(t('nbDirectoryMoved'));
    if(move.parentId)setExpanded(previous=>new Set([...previous,move.parentId]));
   }
  }
  async function dropped(event,item){
   const source=drag.current,target=dragTarget(event,item);if(!source||!target)return;
   event.preventDefault();event.stopPropagation();clearDrag();
   if(source.kind==='category'){
    const move=categoryDropMove(latest.current.categories.tree,source.id,target.id,target.position);
    if(move)await moveCategory(move);
   }else{
    const result=await run(()=>latest.current.onMoveNote?.(source.note,target.id));
    if(result&&alive.current){
     cache.invalidate([source.note.category,target.id]);
     const visible=new Set(visibleExpandedCategories(latest.current.categories.tree,expanded));
     for(const id of [source.note.category,target.id])if(visible.has(id))void cache.load(id);
     setNotice(t('nbDirectoryNoteMoved'));
    }
   }
  }
  async function undo(){
   if(locked||!history)return;
   if(!categoryUndoAllowed(history,latest.current.categories.tree)){
    setNotice(t('nbDirectoryUndoStale'));setHistory(null);await latest.current.categories.refresh();return;
   }
   const next=await run(()=>latest.current.categories.mutate('move',history.inverse));
   if(alive.current){
    // A failed CAS is not replayed. The categories hook refreshes on conflict.
    setHistory(null);
    if(next)setNotice(t('nbDirectoryUndone'));
   }
  }
  function keys(event){
   if(event.isComposing||event.nativeEvent?.isComposing||event.keyCode===229)return;
   const target=event.target;
   if(target?.closest?.('input,textarea,select,[contenteditable="true"]'))return;
   if(event.key==='F2'&&selectedCategory&&!BUILTIN_CATEGORIES.includes(selectedCategory.id)&&!locked){event.preventDefault();event.stopPropagation();begin('rename',selectedCategory);}
  }
  const rowStyle=depth=>({height:DIRECTORY_ROW_HEIGHT,minHeight:DIRECTORY_ROW_HEIGHT,maxHeight:DIRECTORY_ROW_HEIGHT,boxSizing:'border-box',paddingInlineStart:8+depth*16});
  function renderRow(row,index){
   if(row.kind==='category'){
    const item=row.category;
    return h('div',{key:row.key,role:'treeitem','aria-level':row.depth+1,'aria-expanded':row.open,'aria-selected':activeCategory===item.id,'aria-posinset':undefined,
      className:'nb-directory-row nb-directory-folder'+(activeCategory===item.id?' is-active':'')+(selected===item.id?' is-selected':'')+(drop?.id===item.id?' drop-'+drop.position:''),
      style:rowStyle(row.depth),onDragOver:event=>over(event,item),onDrop:event=>dropped(event,item)},
     h('button',{type:'button',className:'nb-directory-drag',draggable:!locked,disabled:locked,'aria-label':t('nbDirectoryDragFolder')+' '+row.label,title:t('nbDirectoryDragHint'),onDragStart:event=>startDrag(event,{kind:'category',id:item.id}),onDragEnd:clearDrag},'⋮⋮'),
     h('button',{type:'button',className:'nb-directory-toggle'+(row.open?' is-open':''),disabled:disabled,'aria-label':t(row.open?'nbDirectoryCollapse':'nbDirectoryExpand')+' '+row.label,'aria-expanded':row.open,onClick:()=>toggle(item.id)},h(Icon,{name:'chevron',size:12})),
     h('button',{type:'button',className:'nb-directory-name',disabled:disabled,title:row.label,'aria-current':activeCategory===item.id?'page':undefined,onFocus:()=>setSelected(item.id),onClick:()=>selectFolder(item)},h(Icon,{name:'folder',size:15}),h('span',{className:'nb-directory-title'},row.label)),
     h('button',{type:'button',className:'nb-directory-category-actions',disabled:locked,title:t('nbDirectoryCategoryActions'),'aria-label':t('nbDirectoryCategoryActions')+' '+row.label,'aria-haspopup':'menu','aria-expanded':menu?.id===item.id,'aria-controls':menu?.id===item.id?menuId:undefined,onClick:event=>menu?.id===item.id?closeMenu():setMenu({id:item.id,anchor:event.currentTarget,anchorTop:event.currentTarget.getBoundingClientRect().top})},'⋯'));
   }
   if(row.kind==='note'){
    const note=row.note,title=note.title||t('nbUntitled');
    return h('div',{key:row.key,role:'treeitem','aria-level':row.depth+1,'aria-selected':activeNoteId===note.id,
      className:'nb-directory-row nb-directory-file'+(activeNoteId===note.id?' is-active':''),style:rowStyle(row.depth)},
     h('button',{type:'button',className:'nb-directory-drag',draggable:!locked&&Boolean(onMoveNote),disabled:locked||!onMoveNote,'aria-label':t('nbDirectoryDragNote')+' '+title,onDragStart:event=>startDrag(event,{kind:'note',note}),onDragEnd:clearDrag},'⋮⋮'),
     h('button',{type:'button',className:'nb-directory-name',disabled:disabled,title,'aria-current':activeNoteId===note.id?'page':undefined,onClick:()=>latest.current.onOpenNote?.(note)},h(Icon,{name:'note',size:14}),h('span',{className:'nb-directory-title'},title)));
   }
   const action=row.kind==='more'||row.kind==='retry';
   const text=t(({loading:'nbDirectoryLoading',empty:'nbDirectoryEmpty',retry:'nbDirectoryRetry',more:'nbDirectoryMore'})[row.kind]);
   return h('div',{key:row.key,role:'none',className:'nb-directory-row nb-directory-status',style:rowStyle(row.depth)},action?
    h('button',{type:'button',className:'nb-directory-page',disabled:disabled,onClick:()=>cache.load(row.categoryId,{more:row.kind==='more'||Boolean(cache.get(row.categoryId)?.notes.length)})},text):h('span',{role:row.kind==='loading'?'status':undefined},text));
  }
  const dropLabel=drop?t(drop.id===null?'nbDirectoryDropRoot':({before:'nbDirectoryDropBefore',after:'nbDirectoryDropAfter',inside:'nbDirectoryDropInside'})[drop.position])+(drop.id===null?'':' '+categories.categoryLabel(drop.id)):'';
  return h('section',{className:'nb-directory-panel','aria-label':t('nbDirectoryTitle'),'aria-busy':busy||categories.loading,onKeyDown:keys},
   menu&&menuCategory&&h('div',{ref:menuRef,id:menuId,role:'menu','aria-label':t('nbDirectoryCategoryActions')+' '+categories.categoryLabel(menuCategory.id),className:'nb-directory-category-menu',style:{position:'absolute',...menuPosition},onKeyDown:event=>{
    if(event.nativeEvent?.isComposing||event.keyCode===229)return;
    const buttons=[...menuRef.current.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(event.target);
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);}
    else if(event.key==='Tab')closeMenu();
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
   }},h('button',{type:'button',role:'menuitem',disabled:locked,onClick:()=>{closeMenu();begin('create',menuCategory);}},h(Icon,{name:'plus',size:14}),t('nbDirectoryAddChild')),
    h('button',{type:'button',role:'menuitem',className:'is-danger',disabled:locked||!categoryDeleteTarget(categories.tree,menuCategory.id),title:categories.tree.items.length===1?t('nbDirectoryKeepCategory'):undefined,onClick:()=>confirmDelete(menuCategory)},h(Icon,{name:'trash',size:14}),t('nbDirectoryDelete'))),
   deletion&&h(DeleteCategoryDialog,{deletion,busy,locked,onConfirm:deleteCategory,onClose:()=>setDeletion(null)}),
   h('div',{className:'nb-directory-toolbar'},
    h('strong',null,t('nbDirectoryTitle')),
    h('button',{type:'button',className:'nb-directory-action',disabled:locked,onClick:()=>begin('create'),title:t('nbDirectoryAddRoot'),'aria-label':t('nbDirectoryAddRoot')},h(Icon,{name:'folder',size:14}),h(Icon,{name:'plus',size:11})),
    h('button',{type:'button',className:'nb-directory-action',disabled:locked||!selectedCategory,onClick:()=>selectedCategory&&onCreateNote?.(selectedCategory.id),title:t('nbDirectoryNewNote'),'aria-label':t('nbDirectoryNewNote')},h(Icon,{name:'plus',size:14}))),
   h('label',{className:'nb-directory-search'},h('span',{className:'nb-directory-search-label'},t('nbDirectorySearch')),h('input',{type:'search',value:search,placeholder:t('nbDirectorySearchPlaceholder'),'aria-label':t('nbDirectorySearch'),onChange:event=>{setSearch(event.target.value);setScrollTop(0);if(viewport.current)viewport.current.scrollTop=0;}})),
   form&&h('form',{className:'nb-directory-form',onSubmit:submit},
    h('label',{htmlFor:formId},t(form.kind==='rename'?'nbDirectoryRename':form.id?'nbDirectoryAddChild':'nbDirectoryAddRoot')+(form.id?' · '+categories.categoryLabel(form.id):'')),
    h('input',{ref:field,id:formId,value:name,maxLength:80,required:true,disabled:locked,onChange:event=>setName(event.target.value),onKeyDown:event=>{if(event.key==='Escape'&&!event.nativeEvent?.isComposing&&!event.isComposing){event.stopPropagation();setForm(null);}}}),
    h('div',{className:'nb-directory-form-actions'},h('button',{type:'submit',disabled:locked||!name.trim()},t('nbDirectorySave')),h('button',{type:'button',disabled:busy,onClick:()=>setForm(null)},t('nbDirectoryCancel')))),
   history&&h('button',{type:'button',className:'nb-directory-undo',disabled:locked,onClick:undo},h(Icon,{name:'back',size:13}),t('nbDirectoryUndo')),
   categories.error&&h('div',{className:'nb-directory-error',role:'alert'},categories.error,h('button',{type:'button',disabled:locked,onClick:()=>categories.refresh()},t('nbDirectoryRefresh'))),
   h('div',{ref:viewport,className:'nb-directory-viewport'+(drop?.id===null?' is-root-over':''),role:'tree','aria-label':t('nbDirectoryTitle'),style:{overflowY:'auto',minHeight:0,flex:'1 1 auto'},onScroll:event=>{if(menu&&Math.abs(menu.anchor.getBoundingClientRect().top-menu.anchorTop)>1)setMenu(null);setScrollTop(event.currentTarget.scrollTop);},
    onDragOver:event=>{if(!event.target?.closest?.('.nb-directory-row'))over(event,null);},onDrop:event=>{if(!event.target?.closest?.('.nb-directory-row'))dropped(event,null);}},
    h('div',{'aria-hidden':true,className:'nb-directory-spacer',style:{height:window.top}}),
    ...rows.slice(window.start,window.end).map(renderRow),
    h('div',{'aria-hidden':true,className:'nb-directory-spacer',style:{height:window.bottom}}),
    !rows.length&&h('p',{className:'nb-directory-no-match'},t('nbDirectoryNoMatch'))),
   h('p',{className:'nb-directory-notice',role:'status','aria-live':'polite',hidden:!(dropLabel||notice)},dropLabel||notice));
 }
 return {DirectoryPanel};
}
