import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {previewOffsets,previewWindow,createAsyncMarkdown} from '../../src/client/markdown/virtual-preview.js';

test('large preview keeps a bounded block window with conserved spacer height',()=>{
  const blocks=Array.from({length:30000},()=>({heightEstimate:48})),offsets=previewOffsets(blocks);
  for(const top of [0,250,90000,700000,offsets.at(-1)-600]){
    const window=previewWindow(offsets,top,600);
    assert.ok(window.end-window.start<=80);
    assert.ok(window.start>=0&&window.end<=blocks.length);
    assert.equal(window.before+(offsets[window.end]-offsets[window.start])+window.after,offsets.at(-1));
    assert.ok(offsets[window.start]<=Math.max(0,top));
    assert.ok(offsets[window.end]>=Math.min(offsets.at(-1),top+600));
  }
  assert.deepEqual(previewWindow([0],0,500),{start:0,end:0,before:0,after:0});
});

test('measurement cache adjusts offsets and forced headings mount even far outside viewport',()=>{
  const blocks=Array.from({length:1000},()=>({heightEstimate:40}));
  const offsets=previewOffsets(blocks,new Map([[0,100],[1,20]]));
  assert.equal(offsets[2],120);assert.equal(offsets.at(-1),40040);
  const window=previewWindow(offsets,0,600,{forcedIndex:970});
  assert.ok(window.start<=970&&window.end>970);assert.ok(window.end-window.start<=12);
  assert.equal(window.before,offsets[window.start]);
  const capped=previewWindow(offsets,0,100000,{maxBlocks:30});assert.equal(capped.end-capped.start,30);
});

test('small preview keeps existing DOM selectors and large preview does not synchronously render all content',()=>{
  const h=React.createElement,{MarkdownPreview}=createAsyncMarkdown({R:React,h,t:key=>key,renderService:{render(){throw Error('Effects do not run in SSR');}}});
  const small=renderToStaticMarkup(h(MarkdownPreview,{value:'# Heading\n\n- [ ] task',headingPrefix:'small',label:'Preview'}));
  assert.ok(small.includes('class="em-markdown"'));assert.ok(small.includes('id="small-0"'));
  assert.ok(small.includes('task-list-item-checkbox'));assert.ok(!small.includes('data-md-block'));
  const large=renderToStaticMarkup(h(MarkdownPreview,{value:'# Huge\n\n'+'paragraph\n\n'.repeat(5000),headingPrefix:'large',label:'Large'}));
  assert.ok(large.includes('em-markdown-virtual'));assert.ok(large.includes('aria-busy="true"'));
  assert.ok(!large.includes('<h1'));assert.ok(large.length<1000);
});

function harness(service){
  const state=[],refs=[],memos=[],effects=[];let cursor=0,scheduled=[],writes=0;
  const R={
    useState(initial){const index=cursor++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;writes++;}];},
    useRef(initial){const index=cursor++;return refs[index]??(refs[index]={current:initial});},
    useMemo(fn,deps){const index=cursor++;if(!memos[index]||deps.some((value,at)=>value!==memos[index].deps[at]))memos[index]={deps,value:fn()};return memos[index].value;},
    useEffect(fn,deps){const index=cursor++;if(!effects[index]||deps.some((value,at)=>value!==effects[index].deps[at]))scheduled.push(()=>{effects[index]?.cleanup?.();effects[index]={deps,cleanup:fn()};});},
    useLayoutEffect(fn,deps){this.useEffect(fn,deps);}
  };
  const h=(type,props,...children)=>({type,props,children});
  const {MarkdownPreview}=createAsyncMarkdown({R,h,t:key=>key,renderService:service});
  return {render(value,props={}){cursor=0;const output=MarkdownPreview({value,label:'Preview',headingPrefix:'test',...props});const pending=scheduled;scheduled=[];pending.forEach(fn=>fn());return output;},dispose(){effects.forEach(effect=>effect?.cleanup?.());},get writes(){return writes;}};
}
test('preview task toggles emit exact UTF-16 raw changes and rejected changes restore checkbox state',()=>{
  const app=harness({render(){throw Error('Small preview must not request a worker');}});
  const source='😀 intro\r\n\r\n- [ ] first\r\n  - [X] nested\r',calls=[];
  const output=app.render(source,{onChange:(next,change)=>{calls.push({next,change});return false;}});
  function input(index,checked){return {tagName:'INPUT',classList:{contains:name=>name==='task-list-item-checkbox'},getAttribute:()=>String(index),checked};}
  const first=input(0,true);output.props.onClick({target:first});
  const firstOffset=source.indexOf('[ ]')+1;
  assert.deepEqual(calls[0],{next:source.slice(0,firstOffset)+'x'+source.slice(firstOffset+1),change:{from:firstOffset,to:firstOffset+1,insert:'x'}});
  assert.equal(first.checked,false);
  const nested=input(1,false);output.props.onClick({target:nested});
  const nestedOffset=source.indexOf('[X]')+1;
  assert.deepEqual(calls[1],{next:source.slice(0,nestedOffset)+' '+source.slice(nestedOffset+1),change:{from:nestedOffset,to:nestedOffset+1,insert:' '}});
  assert.equal(nested.checked,true);app.dispose();
});

