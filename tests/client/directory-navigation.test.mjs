import test from 'node:test';
import assert from 'node:assert/strict';
import {DirectoryNoteCache,directoryRows,directoryWindow,categoryAncestors,visibleExpandedCategories,categoryMoveInverse,categoryUndoAllowed,DIRECTORY_ROW_HEIGHT} from '../../src/client/navigation/model.js';
import {createDirectoryNavigation} from '../../src/client/navigation/index.js';
const folder=(id,parentId=null,order=0)=>({id,name:id.toUpperCase(),parentId,order});
const tree=()=>({id:'categories',revision:10,items:[folder('a'),folder('b',null,1),folder('child','a'),folder('leaf','child')]});
const note=(id,category='a',title=id)=>({id,title,category,revision:1});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('cache requests only direct metadata pages, coalesces expansion reads, and retains pages on collapse',async()=>{
 const calls=[],cache=new DirectoryNoteCache(async(id,options)=>{calls.push([id,options]);return {notes:[{...note('n'+options.offset,id),content:'never retain body'}],total:2};});
 const pending=cache.load('a');await cache.load('a');await pending;
 assert.deepEqual(calls,[['a',{offset:0,limit:100}]]);
 assert.equal('content' in cache.get('a').notes[0],false);
 assert.deepEqual(directoryRows(tree(),new Set(),cache).map(row=>row.category?.id),['a','b']);
 await cache.load('a');assert.equal(calls.length,1);
 await cache.load('a',{more:true});assert.deepEqual(calls[1],['a',{offset:1,limit:100}]);
 assert.equal(cache.get('a').notes.length,2);await cache.load('a',{more:true});assert.equal(calls.length,2);
});

test('refresh ignores obsolete replies, and targeted file move invalidation preserves unrelated in-flight pages',async()=>{
 const pending=[],cache=new DirectoryNoteCache((id)=>{const request=deferred();pending.push({id,...request});return request.promise;});
 const old=cache.load('a');await tick();cache.invalidate();const fresh=cache.load('a');await tick();
 pending[1].resolve({notes:[note('fresh')],total:1});await fresh;
 pending[0].resolve({notes:[note('stale')],total:1});await old;
 assert.equal(cache.get('a').notes[0].id,'fresh');
 const other=cache.load('b');await tick();cache.invalidate(['a']);
 pending[2].resolve({notes:[note('other','b')],total:1});await other;
 assert.equal(cache.get('b').notes[0].id,'other');assert.equal(cache.get('a'),undefined);
});

test('failed pages retain earlier metadata and retry at the same offset; malformed pages cannot spin',async()=>{
 let step=0;const offsets=[],cache=new DirectoryNoteCache(async(id,{offset})=>{
  offsets.push(offset);if(++step===2)throw new Error('offline');
  return {notes:[note(offset?'next':'first')],total:2};
 });
 await cache.load('a');await cache.load('a',{more:true});assert.equal(cache.get('a').status,'error');
 assert.equal(cache.get('a').notes[0].id,'first');
 await cache.load('a',{more:true});assert.deepEqual(offsets,[0,1,1]);assert.equal(cache.get('a').notes.length,2);
 const invalid=new DirectoryNoteCache(async()=>({notes:[],total:9}));
 await invalid.load('a');assert.equal(invalid.get('a').status,'error');assert.match(invalid.get('a').error.message,/did not advance/);
 const wrong=new DirectoryNoteCache(async()=>({notes:[note('wrong','b')],total:1}));
 await wrong.load('a');assert.equal(wrong.get('a').status,'error');
});

test('dispose suppresses subscribers and obsolete requests through remount',async()=>{
 const request=deferred(),cache=new DirectoryNoteCache(()=>request.promise);let events=0;
 cache.subscribe(()=>events++);const pending=cache.load('a');await tick();cache.dispose();const before=events;cache.resume();
 request.resolve({notes:[note('old')],total:1});await pending;
 assert.equal(events,before);assert.equal(cache.get('a'),undefined);
});

