import assert from 'node:assert/strict';
import test from 'node:test';
import {getMarkdownHeadings,renderMarkdown} from '../../src/client/markdown/renderer.js';
import {createDocumentOutline} from '../../src/client/markdown/outline.js';
import {createMarkdownField} from '../../src/client/markdown/field.js';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

test('outline uses real Markdown headings and preserves original UTF-16 line offsets',()=>{
 const source='😀 intro\r\n\r\n# **Same** &amp; `code`\r\n\r\n```md\r\n# fake\r\n```\r\n\r\n    # indented code\r\n\r\nSetext *title*\r\n---\r\n\r\n> ## Quoted [link](https://example.com)\r\n>\r\n> Nested setext\r\n> ===\r\n\r\n# Same';
 const headings=getMarkdownHeadings(source);
 assert.deepEqual(headings,[
  {index:0,level:1,title:'Same & code',line:2,offset:source.indexOf('# **')},
  {index:1,level:2,title:'Setext title',line:10,offset:source.indexOf('Setext *')},
  {index:2,level:2,title:'Quoted link',line:13,offset:source.indexOf('> ##')},
  {index:3,level:1,title:'Nested setext',line:15,offset:source.indexOf('> Nested')},
  {index:4,level:1,title:'Same',line:18,offset:source.lastIndexOf('# Same')}
 ]);
 const html=renderMarkdown(source,{headingPrefix:'note-a'});
 assert.equal((html.match(/<h[1-6] /g)||[]).length,headings.length);
 for(const heading of headings)assert.ok(html.includes(`<h${heading.level} id="note-a-${heading.index}">`));
});

test('default rendering is compatible and repeated headings get distinct scoped IDs',()=>{
 const source='# repeat\n\n# repeat\n\n## repeat';
 assert.equal(renderMarkdown(source),'<h1>repeat</h1>\n<h1>repeat</h1>\n<h2>repeat</h2>\n');
 assert.equal(renderMarkdown(source,{}),renderMarkdown(source));
 assert.equal(renderMarkdown(source,{headingPrefix:''}),renderMarkdown(source));
 assert.deepEqual([...renderMarkdown(source,{headingPrefix:'a'}).matchAll(/id="([^"]+)"/g)].map(match=>match[1]),['a-0','a-1','a-2']);
 assert.ok(renderMarkdown(source,{headingPrefix:'b'}).includes('id="b-0"'));
});

test('titles are plain text and renderer escapes HTML and unsafe prefix attributes',()=>{
 const source='# <img src=x onerror=alert(1)> **bold** ![alt](https://example.com/a.png) &lt;safe&gt;\n\n## [unsafe](javascript:alert(1))';
 const headings=getMarkdownHeadings(source);
 assert.equal(headings[0].title,'<img src=x onerror=alert(1)> bold alt <safe>');
 const html=renderMarkdown(source,{headingPrefix:'x" onclick="evil<'});
 assert.ok(html.includes('id="x&quot; onclick=&quot;evil&lt;-0"'));
 assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
 assert.ok(!html.includes('<img src=x'));
 assert.ok(!html.includes('href="javascript:'));
 assert.ok(!headings[0].title.includes('<strong>'));
});

test('empty, end-of-file, CR-only lines and full outlines preserve navigation indexes',()=>{
 assert.deepEqual(getMarkdownHeadings(''),[]);
 assert.deepEqual(getMarkdownHeadings(null),[]);
 assert.deepEqual(getMarkdownHeadings('plain text'),[]);
 assert.deepEqual(getMarkdownHeadings('# EOF'),[{index:0,level:1,title:'EOF',line:0,offset:0}]);
 assert.deepEqual(getMarkdownHeadings('😀\rTitle\r===')[0],{index:0,level:1,title:'😀 Title',line:0,offset:0});
 assert.deepEqual(getMarkdownHeadings('intro\r\r# EOF')[0],{index:0,level:1,title:'EOF',line:2,offset:7});
 const source=Array.from({length:300},(_,i)=>`# title ${i}`).join('\n');
 const headings=getMarkdownHeadings(source);
 assert.equal(headings.length,300);
 assert.equal(headings.at(-1).index,299);
 assert.equal(headings.at(-1).offset,source.indexOf('# title 299'));
 assert.ok(renderMarkdown(source,{headingPrefix:'all'}).includes('id="all-299"'));
});

test('live field preserves source while standalone previews retain heading anchors',()=>{
 const sources=[];
 const h=(type,props,...children)=>{if(type?.name==='SourceEditor')sources.push(props.value);return React.createElement(type,props,...children);};
 const {MarkdownField,MarkdownPreview}=createMarkdownField({R:React,h,t:key=>key});
 const value='# Same\n\n# Same';
 const preview=renderToStaticMarkup(h(MarkdownPreview,{value,label:'Preview',headingPrefix:'preview'}));
 assert.ok(preview.includes('<h1 id="preview-0">Same</h1>'));
 assert.ok(preview.includes('<h1 id="preview-1">Same</h1>'));
 const field=renderToStaticMarkup(h(MarkdownField,{value,label:'Document',headingPrefix:'field',autoGrow:false}));
 assert.ok(field.includes('is-live'));
 assert.ok(!field.includes('em-md-modes'));
 assert.ok(field.includes('class="nb-source-editor"'));
 assert.equal(sources.at(-1),value);
});

function outlineHarness(){
 const state=[];let cursor=0,transitionCount=0;
 const equal=(a,b)=>a&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 const R={
  useState(initial){const index=cursor++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return [state[index],next=>{state[index]=typeof next==='function'?next(state[index]):next;}];},
  useRef(initial){const index=cursor++;return state[index]??={current:initial};},
  useMemo(fn,deps){const index=cursor++;if(!state[index]||!equal(state[index].deps,deps))state[index]={deps,value:fn()};return state[index].value;},
  useEffect(effect,deps){const index=cursor++;if(!state[index]||!equal(state[index].deps,deps)){state[index]?.cleanup?.();state[index]={deps,cleanup:effect()};}},
  startTransition(update){transitionCount++;update();}
 };
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(value=>value!==null&&value!==false&&value!==undefined)});
 const Component=createDocumentOutline({R,h,t:key=>key});
 return {render(props){cursor=0;return Component(props);},dispose(){for(const slot of state)slot?.cleanup?.();},get headings(){return state[0];},get transitions(){return transitionCount;},R,h};
}
function descendants(node){return typeof node==='object'?[node,...node.children.flatMap(descendants)]:[];}

