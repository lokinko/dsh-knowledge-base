import test from 'node:test';
import assert from 'node:assert/strict';
import {getMarkdownHeadings} from '../../src/client/markdown/renderer.js';
import {buildOutlineTree,visibleOutlineRows,outlineWindow,createDocumentOutline,OUTLINE_ROW_HEIGHT} from '../../src/client/markdown/outline.js';
const sourceOf=count=>Array.from({length:count},(_,i)=>`# Chapter ${i}\r\n\r\n😀 body ${i}\r\n`).join('\r\n');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function harness(renderService){
 const slots=[];let cursor=0,props,output,writes=0;
 const equal=(a,b)=>a&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 const R={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],next=>{writes++;slots[i]=typeof next==='function'?next(slots[i]):next;}];},
  useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  useMemo(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps)){slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};}},
  startTransition(fn){fn();},
 };
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(value=>value!==false&&value!==null&&value!==undefined)});
 const Component=createDocumentOutline({R,h,t:key=>key,renderService});
 const all=(node=output)=>typeof node==='object'?[node,...node.children.flatMap(all)]:[];
 return {render(next=props){props=next;cursor=0;output=Component(props);return output;},all,find:fn=>all().find(fn),links:()=>all().filter(node=>node.props.className==='nb-outline-link'),get output(){return output;},get writes(){return writes;},dispose(){for(const slot of slots)slot?.cleanup?.();}};
}
const nav=app=>app.find(node=>node.type==='nav');
function scroll(app,top){nav(app).props.onScroll({currentTarget:{scrollTop:top}});app.render();}

test('all 300 and 549 headings preserve real indexes and exact raw UTF-16 offsets',()=>{
 for(const count of [300,549]){
  const source=sourceOf(count),headings=getMarkdownHeadings(source);
  assert.equal(headings.length,count);
  for(let i=0;i<count;i++){assert.equal(headings[i].index,i);assert.equal(headings[i].offset,source.indexOf(`# Chapter ${i}\r`));}
  assert.equal(headings.at(-1).title,`Chapter ${count-1}`);
 }
});

test('heading tree uses actual levels through deep quotes and excludes fenced fake headings',()=>{
 const source='# Root\r\n\r\n> > > ### Deep quote\r\n> > >\r\n> > > #### Child\r\n\r\n## Sibling\r\n\r\n```md\r\n# Fake\r\n```\r\n\r\n# Next';
 const headings=getMarkdownHeadings(source),nodes=buildOutlineTree(headings);
 assert.deepEqual(headings.map(h=>h.title),['Root','Deep quote','Child','Sibling','Next']);
 assert.deepEqual(nodes.map(n=>n.depth),[0,1,2,1,0]);
 assert.equal(nodes[2].parentKey,nodes[1].key);assert.equal(nodes[3].parentKey,nodes[0].key);
 assert.equal(headings[1].offset,source.indexOf('> > > ###'));
 const folded=visibleOutlineRows(nodes,new Set([nodes[1].key]));
 assert.deepEqual(folded.map(n=>n.heading.title),['Root','Deep quote','Sibling','Next']);
 assert.equal(source.includes('#### Child'),true);
});

test('semantic fold keys survive unrelated body edits and distinguish duplicate sibling titles',()=>{
 const original='# A\n\n## Same\n\n### Leaf\n\n## Same\n\n### Other\n\n# B';
 const before=buildOutlineTree(getMarkdownHeadings(original));
 const after=buildOutlineTree(getMarkdownHeadings('😀 intro\n\n'+original.replace('### Leaf','body text\n\n### Leaf')));
 assert.deepEqual(before.map(n=>n.key),after.map(n=>n.key));
 assert.notEqual(before[1].key,before[3].key);
 const folded=visibleOutlineRows(after,new Set([before[1].key]));
 assert.deepEqual(folded.map(n=>n.heading.title),['A','Same','Same','Other','B']);
 assert.equal(before[2].heading.offset,original.indexOf('### Leaf'));
});

