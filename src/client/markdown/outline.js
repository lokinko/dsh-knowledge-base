import {getMarkdownHeadings} from './renderer.js';

export const OUTLINE_ROW_HEIGHT=32;
export const OUTLINE_MAX_MOUNTED=60;
const OVERSCAN=4;

/** Parent is the nearest earlier heading with a smaller level, including skipped levels.
 * Keys follow semantic ancestor paths and duplicate occurrences, never source offsets. */
export function buildOutlineTree(headings){
 const nodes=[],stack=[],occurrences=new Map();
 for(const heading of headings){
  while(stack.length&&stack.at(-1).heading.level>=heading.level)stack.pop();
  const parent=stack.at(-1),identity=JSON.stringify([parent?.key??'',heading.level,heading.title]);
  const occurrence=occurrences.get(identity)||0;occurrences.set(identity,occurrence+1);
  const node={heading,key:identity+':'+occurrence,parentKey:parent?.key??null,depth:stack.length,children:[]};
  if(parent)parent.children.push(node.key);
  nodes.push(node);stack.push(node);
 }
 return nodes;
}
export function visibleOutlineRows(nodes,collapsed){
 const result=[];let hiddenDepth=null;
 for(const node of nodes){
  if(hiddenDepth!==null&&node.depth>hiddenDepth)continue;
  hiddenDepth=null;result.push(node);
  if(collapsed.has(node.key))hiddenDepth=node.depth;
 }
 return result;
}
export function outlineWindow(count,scrollTop,height=384){
 const viewport=Math.max(OUTLINE_ROW_HEIGHT,Math.min((OUTLINE_MAX_MOUNTED-2*OVERSCAN)*OUTLINE_ROW_HEIGHT,height||384));
 const top=Math.max(0,Math.min(scrollTop||0,Math.max(0,count*OUTLINE_ROW_HEIGHT-viewport)));
 const start=Math.max(0,Math.floor(top/OUTLINE_ROW_HEIGHT)-OVERSCAN);
 const end=Math.min(count,start+OUTLINE_MAX_MOUNTED,Math.ceil((top+viewport)/OUTLINE_ROW_HEIGHT)+OVERSCAN);
 return {start,end,top:start*OUTLINE_ROW_HEIGHT,bottom:(count-end)*OUTLINE_ROW_HEIGHT,scrollTop:top,viewport};
}