test('visible tree rows respect hierarchy, collapse and loaded-title search without loading bodies',async()=>{
 let requests=0;const cache=new DirectoryNoteCache(async id=>{requests++;return {notes:[note('loaded',id,'Needle title')],total:1};});
 await cache.load('leaf');
 assert.deepEqual(directoryRows(tree(),new Set(),cache).map(row=>row.key),['category:a','category:b']);
 const rows=directoryRows(tree(),new Set(['a','child','leaf']),cache);
 assert.deepEqual(rows.filter(row=>row.kind==='category').map(row=>[row.category.id,row.depth]),[['a',0],['child',1],['leaf',2],['b',0]]);
 const filtered=directoryRows(tree(),new Set(),cache,item=>item.name,'needle');
 assert.deepEqual(filtered.map(row=>row.key),['category:a','category:child','category:leaf','note:loaded']);
 assert.equal(filtered.at(-1).depth,3);assert.equal(requests,1);
 assert.deepEqual(directoryRows(tree(),new Set(),cache,item=>item.name,'missing'),[]);
 assert.deepEqual(categoryAncestors(tree(),'leaf'),['leaf','child','a']);
 assert.deepEqual(visibleExpandedCategories(tree(),new Set(['a','child','leaf'])),['a','child','leaf']);
 assert.deepEqual(visibleExpandedCategories(tree(),new Set(['child','leaf'])),[]);
});

test('32px windows bound a 50,000-row directory and clamp scroll after collapse',()=>{
 const window=directoryWindow(50000,16000,320);
 assert.equal(DIRECTORY_ROW_HEIGHT,32);assert.equal(window.end-window.start,26);
 assert.equal(window.top+window.bottom+(window.end-window.start)*32,50000*32);
 const collapsed=directoryWindow(4,16000,320);
 assert.equal(collapsed.scrollTop,0);assert.equal(collapsed.start,0);assert.equal(collapsed.end,4);
});

test('move inverse restores previous sibling position and undo requires exactly the committed revision',()=>{
 const input=tree();
 assert.deepEqual(categoryMoveInverse(input,'a'),{id:'a',parentId:null,beforeId:'b'});
 assert.deepEqual(categoryMoveInverse(input,'leaf'),{id:'leaf',parentId:'child',beforeId:null});
 const history={inverse:categoryMoveInverse(input,'a'),expectedRevision:11};
 assert.equal(categoryUndoAllowed(history,{...input,revision:11}),true);
 assert.equal(categoryUndoAllowed(history,{...input,revision:12}),false);
 assert.equal(categoryUndoAllowed(history,{...input,revision:11,items:[]}),false);
});

