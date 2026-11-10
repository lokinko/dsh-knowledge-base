function AutoTextarea({inputRef,fontSize,value,...props}){
 const area=R.useRef(null),resizeNow=R.useRef(()=>{}),scheduleResize=R.useRef(()=>{});
 const attach=R.useCallback(node=>{area.current=node;if(inputRef)inputRef.current=node;},[inputRef]);
 R.useLayoutEffect(()=>{
  const node=area.current;if(!node)return;
  const doc=node.ownerDocument,view=doc.defaultView;
  const mirror=doc.createElement('textarea');
  mirror.rows=1;mirror.tabIndex=-1;mirror.disabled=true;mirror.readOnly=true;mirror.spellcheck=false;mirror.setAttribute('aria-hidden','true');mirror.setAttribute('data-em-text-measure','');
  const metrics=['box-sizing','font-family','font-size','font-weight','font-style','font-variant','font-stretch','line-height','letter-spacing','word-spacing','text-indent','text-transform','text-align','direction','tab-size','white-space','word-break','overflow-wrap','padding-top','padding-bottom','padding-left','padding-right','border-top-width','border-bottom-width','border-left-width','border-right-width','border-style'];
  function prepare(element,style,width){
   for(const property of metrics)element.style.setProperty(property,style.getPropertyValue(property));
   Object.assign(element.style,{position:'fixed',top:'0px',left:'-100000px',width:width+'px',minWidth:'0px',maxWidth:'none',height:'0px',minHeight:'0px',maxHeight:'none',margin:'0px',overflow:'hidden',visibility:'hidden',pointerEvents:'none',contain:'layout style',resize:'none'});
  }
  Object.assign(mirror.style,{position:'fixed',left:'-100000px',top:'0px',width:'0px',height:'0px',minHeight:'0px',visibility:'hidden',pointerEvents:'none'});
  node.parentElement.appendChild(mirror);
  let caretMirror=null,frame=0,lastWidth=-1,revealPending=false;
  function revealCaret(style,scrollRoot){
   if(!scrollRoot||doc.activeElement!==node||node.selectionStart!==node.selectionEnd)return;
   if(!caretMirror){caretMirror=doc.createElement('div');caretMirror.setAttribute('aria-hidden','true');caretMirror.setAttribute('data-em-caret-measure','');node.parentElement.appendChild(caretMirror);}
   prepare(caretMirror,style,parseFloat(style.width)||node.getBoundingClientRect().width);caretMirror.style.height='auto';
   const position=node.selectionEnd??node.value.length;
   caretMirror.textContent=node.value.slice(0,position);
   const marker=doc.createElement('span');marker.textContent=node.value.slice(position)||'\u200b';caretMirror.appendChild(marker);
   const rect=marker.getClientRects()[0];if(!rect)return;
   const caretTop=node.getBoundingClientRect().top+rect.top-caretMirror.getBoundingClientRect().top;
   const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.5;
   const viewport=scrollRoot.getBoundingClientRect(),visual=view.visualViewport;
   const viewportTop=Math.max(viewport.top,visual?.offsetTop??0),viewportBottom=Math.min(viewport.bottom,visual?(visual.offsetTop+visual.height):view.innerHeight);
   const delta=caretScrollDelta({caretTop,caretBottom:caretTop+lineHeight,viewportTop,viewportBottom});
   if(Math.abs(delta)>.5)scrollRoot.scrollTop+=delta;
  }
  function resize(reveal=false){
   if(!node.isConnected||node.getBoundingClientRect().width===0)return;
   const style=view.getComputedStyle(node),scrollRoot=fieldScrollRoot(node),scrollTop=scrollRoot?.scrollTop;
   prepare(mirror,style,parseFloat(style.width)||node.getBoundingClientRect().width);mirror.value=node.value||node.placeholder||'';
   const height=fittedTextareaHeight({scrollHeight:mirror.scrollHeight,boxSizing:style.boxSizing,border:(parseFloat(style.borderTopWidth)||0)+(parseFloat(style.borderBottomWidth)||0),padding:(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0),minHeight:parseFloat(style.minHeight)||0});
   // Never collapse the live textarea to measure it: that clamps its parent's scroll position.
   if(node.style.height!==height+'px'){
    node.style.height=height+'px';
    if(scrollRoot)scrollRoot.scrollTop=scrollTop;
   }
   node.scrollTop=0;
   if(reveal&&!node.hasAttribute('data-em-preserve-scroll'))revealCaret(style,scrollRoot);
  }
  function schedule(reveal=false){revealPending=revealPending||reveal;view.cancelAnimationFrame(frame);frame=view.requestAnimationFrame(()=>{const requested=revealPending;revealPending=false;resize(requested);});}
  resizeNow.current=resize;scheduleResize.current=schedule;
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width||0;if(width!==lastWidth){lastWidth=width;schedule(doc.activeElement===node);}}):null;
  observer?.observe(node);
  const relayout=()=>schedule(doc.activeElement===node);
  view.addEventListener('resize',relayout);doc.fonts?.addEventListener('loadingdone',relayout);view.visualViewport?.addEventListener('resize',relayout);
  schedule();
  return()=>{view.cancelAnimationFrame(frame);observer?.disconnect();view.removeEventListener('resize',relayout);doc.fonts?.removeEventListener('loadingdone',relayout);view.visualViewport?.removeEventListener('resize',relayout);mirror.remove();caretMirror?.remove();resizeNow.current=()=>{};scheduleResize.current=()=>{};};
 },[]);
 R.useLayoutEffect(()=>{resizeNow.current(area.current?.ownerDocument.activeElement===area.current);},[value,fontSize]);
 function after(handler,event,interaction=false){if(interaction)area.current?.removeAttribute('data-em-preserve-scroll');handler?.(event);scheduleResize.current(!area.current?.hasAttribute('data-em-preserve-scroll'));}
 return h('textarea',{...props,value,wrap:'soft',spellCheck:false,ref:attach,onInput:e=>after(props.onInput,e,true),onFocus:e=>after(props.onFocus,e),onClick:e=>after(props.onClick,e,true),onSelect:e=>after(props.onSelect,e),onPointerDown:e=>{area.current?.removeAttribute('data-em-preserve-scroll');props.onPointerDown?.(e);},onKeyDown:e=>{area.current?.removeAttribute('data-em-preserve-scroll');props.onKeyDown?.(e);}});
}

function fieldScrollRoot(node){
 const view=node?.ownerDocument?.defaultView;if(!view)return null;
 for(let parent=node.parentElement;parent;parent=parent.parentElement){
  const overflow=view.getComputedStyle(parent).overflowY;
  if(overflow==='auto'||overflow==='scroll'||overflow==='overlay')return parent;
  if(parent.classList.contains('em-page'))break;
 }
 return null;
}