export function createDocumentOutline({R,h,t,renderService}){
 function DocumentOutline({content,headingPrefix,onNavigate}){
  const [headings,setHeadings]=R.useState([]),[parsedSource,setParsedSource]=R.useState(null),[active,setActive]=R.useState(null);
  const [collapsed,setCollapsed]=R.useState(()=>new Set()),[scrollTop,setScrollTop]=R.useState(0),[height,setHeight]=R.useState(384),[focused,setFocused]=R.useState(null);
  const viewport=R.useRef(null);
  const pending=parsedSource!==content;
  // Keep source synchronous and lossless. Async derivation is canceled by source
  // changes and closing the outline; stale worker replies never replace this view.
  R.useEffect(()=>{
   let current=true;
   const timer=setTimeout(()=>{
    const receive=next=>{
     const update=()=>{if(current){setHeadings(next);setParsedSource(content);setActive(null);setFocused(null);}};
     if(R.startTransition)R.startTransition(update);else update();
    };
    if(renderService)renderService.headings(content).then(receive,()=>receive([]));
    else receive(getMarkdownHeadings(content));
   },content?.length>100000?500:180);
   return ()=>{current=false;clearTimeout(timer);};
  },[content]);
  R.useEffect(()=>{
   const element=viewport.current;if(!element)return;
   const measure=()=>setHeight(element.clientHeight||384);measure();
   const Observer=globalThis.ResizeObserver;
   if(Observer){const observer=new Observer(measure);observer.observe(element);return()=>observer.disconnect();}
  },[]);
  const tree=R.useMemo(()=>buildOutlineTree(headings),[headings]);
  const rows=R.useMemo(()=>visibleOutlineRows(tree,collapsed),[tree,collapsed]);
  const window=outlineWindow(rows.length,scrollTop,height);
  R.useEffect(()=>{
   if(scrollTop!==window.scrollTop){setScrollTop(window.scrollTop);if(viewport.current)viewport.current.scrollTop=window.scrollTop;}
  },[rows.length,height,scrollTop]);
  R.useEffect(()=>{
   if(focused!==null&&!pending)viewport.current?.querySelector(`[data-outline-index="${focused}"]`)?.focus({preventScroll:true});
  },[focused,window.start,window.end,rows,pending]);
  function toggle(node){setCollapsed(previous=>{const next=new Set(previous);next.has(node.key)?next.delete(node.key):next.add(node.key);return next;});}
  function focusRow(position){
   const node=rows[position];if(!node)return;
   const top=position*OUTLINE_ROW_HEIGHT,bottom=top+OUTLINE_ROW_HEIGHT;
   let next=window.scrollTop;
   if(top<next)next=top;else if(bottom>next+window.viewport)next=bottom-window.viewport;
   setScrollTop(next);if(viewport.current)viewport.current.scrollTop=next;
   setFocused(node.heading.index);
  }
  function keys(event){
   if(pending||event.isComposing||event.nativeEvent?.isComposing||event.keyCode===229)return;
   const target=event.target?.closest?.('[data-outline-index],[data-outline-toggle]');
   const index=Number(target?.getAttribute('data-outline-index')??target?.getAttribute('data-outline-toggle'));
   const position=target?rows.findIndex(node=>node.heading.index===index):-1,node=rows[position];
   if(!node)return;
   if(event.key==='ArrowDown'){event.preventDefault();focusRow(Math.min(rows.length-1,position+1));}
   else if(event.key==='ArrowUp'){event.preventDefault();focusRow(Math.max(0,position-1));}
   else if(event.key==='Home'){event.preventDefault();focusRow(0);}
   else if(event.key==='End'){event.preventDefault();focusRow(rows.length-1);}
   else if(event.key==='ArrowRight'&&node.children.length){event.preventDefault();if(collapsed.has(node.key))toggle(node);else focusRow(position+1);}
   else if(event.key==='ArrowLeft'){
    event.preventDefault();
    if(node.children.length&&!collapsed.has(node.key))toggle(node);
    else if(node.parentKey){const parent=rows.findIndex(row=>row.key===node.parentKey);if(parent>=0)focusRow(parent);}
   }
  }
  function row(node){
   const heading=node.heading,folded=collapsed.has(node.key),hasChildren=node.children.length>0;
   return h('div',{key:`${headingPrefix}-${heading.index}`,className:'nb-outline-row',role:'treeitem','aria-level':node.depth+1,'aria-expanded':hasChildren?!folded:undefined,
    style:{height:OUTLINE_ROW_HEIGHT,minHeight:OUTLINE_ROW_HEIGHT,maxHeight:OUTLINE_ROW_HEIGHT,'--nb-outline-depth':heading.level-1}},
    hasChildren?h('button',{type:'button',className:'nb-outline-fold'+(folded?' is-collapsed':''),disabled:pending,'data-outline-toggle':heading.index,
     'aria-label':t(folded?'nbCatExpand':'nbCatCollapse')+' '+heading.title,'aria-expanded':!folded,onClick:()=>{if(!pending)toggle(node);}},folded?'▸':'▾'):h('span',{className:'nb-outline-fold-space','aria-hidden':true}),
    h('button',{type:'button',className:'nb-outline-link','data-outline-index':heading.index,
     'aria-label':heading.title,'aria-current':active===heading.index?'location':undefined,disabled:pending,
     style:{'--nb-outline-depth':heading.level-1},title:heading.title,
     onClick:()=>{if(!pending){setActive(heading.index);onNavigate?.(heading);}}
    },heading.title));
  }
  return h('aside',{id:headingPrefix+'-outline',className:'nb-document-outline','aria-label':t('nbOutlineTitle')},
   h('header',null,h('h3',null,t('nbOutlineTitle')),h('div',{className:'nb-outline-actions'},
    h('button',{type:'button',disabled:pending||!headings.length,'aria-label':t('nbCatExpand')+' '+t('nbOutlineTitle'),onClick:()=>setCollapsed(new Set())},'+'),
    h('button',{type:'button',disabled:pending||!headings.length,'aria-label':t('nbCatCollapse')+' '+t('nbOutlineTitle'),onClick:()=>setCollapsed(new Set(tree.filter(node=>node.children.length).map(node=>node.key)))},'−'))),
   h('nav',{ref:viewport,className:'nb-outline-viewport','aria-label':t('nbOutlineTitle'),'aria-busy':pending,onKeyDown:keys,onScroll:event=>setScrollTop(event.currentTarget.scrollTop),
    style:{overflowY:'auto',minHeight:0,maxHeight:(OUTLINE_MAX_MOUNTED-2*OVERSCAN)*OUTLINE_ROW_HEIGHT}},
    headings.length?h('div',{role:'tree','aria-label':t('nbOutlineTitle')},
     h('div',{className:'nb-outline-spacer','aria-hidden':true,style:{height:window.top}}),
     ...rows.slice(window.start,window.end).map(row),
     h('div',{className:'nb-outline-spacer','aria-hidden':true,style:{height:window.bottom}})):
     h('p',{className:'nb-outline-empty'},t(pending?'loading':'nbOutlineEmpty'))));
 }
 return DocumentOutline;
}
