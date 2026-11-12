import {BUILTIN_CATEGORIES,initialCategoryTree,categoryChildren,flattenCategories,isCategoryDescendant,categoryDropMove,categoryRowPosition} from './tree.js';

export function createCategoriesUI({R,h,t,Icon,Button,notebookRequest,noteCategoryKey}){
 const endpoint='/api/dsh-note/categories';
 const viewLabel=id=>t(({all:'nbAll',trash:'nbTrash'})[id]||noteCategoryKey[id]||'nbCatUnknown');
 const itemLabel=item=>item.name||t(noteCategoryKey[item.id]||'nbCatUnknown');
 function useCategories(){
  const [tree,setTree]=R.useState(initialCategoryTree),[loading,setLoading]=R.useState(true),[busy,setBusy]=R.useState(false),[error,setError]=R.useState(null),[ready,setReady]=R.useState(false);
  const alive=R.useRef(true),generation=R.useRef(0),writing=R.useRef(false),current=R.useRef(tree),loaded=R.useRef(false);
  function accept(next){if(!next||next.id!=='categories'||!Number.isSafeInteger(next.revision)||!Array.isArray(next.items))throw new Error(t('nbCatInvalidResponse'));current.current=next;loaded.current=true;setTree(next);setReady(true);}
  const refresh=R.useCallback(async()=>{
   if(writing.current)return null;
   const token=++generation.current;setLoading(true);setError(null);
   try{const response=await notebookRequest(endpoint,{action:'list'});if(!alive.current||token!==generation.current)return null;accept(response.tree);return response.tree;}
   catch(cause){if(alive.current&&token===generation.current)setError(t('nbCatLoadFailed')+(cause?.message?' '+cause.message:''));return null;}
   finally{if(alive.current&&token===generation.current)setLoading(false);}
  },[]);
  R.useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;generation.current++;};},[refresh]);
  const mutate=R.useCallback(async(action,input={})=>{
   if(writing.current||!alive.current||!loaded.current)return null;
   if(!['create','update','move'].includes(action))throw new TypeError('Unsupported category action');
   writing.current=true;const token=++generation.current;setBusy(true);setLoading(false);setError(null);
   try{const response=await notebookRequest(endpoint,{...input,action,revision:current.current.revision});if(!alive.current||token!==generation.current)return null;accept(response.tree);return response.tree;}
   catch(cause){
    if(!alive.current||token!==generation.current)return null;
    if(cause?.code==='CONFLICT'){
     try{const response=await notebookRequest(endpoint,{action:'list'});if(alive.current&&token===generation.current)accept(response.tree);}catch{}
     if(alive.current&&token===generation.current)setError(t('nbCatConflict'));
    }else setError(t('nbCatSaveFailed')+(cause?.message?' '+cause.message:''));
    return null;
   }finally{writing.current=false;if(alive.current&&token===generation.current)setBusy(false);}
  },[]);
  // Locale bindings are stable functions; recompute labels on each parent locale render.
  const flattened=flattenCategories(tree,itemLabel);
  const categoryLabel=id=>flattened.find(item=>item.id===id)?.label||viewLabel(id);
  return {tree,loading,busy,error,ready,refresh,mutate,categoryLabel,flattened};
 }
 function CategoryError({categories}){
  return categories.error?h('div',{className:'nb-cat-error',role:'alert'},h('p',null,categories.error),h('button',{type:'button',className:'nb-cat-link',disabled:categories.busy||categories.loading,onClick:()=>categories.refresh()},t('refresh'))):null;
 }
 function CategoryPicker({categories,value,onChange,includeViews=false,className='',ariaLabel,id,name,required=false,disabled=false,...props}){
  const options=categories.flattened;
  const option=(id,label)=>h('option',{key:id,value:id},label);
  return h('select',{...props,id,name,required,className,value,disabled:disabled||categories.busy||categories.loading,'aria-label':ariaLabel||props['aria-label']||t('nbCategory'),onChange:event=>onChange?.(event.target.value)},
   includeViews&&option('all',viewLabel('all')),
   value&&!options.some(item=>item.id===value)&&!['all','trash'].includes(value)&&option(value,categories.categoryLabel(value)),
   ...options.map(item=>option(item.id,'\u00a0\u00a0'.repeat(item.depth)+item.label+(item.depth?' · '+item.path:''))),
   includeViews&&option('trash',viewLabel('trash')));
 }
 function CategoryNavigation({categories,value,onChange,counts={},onManage,disabled=false,className='',includeViews=false}){
  const [collapsed,setCollapsed]=R.useState(()=>new Set());
  const locked=disabled||categories.busy;
  function toggle(id){setCollapsed(previous=>{const next=new Set(previous);next.has(id)?next.delete(id):next.add(id);return next;});}
  function row(id,label,depth=0,children=[]){
   const open=!collapsed.has(id),active=value===id;
   return h('li',{key:id,className:'nb-cat-nav-item'},h('div',{className:'nb-cat-nav-row',style:{'--nb-cat-depth':depth}},
    children.length?h('button',{type:'button',className:'nb-cat-toggle',disabled:locked,'aria-label':t(open?'nbCatCollapse':'nbCatExpand')+' '+label,'aria-expanded':open,onClick:()=>toggle(id)},h(Icon,{name:'chevron',size:13})):h('span',{className:'nb-cat-toggle-space'}),
    h('button',{type:'button',className:'nb-nav-item nb-cat-nav-button'+(active?' is-active active':''),'aria-current':active?'page':undefined,disabled:locked,onClick:()=>onChange?.(id)},h('span',null,label),counts[id]!==undefined&&h('small',null,counts[id]))),
    children.length&&open?h('ul',{className:'nb-cat-nav-children'},...children.map(item=>row(item.id,itemLabel(item),depth+1,categoryChildren(categories.tree,item.id)))):null);
  }
  return h('div',{className:'nb-category-navigation '+className},h('nav',{'aria-label':t('nbCategory')},h('ul',{className:'nb-cat-nav-list'},includeViews&&row('all',viewLabel('all')),...categoryChildren(categories.tree).map(item=>row(item.id,itemLabel(item),0,categoryChildren(categories.tree,item.id))),includeViews&&row('trash',viewLabel('trash')))),
   categories.loading&&h('p',{className:'nb-cat-status',role:'status'},t('loading')),h(CategoryError,{categories}),
   h('button',{type:'button',className:'nb-nav-item nb-cat-manage',disabled:locked,onClick:onManage},h(Icon,{name:'folder',size:15}),t('nbCatManage')));
 }
 function CategoryManager({categories,onClose}){
  const dialog=R.useRef(null),previousFocus=R.useRef(null),dragId=R.useRef(null),latest=R.useRef(categories);latest.current=categories;
  const [selectedId,setSelectedId]=R.useState(''),[newName,setNewName]=R.useState(''),[newParent,setNewParent]=R.useState(''),[rename,setRename]=R.useState(''),[moveParent,setMoveParent]=R.useState(''),[dragging,setDragging]=R.useState(null),[drop,setDrop]=R.useState(null),[notice,setNotice]=R.useState('');
  const titleId=R.useId(),descriptionId=R.useId();
  const selected=categories.flattened.find(item=>item.id===selectedId),locked=categories.busy||categories.loading||!categories.ready;
  R.useEffect(()=>{const node=dialog.current;previousFocus.current=node?.ownerDocument.activeElement;if(node&&!node.open)node.showModal();return()=>{if(node?.open)node.close();if(previousFocus.current?.isConnected)previousFocus.current.focus({preventScroll:true});};},[]);
  // A conflict refresh may change the selected record; keep the user's pending form input.
  R.useEffect(()=>{setRename(selected?.name||'');setMoveParent(selected?.parentId||'');},[selectedId]);
  function choose(item){setSelectedId(item.id);setNewParent(item.id);setNotice('');}
  function close(){if(!latest.current.busy)onClose?.();}
  async function change(action,input){setNotice('');const next=await categories.mutate(action,input);if(next){setNotice(t('nbCatSaved'));if(input.id===selectedId){if(action==='move')setMoveParent(input.parentId||'');if(action==='update')setRename(input.name);}}return next;}
  async function create(event){event.preventDefault();if(locked||!newName.trim())return;const next=await change('create',{name:newName.trim(),parentId:newParent||null});if(next)setNewName('');}
  async function saveName(event){event.preventDefault();if(locked||!selected||BUILTIN_CATEGORIES.includes(selected.id)||!rename.trim())return;await change('update',{id:selected.id,name:rename.trim()});}
  async function moveToParent(){if(locked||!selected)return;const parentId=moveParent||null;if(parentId&&isCategoryDescendant(categories.tree,parentId,selected.id))return;await change('move',{id:selected.id,parentId,beforeId:null});}
  async function moveSibling(direction){
   if(locked||!selected)return;
   const siblings=categoryChildren(categories.tree,selected.parentId),index=siblings.findIndex(item=>item.id===selected.id);
   if(direction<0&&index>0)await change('move',{id:selected.id,parentId:selected.parentId,beforeId:siblings[index-1].id});
   if(direction>0&&index<siblings.length-1)await change('move',{id:selected.id,parentId:selected.parentId,beforeId:siblings[index+2]?.id??null});
  }
  function startDrag(event,item){if(locked){event.preventDefault();return;}dragId.current=item.id;setDragging(item.id);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-dsh-note-category',item.id);event.dataTransfer.setData('text/plain',item.id);setNotice('');}
  function clearDrag(){dragId.current=null;setDragging(null);setDrop(null);}
  function over(event,item){
   if(locked||!dragId.current)return;
   const position=categoryRowPosition(event.clientY,event.currentTarget.getBoundingClientRect());
   if(!categoryDropMove(categories.tree,dragId.current,item.id,position)){setDrop(null);return;}
   event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';setDrop({id:item.id,position});
  }
  async function dropped(event,item){
   if(locked||!dragId.current)return;
   event.preventDefault();event.stopPropagation();
   const position=item?categoryRowPosition(event.clientY,event.currentTarget.getBoundingClientRect()):'inside';
   const move=categoryDropMove(categories.tree,dragId.current,item?.id??null,position);clearDrag();if(move)await change('move',move);
  }
  const siblings=selected?categoryChildren(categories.tree,selected.parentId):[],siblingIndex=siblings.findIndex(item=>item.id===selectedId);
  const parentOption=(item)=>h('option',{key:item.id,value:item.id},item.path);
  const dropText=drop?drop.id===null?t('nbCatDropRoot'):t(({before:'nbCatDropBefore',inside:'nbCatDropInside',after:'nbCatDropAfter'})[drop.position])+' '+categories.categoryLabel(drop.id):'';
  return h('dialog',{ref:dialog,className:'nb-category-dialog tm-bs','aria-labelledby':titleId,'aria-describedby':descriptionId,'aria-busy':categories.busy,onCancel:event=>{event.preventDefault();close();}},
   h('header',{className:'nb-cat-header'},h('div',null,h('h2',{id:titleId},t('nbCatManage')),h('p',{id:descriptionId},t('nbCatHint'))),h(Button,{icon:'close',label:t('close'),disabled:categories.busy,onClick:close})),
   h(CategoryError,{categories}),
   h('div',{className:'nb-cat-columns'},
    h('section',{className:'nb-cat-tree','aria-label':t('nbCatTree')},h('div',{className:'nb-cat-tree-head'},h('strong',null,t('nbCatTree')),h('button',{type:'button',className:'nb-cat-link',disabled:locked,onClick:()=>{setSelectedId('');setNewParent('');}},t('nbCatAddRoot'))),
     h('ul',{className:'nb-cat-manager-list'},...categories.flattened.map(item=>h('li',{key:item.id},h('div',{className:'nb-cat-manager-row'+(selectedId===item.id?' is-selected':'')+(dragging===item.id?' is-dragging':'')+(drop?.id===item.id?' drop-'+drop.position:''),style:{'--nb-cat-depth':item.depth},onDragOver:event=>over(event,item),onDrop:event=>dropped(event,item)},
      h('button',{type:'button',className:'nb-cat-drag',draggable:!locked,disabled:locked,'aria-label':t('nbCatDrag')+' '+item.label,title:t('nbCatDrag'),onDragStart:event=>startDrag(event,item),onDragEnd:clearDrag},h('svg',{width:18,height:18,viewBox:'0 0 18 18',fill:'currentColor','aria-hidden':true,focusable:false},...[4,9,14].flatMap(cy=>[6,12].map(cx=>h('circle',{key:cx+'-'+cy,cx,cy,r:1.6}))))),
      h('button',{type:'button',className:'nb-cat-select',disabled:locked,'aria-pressed':selectedId===item.id,onClick:()=>choose(item)},h('span',null,item.label),BUILTIN_CATEGORIES.includes(item.id)&&h('small',null,t('nbCatBuiltin'))),
      h('button',{type:'button',className:'nb-cat-child',disabled:locked,title:t('nbCatAddChild'),'aria-label':t('nbCatAddChild')+' '+item.label,onClick:()=>{choose(item);setNewParent(item.id);}},h(Icon,{name:'plus',size:13})))))),
     h('div',{className:'nb-cat-root-drop'+(drop?.id===null?' is-over':''),onDragOver:event=>{if(!locked&&dragId.current){event.preventDefault();event.dataTransfer.dropEffect='move';setDrop({id:null,position:'inside'});}},onDrop:event=>dropped(event,null)},t('nbCatDropRoot')),
     h('p',{className:'nb-cat-drop-description',role:'status','aria-live':'polite'},dropText||t('nbCatDragHint'))),
    h('section',{className:'nb-cat-editor','aria-label':t('nbCatEdit')},
     h('form',{onSubmit:create,className:'nb-cat-form'},h('h3',null,t('nbCatCreate')),h('label',null,t('nbCatName'),h('input',{className:'form-control',value:newName,maxLength:80,disabled:locked,required:true,onChange:event=>setNewName(event.target.value),placeholder:t('nbCatNamePlaceholder')})),
      h('label',null,t('nbCatParent'),h('select',{className:'form-select',value:newParent,disabled:locked,onChange:event=>setNewParent(event.target.value)},h('option',{value:''},t('nbCatRoot')),...categories.flattened.map(parentOption))),
      h('button',{type:'submit',className:'em-btn btn btn-primary',disabled:locked||!newName.trim()},t('nbCatCreate'))),
     selected?h('div',{className:'nb-cat-selected'},h('h3',null,selected.path),
      BUILTIN_CATEGORIES.includes(selected.id)?h('p',{className:'nb-cat-help'},t('nbCatBuiltinHint')):h('form',{onSubmit:saveName,className:'nb-cat-form'},h('label',null,t('nbCatRename'),h('input',{className:'form-control',value:rename,maxLength:80,disabled:locked,required:true,onChange:event=>setRename(event.target.value)})),h('button',{type:'submit',className:'em-btn btn',disabled:locked||!rename.trim()||rename.trim()===selected.name},t('save'))),
      h('div',{className:'nb-cat-form'},h('h3',null,t('nbCatMove')),h('label',null,t('nbCatParent'),h('select',{className:'form-select',value:moveParent,disabled:locked,onChange:event=>setMoveParent(event.target.value)},h('option',{value:''},t('nbCatRoot')),...categories.flattened.filter(item=>!isCategoryDescendant(categories.tree,item.id,selected.id)).map(parentOption))),
       h('button',{type:'button',className:'em-btn btn',disabled:locked||(moveParent||null)===selected.parentId,onClick:moveToParent},t('nbCatMoveToParent')),
       h('div',{className:'nb-cat-order-buttons'},h('button',{type:'button',className:'em-btn btn',disabled:locked||siblingIndex<=0,onClick:()=>moveSibling(-1)},t('nbCatMoveUp')),h('button',{type:'button',className:'em-btn btn',disabled:locked||siblingIndex<0||siblingIndex>=siblings.length-1,onClick:()=>moveSibling(1)},t('nbCatMoveDown')))),h('p',{className:'nb-cat-help'},t('nbCatKeyboardHint'))):h('p',{className:'nb-cat-help'},t('nbCatSelectHint')))),
   h('footer',{className:'nb-cat-footer'},h('span',{role:'status','aria-live':'polite'},categories.busy?t('saving'):notice),h('button',{type:'button',className:'em-btn btn',disabled:categories.busy,onClick:close},t('close'))));
 }
 return {useCategories,CategoryNavigation,CategoryPicker,CategoryManager};
}