test('10,000-heading windows are complete with no more than 60 mounted rows',()=>{
 const nodes=buildOutlineTree(Array.from({length:10000},(_,index)=>({index,level:1,title:'H'+index,offset:index*30})));
 const rows=visibleOutlineRows(nodes,new Set());
 assert.equal(rows.length,10000);assert.equal(OUTLINE_ROW_HEIGHT,32);
 const reached=new Set();
 for(let top=0;top<rows.length*32;top+=384){
  const window=outlineWindow(rows.length,top,384);
  assert.ok(window.end-window.start<=60);
  assert.equal(window.top+window.bottom+(window.end-window.start)*32,10000*32);
  for(const row of rows.slice(window.start,window.end))reached.add(row.heading.index);
 }
 assert.equal(reached.size,10000);
 assert.equal(outlineWindow(2,1000000,384).scrollTop,0);
 assert.ok(outlineWindow(10000,32000,100000).end-outlineWindow(10000,32000,100000).start<=60);
});

test('all 549 navigation callbacks remain reachable while component DOM stays bounded',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const app=harness(),calls=[],content=sourceOf(549),props={content,headingPrefix:'long',onNavigate:heading=>calls.push(heading)};
 app.render(props);context.mock.timers.tick(180);app.render();
 const reached=new Set();
 for(let top=0;top<549*32;top+=384){
  scroll(app,top);assert.ok(app.links().length<=60);
  for(const link of app.links())if(!reached.has(link.props['data-outline-index'])){reached.add(link.props['data-outline-index']);link.props.onClick();}
 }
 assert.equal(reached.size,549);assert.equal(calls.length,549);
 assert.equal(calls.at(-1).index,548);assert.equal(calls.at(-1).offset,content.indexOf('# Chapter 548'));
 app.render();assert.equal(app.find(node=>node.props['aria-current']==='location').props['aria-label'],'Chapter 548');
 assert.equal(app.output.props.id,'long-outline');assert.equal(nav(app).props['aria-label'],'nbOutlineTitle');app.dispose();
});

test('fold and expand preserve source and remain stable across body-only edits',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const app=harness(),content='# Parent\n\n## Child\n\n# Next',props={content,headingPrefix:'fold'};
 app.render(props);context.mock.timers.tick(180);app.render();
 app.find(node=>node.props.className==='nb-outline-fold').props.onClick();app.render();
 assert.deepEqual(app.links().map(n=>n.props['aria-label']),['Parent','Next']);
 assert.equal(props.content,content);
 app.render({...props,content:'intro\n\n'+content});context.mock.timers.tick(180);app.render();
 assert.deepEqual(app.links().map(n=>n.props['aria-label']),['Parent','Next']);
 app.find(node=>node.props.className==='nb-outline-fold is-collapsed').props.onClick();app.render();
 assert.deepEqual(app.links().map(n=>n.props['aria-label']),['Parent','Child','Next']);app.dispose();
});

test('keyboard End/Home reach remote rows and arrows collapse without navigating or changing source',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const app=harness(),content=sourceOf(549),props={content,headingPrefix:'keys'};
 app.render(props);context.mock.timers.tick(180);app.render();let prevented=0;
 const event=(key,index)=>({key,target:{closest:()=>({getAttribute:name=>name==='data-outline-index'?String(index):null})},preventDefault(){prevented++;}});
 nav(app).props.onKeyDown(event('End',0));app.render();assert.ok(app.links().some(node=>node.props['aria-label']==='Chapter 548'));
 nav(app).props.onKeyDown(event('Home',548));app.render();assert.equal(app.links()[0].props['aria-label'],'Chapter 0');
 assert.equal(prevented,2);assert.equal(props.content,content);app.dispose();
});

test('async stale responses, pending old buttons and close cleanup cannot navigate or update state',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const requests=[],app=harness({headings(source){const request=deferred();requests.push({source,...request});return request.promise;}}),calls=[];
 const props={content:'# First',headingPrefix:'async',onNavigate:heading=>calls.push(heading)};
 app.render(props);context.mock.timers.tick(180);
 app.render({...props,content:'# Second'});context.mock.timers.tick(180);
 requests[1].resolve(getMarkdownHeadings('# Second'));await tick();app.render();
 assert.equal(app.links()[0].props['aria-label'],'Second');
 requests[0].resolve(getMarkdownHeadings('# First'));await tick();app.render();assert.equal(app.links()[0].props['aria-label'],'Second');
 app.render({...props,content:'# Third'});const staleButton=app.links()[0];assert.equal(staleButton.props.disabled,true);staleButton.props.onClick();assert.equal(calls.length,0);
 context.mock.timers.tick(180);app.dispose();const before=app.writes;
 requests[2].resolve(getMarkdownHeadings('# Third'));await tick();assert.equal(app.writes,before);
});
