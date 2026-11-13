import test from 'node:test';
import assert from 'node:assert/strict';
import {initialCategoryTree,flattenCategories,categoryChildren,isCategoryDescendant,categoryDropMove,categoryRowPosition} from '../../src/client/categories/tree.js';
import {createCategoriesUI} from '../../src/client/categories/index.js';

const item=(id,parentId=null,order=0)=>({id,name:id.toUpperCase(),parentId,order});
const tree=(revision=1)=>({id:'categories',revision,items:[item('a',null,0),item('b',null,1),item('c',null,2),item('child','a',0),item('leaf','child',0)]});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

// This runner tests the hook's request/state protocol only. It does not render React or a DOM.
function hookRunner(request){
 const slots=[],effects=[],cleanups=[];let cursor=0,stateWrites=0;
 const R={
  useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],next=>{stateWrites++;slots[index]=typeof next==='function'?next(slots[index]):next;}];},
  useRef(initial){const index=cursor++;return slots[index]??=( {current:initial} );},
  useCallback(fn){const index=cursor++;return slots[index]??=fn;},
  useEffect(fn){const index=cursor++;if(!(index in slots)){slots[index]=true;effects.push(fn);}},
 };
 const components=createCategoriesUI({R,h:(type,props,...children)=>({type,props:props||{},children}),t:key=>'translated:'+key,Icon(){},Button(){},notebookRequest:request,noteCategoryKey:{document:'nbDocument',reading:'nbReading',code:'nbCode',journal:'nbJournal'}});
 const render=()=>{cursor=0;return components.useCategories();};
 return {components,render,mount(){const result=render();for(const effect of effects.splice(0)){const cleanup=effect();if(cleanup)cleanups.push(cleanup);}return result;},unmount(){for(const cleanup of cleanups.splice(0))cleanup();},get stateWrites(){return stateWrites;}};
}

test('flatten preserves tree order, depth and paths without mutating Host records',()=>{
 const input=tree(),before=structuredClone(input);
 const flat=flattenCategories(input);
 assert.deepEqual(flat.map(node=>node.id),['a','child','leaf','b','c']);
 assert.deepEqual(flat.map(node=>node.depth),[0,1,2,0,0]);
 assert.equal(flat[2].path,'A / CHILD / LEAF');
 assert.deepEqual(input,before);
 const fallback=initialCategoryTree();
 fallback.items[0].name='';
 assert.equal(flattenCategories(fallback,node=>node.name||'translated '+node.id)[0].label,'translated document');
});

test('drop positions map to precise insert-before operations, excluding the moving sibling',()=>{
 const input=tree();
 assert.deepEqual(categoryDropMove(input,'a','b','after'),{id:'a',parentId:null,beforeId:'c'});
 assert.deepEqual(categoryDropMove(input,'b','a','after'),{id:'b',parentId:null,beforeId:'c'});
 assert.deepEqual(categoryDropMove(input,'c','a','before'),{id:'c',parentId:null,beforeId:'a'});
 assert.deepEqual(categoryDropMove(input,'c','a','inside'),{id:'c',parentId:'a',beforeId:null});
 assert.deepEqual(categoryDropMove(input,'child',null,'inside'),{id:'child',parentId:null,beforeId:null});
 assert.deepEqual(categoryDropMove(input,'a','c','after'),{id:'a',parentId:null,beforeId:null});
});

test('self and descendant drops are rejected locally and corrupted cycles terminate',()=>{
 const input=tree();
 for(const position of ['before','inside','after']){
  assert.equal(categoryDropMove(input,'a','a',position),null);
  assert.equal(categoryDropMove(input,'a','leaf',position),null);
 }
 assert.equal(categoryDropMove(input,'missing','a','before'),null);
 assert.equal(categoryDropMove(input,'a','missing','before'),null);
 assert.equal(isCategoryDescendant(input,'leaf','a'),true);
 assert.equal(isCategoryDescendant(input,'b','a'),false);
 assert.equal(isCategoryDescendant({items:[item('x','y'),item('y','x')]},'x','other'),false);
 assert.equal(flattenCategories({items:[item('x','y'),item('y','x')]}).length,0);
});

test('row edge zones have exact top/inside/bottom boundaries',()=>{
 const bounds={top:10,height:100};
 assert.equal(categoryRowPosition(34,bounds),'before');
 assert.equal(categoryRowPosition(35,bounds),'inside');
 assert.equal(categoryRowPosition(85,bounds),'inside');
 assert.equal(categoryRowPosition(86,bounds),'after');
 assert.equal(categoryChildren(tree(),'a')[0].id,'child');
});