test('accepted task changes keep writing-field focus and never refocus disabled tasks or steal source focus',context=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'requestAnimationFrame'),frames=[];
  Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,writable:true,value:callback=>{frames.push(callback);return frames.length;}});
  context.after(()=>{if(descriptor)Object.defineProperty(globalThis,'requestAnimationFrame',descriptor);else delete globalThis.requestAnimationFrame;});
  const app=harness({render(){throw Error('Small preview must not request a worker');}});
  const output=app.render('- [ ] task',{onChange:()=>true}),doc={activeElement:null},focusCalls=[];
  const checkbox={tagName:'INPUT',checked:true,disabled:true,classList:{contains:()=>true},getAttribute:()=> '0',focus(options){focusCalls.push({kind:'task',options});doc.activeElement=this;}};
  const node={ownerDocument:doc,querySelector:()=>checkbox,focus(options){focusCalls.push({kind:'preview',options});doc.activeElement=this;}};
  output.props.ref.current=node;
  output.props.onClick({target:checkbox});assert.equal(node.tabIndex,-1);assert.equal(doc.activeElement,node);
  frames.shift()();assert.equal(doc.activeElement,node);assert.equal(focusCalls.length,1);
  checkbox.disabled=false;output.props.onClick({target:checkbox});frames.shift()();assert.equal(doc.activeElement,checkbox);
  output.props.onClick({target:checkbox});const sourceEditor={};doc.activeElement=sourceEditor;frames.shift()();assert.equal(doc.activeElement,sourceEditor);
  assert.equal(focusCalls.filter(call=>call.kind==='task').length,1);
  assert.ok(focusCalls.every(call=>call.options.preventScroll===true));app.dispose();
});

test('undo before debounce restores checkbox visuals even when preview HTML is unchanged',context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const app=harness({render(){throw Error('Small preview must not request a worker');}}),source='😀\r\n\r\n- [ ] task';
  const initial=app.render(source),checkbox={checked:true,disabled:false,getAttribute:()=> '0'};
  initial.props.ref.current={querySelectorAll:()=>[checkbox]};
  const changed=app.render(source.replace('[ ]','[x]'));
  assert.equal(changed.props['data-md-preview-state'],'rendering');assert.equal(checkbox.checked,true);assert.equal(checkbox.disabled,true);
  const undone=app.render(source);
  assert.equal(undone.props.dangerouslySetInnerHTML.__html,initial.props.dangerouslySetInnerHTML.__html);
  assert.equal(undone.props['data-md-preview-state'],'ready');assert.equal(checkbox.checked,false);assert.equal(checkbox.disabled,false);app.dispose();
});

test('preview instances use stable independent consumer identities and cancel their channel on unmount',context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const requests=[],cancelled=[];
  const service={render(source,options){requests.push({source,options});return new Promise(()=>{});},cancel(consumer){cancelled.push(consumer);}};
  const a=harness(service),b=harness(service),first='# First\n'+'body '.repeat(5000),next='# Next\n'+'body '.repeat(5000);
  a.render(first);b.render(first);
  assert.notEqual(requests[0].options.consumer,requests[1].options.consumer);
  a.render(next);context.mock.timers.tick(180);a.render(next);
  assert.equal(requests[2].options.consumer,requests[0].options.consumer);
  a.dispose();assert.deepEqual(cancelled,[requests[0].options.consumer]);
  b.dispose();assert.deepEqual(cancelled,[requests[0].options.consumer,requests[1].options.consumer]);
});

test('small live preview keeps its old picture and marks stale tasks unavailable until debounce',context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const app=harness({render(){throw Error('Small source should render synchronously');}});
  const initial=app.render('# Old\n\n- [ ] task');assert.ok(initial.props.dangerouslySetInnerHTML.__html.includes('Old'));
  const changing=app.render('# New\n\n- [ ] task');
  assert.equal(changing.props['data-md-preview-state'],'rendering');assert.ok(changing.props.dangerouslySetInnerHTML.__html.includes('Old'));
  context.mock.timers.tick(180);const ready=app.render('# New\n\n- [ ] task');
  assert.equal(ready.props['data-md-preview-state'],'ready');assert.ok(ready.props.dangerouslySetInnerHTML.__html.includes('New'));app.dispose();
});

test('live edits debounce before parsing; late and unmounted requests cannot publish stale state',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const pending=[];const app=harness({render(source){return new Promise(resolve=>pending.push({source,resolve}));}});
  const first='# First\n'+'body '.repeat(5000),second='# Second\n'+'body '.repeat(5000);
  app.render(first);app.render(second);assert.equal(pending.length,1);
  context.mock.timers.tick(179);app.render(second);assert.equal(pending.length,1);
  context.mock.timers.tick(1);app.render(second);assert.equal(pending.length,2);
  const before=app.writes;
  pending[0].resolve({blocks:[],headings:[],taskPositions:[]});await Promise.resolve();assert.equal(app.writes,before);
  pending[1].resolve({blocks:[],headings:[],taskPositions:[]});await Promise.resolve();assert.equal(app.writes,before+1);
  app.render(first);context.mock.timers.tick(180);app.render(first);app.dispose();const unmounted=app.writes;
  pending[2].resolve({blocks:[],headings:[],taskPositions:[]});await Promise.resolve();assert.equal(app.writes,unmounted);
});