// Minimal hook runner exercises callbacks/effect ordering. DOM rendering and styles
// belong to browser tests; these tests inspect the component's public interaction contract.
function panelRunner(extra={}){
 const slots=[],effects=[];let cursor=0,currentProps,output,dirty=false;
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((item,index)=>Object.is(item,b[index]));
 const R={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(!Object.is(value,slots[i])){slots[i]=value;dirty=true;}}];},
  useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  useMemo(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps)){const previous=slots[i];slots[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  useId(){const i=cursor++;return 'directory-'+i;},
  useLayoutEffect(fn,deps){return R.useEffect(fn,deps);},
 };
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(child=>child!==false&&child!==null&&child!==undefined)});
 const {DirectoryPanel}=createDirectoryNavigation({R,h,t:key=>key,Icon:()=>null,Button:()=>null});
 let currentTree=tree(),refreshes=0;const moves=[],opens=[],loads=[],noteMoves=[];
 function categories(){return {tree:currentTree,ready:true,loading:false,busy:false,error:null,flattened:currentTree.items.map(item=>({...item,label:item.name})),categoryLabel:id=>currentTree.items.find(item=>item.id===id)?.name||id,
  async refresh(){refreshes++;},async mutate(action,input){moves.push({action,input});if(extra.mutate)return extra.mutate(action,input);currentTree={...currentTree,revision:currentTree.revision+1};return currentTree;}};}
 currentProps={categories:categories(),activeCategory:null,activeNoteId:null,onOpenNote:value=>opens.push(value),onSelectCategory(){},onCreateNote(){},loadNotes:async(id,page)=>{loads.push([id,page]);return {notes:[note('file-'+id,id)],total:1};},onMoveNote:async(value,target)=>{noteMoves.push([value,target]);return {...value,category:target,revision:value.revision+1};},...extra.props};
 const render=()=>{cursor=0;dirty=false;currentProps={...currentProps,categories:categories()};output=DirectoryPanel(currentProps);for(const effect of effects.splice(0))effect();return output;};
 const all=(node=output)=>typeof node==='object'?[node,...node.children.flatMap(all)]:[];
 const find=predicate=>all().find(predicate);
 const byClass=name=>find(node=>(node.props.className||'').split(' ').includes(name));
 async function settle(){for(let i=0;i<8;i++){await tick();if(dirty||effects.length)render();}}
 render();
 return {render,settle,find,byClass,all,moves,opens,loads,noteMoves,get output(){return output;},get refreshes(){return refreshes;},setRevision(revision){currentTree={...currentTree,revision};render();},setProps(patch){currentProps={...currentProps,...patch};render();},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
const dragEvent=(fraction=.5)=>({clientY:32*fraction,currentTarget:{getBoundingClientRect:()=>({top:0,height:32})},dataTransfer:{setData(){},effectAllowed:'',dropEffect:''},preventDefault(){},stopPropagation(){}});
function folderRow(runner,id){return runner.find(node=>(node.props.className||'').includes('nb-directory-folder')&&node.children.some(child=>child?.props?.className==='nb-directory-name'&&child.props.title===id.toUpperCase()));}
const childClass=(row,name)=>row.children.find(child=>child?.props?.className?.split(' ').includes(name));

test('panel lazily expands once, opens exact metadata, and invalidates cache only on refreshToken',async()=>{
 const runner=panelRunner();await runner.settle();assert.equal(runner.loads.length,0);
 childClass(folderRow(runner,'a'),'nb-directory-toggle').props.onClick();runner.render();await runner.settle();
 assert.deepEqual(runner.loads,[['a',{offset:0,limit:100}]]);
 runner.byClass('nb-directory-file').children.find(child=>child.props.className==='nb-directory-name').props.onClick();
 assert.equal(runner.opens[0].id,'file-a');assert.equal('content' in runner.opens[0],false);
 childClass(folderRow(runner,'a'),'nb-directory-toggle').props.onClick();runner.render();
 childClass(folderRow(runner,'a'),'nb-directory-toggle').props.onClick();runner.render();await runner.settle();assert.equal(runner.loads.length,1);
 runner.setProps({refreshToken:1});await runner.settle();assert.equal(runner.loads.length,2);runner.unmount();
});

test('refreshing a collapsed parent does not load its previously expanded descendants',async()=>{
 const runner=panelRunner();await runner.settle();
 childClass(folderRow(runner,'a'),'nb-directory-toggle').props.onClick();runner.render();await runner.settle();
 childClass(folderRow(runner,'child'),'nb-directory-toggle').props.onClick();runner.render();await runner.settle();
 assert.equal(runner.loads.length,2);
 childClass(folderRow(runner,'a'),'nb-directory-toggle').props.onClick();runner.render();
 runner.setProps({refreshToken:1});await runner.settle();assert.equal(runner.loads.length,2);
 childClass(folderRow(runner,'a'),'nb-directory-toggle').props.onClick();runner.render();await runner.settle();
 assert.equal(runner.loads.length,4);runner.unmount();
});

test('category drag records exact inverse; undo refuses a later external revision and refreshes',async()=>{
 const runner=panelRunner();await runner.settle();
 childClass(folderRow(runner,'a'),'nb-directory-drag').props.onDragStart(dragEvent());
 await folderRow(runner,'b').props.onDrop(dragEvent());runner.render();await runner.settle();
 assert.deepEqual(runner.moves[0],{action:'move',input:{id:'a',parentId:'b',beforeId:null}});
 assert.ok(runner.byClass('nb-directory-undo'));
 runner.setRevision(12);await runner.byClass('nb-directory-undo').props.onClick();runner.render();
 assert.equal(runner.moves.length,1);assert.equal(runner.refreshes,1);
 assert.equal(runner.byClass('nb-directory-undo'),undefined);runner.unmount();
});

test('category undo submits original parent and beforeId once when revision still matches',async()=>{
 const runner=panelRunner();await runner.settle();
 childClass(folderRow(runner,'a'),'nb-directory-drag').props.onDragStart(dragEvent());
 await folderRow(runner,'b').props.onDrop(dragEvent());runner.render();await runner.settle();
 await runner.byClass('nb-directory-undo').props.onClick();runner.render();
 assert.deepEqual(runner.moves[1],{action:'move',input:{id:'a',parentId:null,beforeId:'b'}});
 assert.equal(runner.byClass('nb-directory-undo'),undefined);runner.unmount();
});

test('file drop delegates stable id/revision to parent callback and never mutates category tree',async()=>{
 const runner=panelRunner();await runner.settle();childClass(folderRow(runner,'a'),'nb-directory-toggle').props.onClick();runner.render();await runner.settle();
 childClass(runner.byClass('nb-directory-file'),'nb-directory-drag').props.onDragStart(dragEvent());
 await folderRow(runner,'b').props.onDrop(dragEvent());runner.render();await runner.settle();
 assert.deepEqual(runner.noteMoves,[[note('file-a'), 'b']]);assert.equal(runner.moves.length,0);assert.equal(runner.loads.length,2);runner.unmount();
});

test('root drop preserves inverse position, while failed category CAS creates no undo record',async()=>{
 const root=panelRunner();await root.settle();
 childClass(folderRow(root,'b'),'nb-directory-drag').props.onDragStart(dragEvent());
 await root.byClass('nb-directory-viewport').props.onDrop(dragEvent());root.render();
 assert.deepEqual(root.moves[0],{action:'move',input:{id:'b',parentId:null,beforeId:null}});root.unmount();
 const failed=panelRunner({mutate:async()=>null});await failed.settle();
 childClass(folderRow(failed,'a'),'nb-directory-drag').props.onDragStart(dragEvent());
 await folderRow(failed,'b').props.onDrop(dragEvent());failed.render();
 assert.equal(failed.byClass('nb-directory-undo'),undefined);failed.unmount();
});

test('component renders bounded rows and spacer heights across a large loaded directory',async()=>{
 const runner=panelRunner({props:{loadNotes:async id=>({notes:Array.from({length:5000},(_,i)=>note('n'+i,id)),total:5000})}});await runner.settle();
 childClass(folderRow(runner,'a'),'nb-directory-toggle').props.onClick();runner.render();await runner.settle();
 const mounted=()=>runner.all().filter(node=>(node.props.className||'').split(' ').includes('nb-directory-row'));
 assert.ok(mounted().length<40);assert.equal(mounted()[0].props.style.height,32);
 runner.byClass('nb-directory-viewport').props.onScroll({currentTarget:{scrollTop:64000}});runner.render();
 assert.ok(mounted().length<40);assert.ok(runner.all().some(node=>node.props.title==='n2000'));
 const spacers=runner.all().filter(node=>node.props.className==='nb-directory-spacer');
 assert.equal(spacers[0].props.style.height+spacers[1].props.style.height+mounted().length*32,5003*32);
 const before=runner.loads.length;
 runner.byClass('nb-directory-search').children.find(child=>child.type==='input').props.onChange({target:{value:'n2000'}});runner.render();await runner.settle();
 assert.equal(runner.loads.length,before);assert.ok(mounted().length<5);runner.unmount();
});

test('F2 is local to navigation, ignores IME and form fields, and failed rename preserves input',async()=>{
 const runner=panelRunner({mutate:async()=>null});await runner.settle();childClass(folderRow(runner,'a'),'nb-directory-name').props.onFocus();runner.render();
 let prevented=0;const event={key:'F2',preventDefault(){prevented++;},stopPropagation(){},target:{closest:()=>null}};
 runner.output.props.onKeyDown({...event,isComposing:true});runner.render();assert.equal(runner.byClass('nb-directory-form'),undefined);
 runner.output.props.onKeyDown({...event,target:{closest:()=>true}});runner.render();assert.equal(runner.byClass('nb-directory-form'),undefined);
 runner.output.props.onKeyDown(event);runner.render();assert.equal(prevented,1);
 const form=runner.byClass('nb-directory-form');form.children.find(child=>child.type==='input').props.onChange({target:{value:'Preserved'}});runner.render();
 await runner.byClass('nb-directory-form').props.onSubmit({preventDefault(){}});runner.render();
 assert.equal(runner.byClass('nb-directory-form').children.find(child=>child.type==='input').props.value,'Preserved');runner.unmount();
});