test('initial fallback stays available and initial load failure cannot issue revision-zero writes',async()=>{
 const calls=[],runner=hookRunner(async(path,input)=>{calls.push(input);throw new Error('offline');});
 const initial=runner.mount();
 assert.deepEqual(initial.flattened.map(node=>node.id),['document','reading','code','journal']);
 assert.equal(initial.ready,false);
 await tick();const failed=runner.render();
 assert.equal(failed.loading,false);assert.match(failed.error,/translated:nbCatLoadFailed/);
 assert.equal(await failed.mutate('create',{name:'New',parentId:null}),null);
 assert.equal(calls.length,1);
 runner.unmount();
});

test('refresh failure retains last tree and allows later recovery',async()=>{
 let available=true,revision=3;
 const runner=hookRunner(async()=>{if(!available)throw new Error('network failed');return {tree:tree(revision)};});
 runner.mount();await tick();
 assert.equal(runner.render().tree.revision,3);
 available=false;await runner.render().refresh();
 assert.equal(runner.render().tree.revision,3);assert.match(runner.render().error,/nbCatLoadFailed/);
 available=true;revision=4;await runner.render().refresh();
 assert.equal(runner.render().tree.revision,4);assert.equal(runner.render().error,null);
 runner.unmount();
});

test('CAS writes use current revision, prevent concurrent writes and ignore an older refresh reply',async()=>{
 const oldRead=deferred(),write=deferred(),calls=[];let reads=0;
 const runner=hookRunner(async(path,input)=>{
  assert.equal(path,'/api/dsh-note/categories');calls.push(input);
  if(input.action==='list')return ++reads===1?{tree:tree(5)}:oldRead.promise;
  return write.promise;
 });
 runner.mount();await tick();
 const refresh=runner.render().refresh();
 const mutation=runner.render().mutate('move',{id:'b',parentId:'a',beforeId:null});
 assert.equal(await runner.render().mutate('update',{id:'c',name:'Duplicate'}),null);
 assert.equal(calls.length,3);assert.equal(calls[2].revision,5);
 write.resolve({tree:tree(6)});await mutation;
 oldRead.resolve({tree:tree(4)});await refresh;
 assert.equal(runner.render().tree.revision,6);assert.equal(runner.render().busy,false);assert.equal(runner.render().loading,false);
 runner.unmount();
});

test('conflict reloads tree with a truthful retry message and next write uses new revision',async()=>{
 const calls=[];let reads=0,writes=0;
 const runner=hookRunner(async(path,input)=>{
  calls.push(input);
  if(input.action==='list')return {tree:tree(++reads===1?7:8)};
  if(++writes===1)throw Object.assign(new Error('conflict'),{code:'CONFLICT'});
  return {tree:tree(9)};
 });
 runner.mount();await tick();
 assert.equal(await runner.render().mutate('create',{name:'Retained',parentId:'a'}),null);
 assert.equal(runner.render().tree.revision,8);assert.equal(runner.render().error,'translated:nbCatConflict');
 await runner.render().mutate('create',{name:'Retained',parentId:'a'});
 assert.equal(calls.at(-1).revision,8);assert.equal(runner.render().tree.revision,9);assert.equal(runner.render().error,null);
 runner.unmount();
});

test('ordinary write failure preserves the tree, and unmounted reads cannot update state',async()=>{
 let first=true;const pending=deferred();
 const runner=hookRunner(async(path,input)=>{
  if(input.action!=='list')throw new Error('disk full');
  if(first){first=false;return {tree:tree(11)};}return pending.promise;
 });
 runner.mount();await tick();await runner.render().mutate('update',{id:'a',name:'New name'});
 assert.equal(runner.render().tree.revision,11);assert.match(runner.render().error,/disk full/);
 const read=runner.render().refresh();runner.unmount();const before=runner.stateWrites;
 pending.resolve({tree:tree(12)});await read;
 assert.equal(runner.stateWrites,before);
});

test('picker preserves an unknown saved category',()=>{
 const runner=hookRunner(async()=>({tree:tree()}));runner.mount();
 const categories=runner.render();
 const picker=runner.components.CategoryPicker({categories,value:'saved-custom-id',onChange(){},ariaLabel:'Select category'});
 assert.equal(picker.props.disabled,true);
 assert.equal(picker.props['aria-label'],'Select category');
 assert(picker.children.flat().some(option=>option?.props?.value==='saved-custom-id'));
 runner.unmount();
});
