import {StateEffect,StateField,Transaction} from '@codemirror/state';
import {Decoration,EditorView,ViewPlugin,WidgetType} from '@codemirror/view';
import {syntaxTree} from '@codemirror/language';
import {isolateHistory} from '@codemirror/commands';
import katex from 'katex';
import {renderMarkdown,highlightCode} from '../markdown/renderer.js';
import {mathParts} from './math-syntax.js';
import {runEditorCommand} from './commands.js';
import {LiveRenderCache} from './render-cache.js';

const viewport=StateEffect.define({map:(value,changes)=>({...value,ranges:value.ranges.map(range=>({from:changes.mapPos(range.from),to:changes.mapPos(range.to,1)}))})});
const rehighlight=StateEffect.define(),HIGHLIGHT_DEBOUNCE=80;
const hidden=Decoration.replace({});
const HIGHLIGHT_CLASS=/(?:^|\s)hljs-/;
const marks=new Map();
// Mark decorations are immutable; share one per class instead of allocating
// identical specs for every token on every rebuild.
const markFor=className=>{let mark=marks.get(className);if(!mark){mark=Decoration.mark({class:className});marks.set(className,mark);}return mark;};

class BulletWidget extends WidgetType{
 eq(){return true;}
 toDOM(view){const span=view.dom.ownerDocument.createElement('span');span.className='nb-live-bullet';span.textContent='•';span.setAttribute('aria-hidden','true');return span;}
}

class MathWidget extends WidgetType{
 constructor(source,block,label,locked=false,cache){super();this.source=source;this.block=block;this.label=label;this.locked=locked;this.cache=cache;}
 eq(other){return this.source===other.source&&this.block===other.block&&this.label===other.label&&this.locked===other.locked;}
 parts(source=this.source){return mathParts(source,this.block);}
 render(body){return this.cache.get('math:'+this.block+':'+body,()=>katex.renderToString(body,{displayMode:this.block,throwOnError:false,trust:false,strict:'ignore',maxExpand:1000,maxSize:20,output:'htmlAndMathml'}));}
 updateDOM(dom,view){
  if(dom.classList.contains('nb-live-math-block')!==this.block)return false;
  const parts=this.parts(),input=dom.querySelector('textarea');
  dom.dataset.source=this.source;
  if(dom.dataset.renderedSource!==parts.body){dom.querySelector('.nb-live-math-result').innerHTML=this.render(parts.body);dom.dataset.renderedSource=parts.body;}
  if(input.value!==parts.body){const start=input.selectionStart,end=input.selectionEnd,direction=input.selectionDirection;input.value=parts.body;if(input===dom.ownerDocument.activeElement)input.setSelectionRange(Math.min(start,input.value.length),Math.min(end,input.value.length),direction);}
  input.disabled=view.state.readOnly;dom.querySelector('button').disabled=view.state.readOnly;
  return true;
 }
 toDOM(view){
  const doc=view.dom.ownerDocument,dom=doc.createElement(this.block?'div':'span');
  dom.className='em-markdown nb-live-math'+(this.block?' nb-live-math-block':'');dom.contentEditable='false';
  const button=doc.createElement('button');button.type='button';button.className='nb-live-math-result';button.setAttribute('aria-label',this.label);
  const input=doc.createElement('textarea');input.className='nb-live-math-input';input.setAttribute('aria-label',this.label);input.rows=this.block?3:1;input.hidden=true;input.spellcheck=false;
  button.addEventListener('click',event=>{if(event.target.closest?.('a[href]'))return;event.preventDefault();input.hidden=!input.hidden;if(!input.hidden)input.focus();view.requestMeasure();});
  const commit=()=>{
   if(view.state.readOnly||view.composing||composing)return;
   const from=view.posAtDOM(dom),previous=dom.dataset.source;
   if(view.state.sliceDoc(from,from+previous.length)!==previous)return;
   const {open,close}=this.parts(previous),insert=open+input.value+close;
   if(insert!==previous){
    // Change only the edited span. Replacing the entire widget would rewrite
    // untouched mixed newline separators and make history unnecessarily large.
    let start=0,end=0;while(start<previous.length&&start<insert.length&&previous[start]===insert[start])start++;
    while(end<previous.length-start&&end<insert.length-start&&previous[previous.length-end-1]===insert[insert.length-end-1])end++;
    view.dispatch({changes:{from:from+start,to:from+previous.length-end,insert:insert.slice(start,insert.length-end)},annotations:Transaction.userEvent.of('input.type')});view.requestMeasure();
   }
  };
  let composing=false;
  input.addEventListener('compositionstart',()=>{composing=true;});
  input.addEventListener('compositionend',()=>{composing=false;queueMicrotask(()=>{if(dom.isConnected)commit();});});
  input.addEventListener('input',commit);
  input.addEventListener('keydown',event=>{
   if(event.isComposing||event.keyCode===229)return;
   if(event.key==='Escape'||(event.key==='Enter'&&(!this.block||event.ctrlKey||event.metaKey))){event.preventDefault();input.hidden=true;button.focus();view.requestMeasure();}
   else if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();runEditorCommand(view,event.key.toLowerCase()==='y'||event.shiftKey?'redo':'undo');}
   event.stopPropagation();
  });
  dom.addEventListener('focusout',()=>queueMicrotask(()=>{if(dom.isConnected&&!dom.contains(doc.activeElement)){input.hidden=true;view.requestMeasure();}}));
  dom.append(button,input);this.updateDOM(dom,view);return dom;
 }
 ignoreEvent(){return true;}
}