test('outline defers parsing, debounces edits, exposes accessible buttons and cancels unmounts',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const app=outlineHarness(),calls=[],props={content:'# First',headingPrefix:'doc',onNavigate:heading=>calls.push(heading)};
 const initial=app.render(props);
 assert.equal(initial.type,'aside');
 assert.equal(initial.props['aria-label'],'nbOutlineTitle');
 assert.deepEqual(app.headings,[]);
 context.mock.timers.tick(179);assert.deepEqual(app.headings,[]);
 app.render({...props,content:'### Current'});
 context.mock.timers.tick(179);assert.deepEqual(app.headings,[]);
 context.mock.timers.tick(1);assert.equal(app.headings[0].title,'Current');
 const rendered=app.render({...props,content:'### Current'}),button=descendants(rendered).find(node=>node.props.className==='nb-outline-link');
 assert.equal(button.props['aria-label'],'Current');
 assert.equal(button.props.style['--nb-outline-depth'],2);
 button.props.onClick();assert.equal(calls[0].offset,0);
 assert.equal(app.transitions,1);
 app.render({...props,content:'# Cancel'});app.dispose();
 context.mock.timers.tick(500);assert.equal(app.headings[0].title,'Current');
 const exported=createMarkdownField({R:app.R,h:app.h,t:key=>key});
 assert.equal(typeof exported.DocumentOutline,'function');
});

test('large documents wait 500 ms without changing editor content',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const app=outlineHarness(),content='# Large\n\n'+'body '.repeat(22000),props={content,headingPrefix:'big'};
 app.render(props);context.mock.timers.tick(499);assert.deepEqual(app.headings,[]);
 context.mock.timers.tick(1);assert.equal(app.headings[0].title,'Large');
 assert.equal(props.content,content);app.dispose();
});