class RenderedWidget extends MathWidget{
 parts(source=this.source){return {body:source,open:'',close:''};}
 render(source){return this.cache.get('markdown:'+source,()=>renderMarkdown(source));}
}

class TaskWidget extends WidgetType{
 constructor(checked,label,locked=false){super();this.checked=checked;this.label=label;this.locked=locked;}
 eq(other){return this.checked===other.checked&&this.label===other.label&&this.locked===other.locked;}
 updateDOM(input,view){input.checked=this.checked;input.disabled=view.state.readOnly;input.setAttribute('aria-label',this.label);return true;}
 toDOM(view){
  const input=view.dom.ownerDocument.createElement('input');input.type='checkbox';input.className='task-list-item-checkbox nb-live-task';input.checked=this.checked;input.disabled=view.state.readOnly;input.setAttribute('aria-label',this.label);
  input.addEventListener('change',()=>{
   if(view.state.readOnly||view.composing)return;
   const from=view.posAtDOM(input),current=view.state.sliceDoc(from,from+3);
   if(!/^\[[ xX]\]$/.test(current))return;
   view.dispatch({changes:{from:from+1,to:from+2,insert:input.checked?'x':' '},annotations:[Transaction.userEvent.of('input.task'),isolateHistory.of('full')]});
  });
  input.addEventListener('keydown',event=>{if(!event.isComposing&&(event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();event.stopPropagation();runEditorCommand(view,event.key.toLowerCase()==='y'||event.shiftKey?'redo':'undo');}});
  return input;
 }
 ignoreEvent(){return true;}
}

const codeKey=(source,language)=>'code:'+language+'\n'+source;
function codeSpans(source,language,cache){
 return cache.get(codeKey(source,language),()=>{
  const html=highlightCode(source,language),result=[];
  if(!html||!globalThis.document)return result;
  const holder=globalThis.document.createElement('div');holder.innerHTML=html;
  let offset=0;const walk=element=>{for(const child of element.childNodes){if(child.nodeType===3)offset+=child.textContent.length;else{const start=offset;walk(child);if(child.className)result.push({from:start,to:offset,className:child.className});}}};
  walk(holder);return result;
 },value=>value.length*48);
}

// previous: the last decorations mapped into this state, or null to highlight
// synchronously. While typing in a code block the keystroke frame reuses the
// old token colours; highlight.js runs after that frame has been painted.
function buildDecorations(state,area,t,cache,previous=null){
 const result=[],seen=new Set(),tree=syntaxTree(state),doc=state.doc;let stale=false;
 const add=(decoration,from,to=from)=>{if(from<=to&&to<=doc.length)result.push(decoration.range(from,to));};
 const mark=(from,to,className)=>{if(to>from)add(markFor(className),from,to);};
 const hide=(from,to)=>{if(to>from)add(hidden,from,to);};
 const selected=(from,to)=>area.focused&&state.selection.ranges.some(range=>range.from<=to&&range.to>=from);
 const styleLines=(from,to,className)=>{
  for(const range of area.ranges){let line=doc.lineAt(Math.max(from,range.from));const end=Math.min(to,range.to);
   while(line.from<=end){add(Decoration.line({class:className}),line.from);if(line.to>=end||line.number===doc.lines)break;line=doc.line(line.number+1);}
  }
 };
 for(const range of area.ranges)tree.iterate({from:range.from,to:range.to,enter(ref){
  const {from,to,name}=ref,key=from+':'+to+':'+name;
  if(seen.has(key))return ['InlineMath','BlockMath','FencedCode','CodeBlock','Image','Table'].includes(name)?false:undefined;
  seen.add(key);
  const node=ref.node;
  if(name==='InlineMath'||name==='BlockMath'){
   if(!mathParts(doc.sliceString(from,to),name==='BlockMath').closed)return false;
   add(Decoration.replace({widget:new MathWidget(doc.sliceString(from,to),name==='BlockMath',t('wbMath'),state.readOnly,cache),block:name==='BlockMath'}),from,to);return false;
  }
  if(name==='Table'||name==='Image'){
   add(Decoration.replace({widget:new RenderedWidget(doc.sliceString(from,to),name==='Table',t(name==='Table'?'wbTable':'wbImage'),state.readOnly,cache),block:name==='Table'}),from,to);return false;
  }
  if(name==='FencedCode'||name==='CodeBlock'){
   styleLines(from,to,'nb-live-code');
   // Highlight only the visible portion of a code block. The highlighted HTML
   // comes from the existing safe Markdown renderer, never from note HTML.
   const info=node.getChild('CodeInfo'),language=info?doc.sliceString(info.from,info.to):'';
   const text=node.getChild('CodeText'),contentFrom=text?.from??from,contentTo=text?.to??to;
   for(const visible of area.ranges){
    const first=doc.lineAt(Math.max(from,visible.from)),last=doc.lineAt(Math.min(to,visible.to));
    const codeFrom=Math.max(contentFrom,first.from),codeTo=Math.min(contentTo,last.to);
    if(codeTo<=codeFrom||codeTo-codeFrom>30000)continue;
    const code=doc.sliceString(codeFrom,codeTo);
    if(previous&&!cache.has(codeKey(code,language))){
     stale=true;
     previous.between(codeFrom,codeTo,(spanFrom,spanTo,decoration)=>{const className=decoration.spec.class;if(className&&HIGHLIGHT_CLASS.test(className))mark(Math.max(spanFrom,codeFrom),Math.min(spanTo,codeTo),className);});
     continue;
    }
    for(const span of codeSpans(code,language,cache))mark(codeFrom+span.from,Math.min(codeFrom+span.to,codeTo),span.className);
   }
   for(let child=node.firstChild;child;child=child.nextSibling)if(child.name==='CodeMark'||child.name==='CodeInfo'){
    if(!selected(child.from,child.to)){hide(child.from,child.to);add(Decoration.line({class:'nb-live-fence'}),doc.lineAt(child.from).from);}
   }
   return false;
  }
  if(/^ATXHeading[1-6]$/.test(name)||/^SetextHeading[12]$/.test(name))styleLines(from,to,'nb-live-heading nb-live-h'+name.at(-1));
  if(name==='StrongEmphasis')mark(from,to,'nb-live-strong');
  if(name==='Emphasis')mark(from,to,'nb-live-emphasis');
  if(name==='Strikethrough')mark(from,to,'nb-live-strike');
  if(name==='InlineCode')mark(from,to,'nb-live-inline-code');
  if(name==='Blockquote')styleLines(from,to,'nb-live-quote');
  if(name==='Link'){
   const url=node.getChild('URL'),text=doc.sliceString(from,to),end=text.indexOf(']');
   if(url&&end>=0){
    const href=doc.sliceString(url.from,url.to);
    if(/^(https?:\/\/|mailto:|\/api\/dsh-note\/attachment-file\?)/i.test(href))add(Decoration.mark({class:'nb-live-link',attributes:{'data-href':href,title:href}}),from+1,from+end);
    if(!selected(from,to)){hide(from,from+1);hide(from+end,to);return false;}
   }
  }
  if(name==='TaskMarker'){
   const source=doc.sliceString(from,to),line=doc.lineAt(from);add(Decoration.replace({widget:new TaskWidget(source[1]!==' ',line.text.slice(to-line.from).trim()||t('wbTask'),state.readOnly)}),from,to);return false;
  }
  if(name==='ListMark'&&!selected(from,to)){
   if(node.parent?.getChild('Task'))hide(from,to);
   else if(/^[-+*]$/.test(doc.sliceString(from,to)))add(Decoration.replace({widget:new BulletWidget()}),from,to);
  }
  if(['HeaderMark','EmphasisMark','CodeMark','StrikethroughMark','QuoteMark'].includes(name)&&!selected(from,to)){
   let end=to;if(name==='HeaderMark'||name==='QuoteMark')while(end<doc.lineAt(to).to&&doc.sliceString(end,end+1)===' ')end++;
   hide(from,end);
  }
 }});
 return {decorations:Decoration.set(result,true),stale};
}

export function livePreview(t){
 const cache=new LiveRenderCache();
 const sameArea=(a,b)=>a.focused===b.focused&&a.ranges.length===b.ranges.length&&a.ranges.every((range,index)=>range.from===b.ranges[index].from&&range.to===b.ranges[index].to);
 function value(state,area,previous=null){const {decorations,stale}=buildDecorations(state,area,t,cache,previous);return {...area,tree:syntaxTree(state),decorations,stale,atomicRanges:decorations.update({filter:(_from,_to,decoration)=>!!decoration.spec.widget})};}
 const field=StateField.define({
  create(state){const area={ranges:[{from:0,to:Math.min(state.doc.length,8000)}],focused:false};return value(state,area);},
  update(previous,tr){
   const effect=tr.effects.find(effect=>effect.is(viewport)),refresh=tr.effects.some(effect=>effect.is(rehighlight));
   if(!tr.docChanged&&!tr.selection&&!effect&&!tr.reconfigured&&!refresh)return previous;
   const area=effect?.value||{ranges:previous.ranges.map(range=>({from:tr.changes.mapPos(range.from),to:tr.changes.mapPos(range.to,1)})),focused:previous.focused};
   if(!tr.docChanged&&!tr.selection&&!tr.reconfigured&&!refresh&&sameArea(previous,area)&&previous.tree===syntaxTree(tr.state))return previous;
   // Edits and caret moves keep existing colours; scrolling, reconfiguration
   // and the deferred refresh highlight newly needed code synchronously.
   const defer=!effect&&!refresh&&!tr.reconfigured;
   return value(tr.state,area,defer?previous.decorations.map(tr.changes):null);
  },
  provide:field=>[EditorView.decorations.from(field,value=>value.decorations),EditorView.atomicRanges.of(view=>view.state.field(field).atomicRanges)],
 });
 const watcher=ViewPlugin.fromClass(class{
  constructor(view){this.view=view;this.dead=false;this.pending=false;this.highlightJob=null;this.schedule();}
  // Re-highlight after the frame showing the keystroke, in idle time when the
  // browser offers it, so typing in a code block never waits on highlight.js.
  // A short debounce coalesces a burst of keys into one highlight pass.
  scheduleHighlight(restart){
   if(restart){this.highlightJob?.cancel();this.highlightJob=null;}
   if(this.highlightJob)return;
   const win=this.view.dom.ownerDocument.defaultView||globalThis,run=()=>{this.highlightJob=null;if(!this.dead&&this.view.state.field(field).stale)this.view.dispatch({effects:rehighlight.of(null)});};
   let idle=null;const timer=setTimeout(()=>{
    if(typeof win.requestIdleCallback!=='function'){run();return;}
    const id=win.requestIdleCallback(run,{timeout:100});idle=()=>win.cancelIdleCallback(id);
   },HIGHLIGHT_DEBOUNCE);
   this.highlightJob={cancel:()=>{clearTimeout(timer);idle?.();}};
  }
  // visibleRanges excludes replaced source. Use the continuous viewport so a
  // rendered formula cannot remove its own decoration on the next update.
  schedule(){if(this.pending)return;this.pending=true;queueMicrotask(()=>{this.pending=false;if(this.dead)return;const view=this.view,area={ranges:[{from:view.state.doc.lineAt(view.viewport.from).from,to:view.state.doc.lineAt(view.viewport.to).to}],focused:view.hasFocus},current=view.state.field(field);if(!sameArea(current,area)||current.tree!==syntaxTree(view.state))view.dispatch({effects:viewport.of(area)});});}
  update(update){if(update.viewportChanged||update.focusChanged||update.state.field(field).tree!==syntaxTree(update.state))this.schedule();if(update.state.field(field).stale)this.scheduleHighlight(update.docChanged);}
  destroy(){this.dead=true;this.highlightJob?.cancel();this.highlightJob=null;}
 });
 return [field,watcher,EditorView.domEventHandlers({click(event,view){
  const link=event.target.closest?.('.nb-live-link');if(link&&(event.ctrlKey||event.metaKey)){view.dom.ownerDocument.defaultView.open(link.dataset.href,'_blank','noopener,noreferrer');return true;}return false;
 }})];
}
