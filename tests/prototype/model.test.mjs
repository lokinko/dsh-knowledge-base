import test from 'node:test';
import assert from 'node:assert/strict';
import {SCENES,CONTENT_ROLES,createDefaultLayout,validateLayout,moveNode,patchNode,resetScene,effectiveProps,findNode,childrenOf,LayoutHistory} from '../../prototypes/workbench/model.js';

const modify=(layout,id,patch)=>{const node=findNode(layout,id);Object.assign(node,patch);return layout;};
const add=(layout,id,parentId,scene='library',type='container',props={})=>{layout.nodes.push({id,type,name:id,parentId,scene,props});return layout;};
const chinese=error=>error instanceof Error&&/[\u4e00-\u9fff]/.test(error.message);

test('defaults expose stable shared controls and four independent scene roots',()=>{
 const layout=createDefaultLayout();
 assert.equal(layout.version,1);assert.equal(layout.nodes.length,59);
 assert.deepEqual(childrenOf(layout,'workspace').map(node=>node.id),['global-nav','scene-host']);
 assert.deepEqual(childrenOf(layout,'scene-host').map(node=>node.id),['scene-library','scene-read','scene-edit','scene-topics']);
 assert.deepEqual(SCENES,['shared','library','read','edit','topics']);
 assert.equal(findNode(layout,'library-grid').props.role,'note-cards');assert.equal(findNode(layout,'folder-tree').props.role,'folders');
 assert.equal(findNode(layout,'read-document').props.role,'document');assert.equal(findNode(layout,'edit-editor').props.role,'editor');
 assert.equal(findNode(layout,'topics-chat').parentId,'topics-body');assert.equal(findNode(layout,'topics-evidence').parentId,'topics-body');assert.equal(findNode(layout,'topics-body').props.direction,'row');
 for(const id of ['read-outline','read-coauthor','edit-outline','edit-coauthor'])assert.equal(findNode(layout,id).props.hidden,true);
 for(const id of ['brand','nav-library','nav-topics','nav-search','new-note','search-notes','library-view','topic-new','topic-new-note'])assert(findNode(layout,id),id);
 assert.equal(findNode(layout,'missing'),null);
});

test('phone defaults use content-sized scenes and explicit heights for scrolling content',()=>{
 const layout=createDefaultLayout(),phone=id=>effectiveProps(findNode(layout,id),true);
 for(const scene of ['library','read','edit','topics'])assert.equal(phone('scene-'+scene).height,'auto');
 for(const id of ['library-main','read-main','edit-main','topics-main','topics-body','topics-evidence'])assert.equal(phone(id).height,'auto');
 for(const [id,height] of [['folder-tree',140],['topics-question-list',100],['topics-reader',260],['read-document',500],['edit-editor',500]])assert.equal(phone(id).height,height,id);
 assert.equal(phone('global-nav').direction,'row');assert.equal(phone('global-nav').height,'auto');
 for(const node of layout.nodes){const props=effectiveProps(node,true);if(node.type!=='container'||props.hidden||props.height!=='auto'||props.direction!=='column')continue;for(const child of childrenOf(layout,node.id)){const childProps=effectiveProps(child,true);if(!childProps.hidden)assert.notEqual(childProps.height,'fill',node.id+' must not collapse a fill-height child '+child.id);}}
 for(const id of ['read-source','edit-source']){assert.equal(findNode(layout,id).props.text,'AI 共创');assert.equal(findNode(layout,id).name,'打开共创');}
});

test('phone wrapping is editable model state and never reorders shared navigation controls',()=>{
 const layout=createDefaultLayout(),order=childrenOf(layout,'global-nav').map(node=>node.id);
 assert.equal(findNode(layout,'global-nav').props.wrap,false);assert.equal(effectiveProps(findNode(layout,'global-nav'),true).wrap,true);assert.equal(findNode(layout,'nav-search').mobile.width,'fill');
 assert.equal(findNode(layout,'nav-actions').props.hidden,false);assert.equal(effectiveProps(findNode(layout,'nav-actions'),true).hidden,true);
 const noWrap=patchNode(layout,'global-nav',{wrap:false},{mobile:true}),restoredActions=patchNode(noWrap,'nav-actions',{hidden:false},{mobile:true});
 assert.equal(effectiveProps(findNode(restoredActions,'global-nav'),true).wrap,false);assert.equal(effectiveProps(findNode(restoredActions,'nav-actions'),true).hidden,false);assert.deepEqual(childrenOf(restoredActions,'global-nav').map(node=>node.id),order);
 const moved=moveNode(restoredActions,'nav-search','global-nav',0);assert.equal(childrenOf(moved,'global-nav')[0].id,'nav-search');assert.equal(effectiveProps(findNode(moved,'global-nav'),true).wrap,false);
 const imported=validateLayout(JSON.parse(JSON.stringify(moved)));assert.equal(effectiveProps(findNode(imported,'global-nav'),true).wrap,false);assert.equal(imported.nodes.length,59);
 for(const value of ['true',1,null,{}])assert.throws(()=>patchNode(layout,'global-nav',{wrap:value}),chinese);
});

test('overflow is an explicit safe property with independent phone overrides and import persistence',()=>{
 const layout=createDefaultLayout();assert.equal(findNode(layout,'workspace').props.overflow,'hidden');assert.equal(findNode(layout,'scene-host').props.overflow,'auto');assert.equal(findNode(layout,'brand').props.overflow,'visible');
 for(const value of ['auto','hidden','visible']){
  const next=patchNode(layout,'library-main',{overflow:value});assert.equal(findNode(validateLayout(JSON.parse(JSON.stringify(next))),'library-main').props.overflow,value);
 }
 const desktop=patchNode(layout,'library-main',{overflow:'hidden',margin:18}),phone=patchNode(desktop,'library-main',{overflow:'auto',margin:6},{mobile:true});
 assert.equal(effectiveProps(findNode(phone,'library-main'),false).overflow,'hidden');assert.equal(effectiveProps(findNode(phone,'library-main'),true).overflow,'auto');assert.equal(effectiveProps(findNode(phone,'library-main'),false).margin,18);assert.equal(effectiveProps(findNode(phone,'library-main'),true).margin,6);
 for(const value of ['scroll','clip','url(javascript:bad)',{},0])assert.throws(()=>patchNode(layout,'library-main',{overflow:value}),chinese);
});

test('default layouts, validated imports and mobile properties are detached objects',()=>{
 const first=createDefaultLayout(),second=createDefaultLayout();
 findNode(first,'topics-title').props.text='changed';assert.notEqual(findNode(second,'topics-title').props.text,'changed');
 const input=createDefaultLayout();input.extra={ignored:true};findNode(input,'library-main').unknown='stripped';findNode(input,'library-main').props.onClick='not executed';
 const valid=validateLayout(input);assert.equal(valid.extra,undefined);assert.equal(findNode(valid,'library-main').unknown,undefined);assert.equal(findNode(valid,'library-main').props.onClick,undefined);
 findNode(input,'library-main').props.gap=37;assert.equal(findNode(valid,'library-main').props.gap,18);
 findNode(input,'scene-library').mobile.padding=33;assert.equal(findNode(valid,'scene-library').mobile.padding,12);
 const effective=effectiveProps(findNode(valid,'scene-library'),true);effective.padding=77;assert.equal(findNode(valid,'scene-library').mobile.padding,12);
});

test('imports reject unsafe IDs, duplicates, missing reserved structure and oversized trees',()=>{
 for(const id of ['bad id','../node','<script>','constructor','prototype','__proto__','a'.repeat(65)]){
  assert.throws(()=>validateLayout(add(createDefaultLayout(),id,'library-main')),chinese);
 }
 assert.throws(()=>validateLayout(add(createDefaultLayout(),'new-note','library-main')),chinese);
 for(const id of ['workspace','global-nav','scene-host','nav-actions','scene-read','brand','nav-search']){
  const layout=createDefaultLayout();layout.nodes=layout.nodes.filter(node=>node.id!==id);assert.throws(()=>validateLayout(layout),chinese);
 }
 const oversized=createDefaultLayout();for(let i=0;i<192;i++)add(oversized,'extra-'+i,'library-main');assert.equal(oversized.nodes.length,251);assert.throws(()=>validateLayout(oversized),chinese);
 assert.throws(()=>validateLayout({version:2,nodes:[]}),chinese);assert.throws(()=>validateLayout({version:1,nodes:'wrong'}),chinese);
});

test('imports reject invalid parents, cross-scene nodes, cycles and misplaced fixed roots',()=>{
 for(const [id,parentId] of [['library-grid','missing'],['library-grid','new-note'],['library-grid','read-main'],['library-grid','workspace'],['library-grid','scene-host'],['global-nav','library-main'],['scene-read','scene-library'],['nav-actions','scene-host']]){
  assert.throws(()=>validateLayout(modify(createDefaultLayout(),id,{parentId})),chinese);
 }
 const cycle=createDefaultLayout();findNode(cycle,'library-main').parentId='library-toolbar';assert.throws(()=>validateLayout(cycle),chinese);
 const self=createDefaultLayout();findNode(self,'library-main').parentId='library-main';assert.throws(()=>validateLayout(self),chinese);
 const root=createDefaultLayout();findNode(root,'workspace').parentId='library-main';assert.throws(()=>validateLayout(root),chinese);
 const wrongType=createDefaultLayout();findNode(wrongType,'nav-library').type='text';assert.throws(()=>validateLayout(wrongType),chinese);
});

test('properties are sanitized to explicit enums and bounded finite numbers',()=>{
 const ranges={width:[-1,4001,Infinity,NaN,'100px'],height:[-1,4001,'100%'],gap:[-1,129,'12'],padding:[-1,161],margin:[-1,161],fontSize:[7,97]};
 for(const [key,values] of Object.entries(ranges))for(const value of values)assert.throws(()=>patchNode(createDefaultLayout(),'library-main',{[key]:value}),chinese);
 for(const patch of [{direction:'grid'},{align:'between'},{hidden:'true'},{text:42},{note:{}},{role:'chat'},{id:'changed'},{parentId:'read-main'},{scene:'read'}])assert.throws(()=>patchNode(createDefaultLayout(),'library-main',patch),chinese);
 assert.throws(()=>patchNode(createDefaultLayout(),'library-main',{name:'x'.repeat(81)}),chinese);
 assert.throws(()=>patchNode(createDefaultLayout(),'read-title',{text:'x'.repeat(10001)}),chinese);
 assert.throws(()=>patchNode(createDefaultLayout(),'read-title',{note:'x'.repeat(2001)}),chinese);
 for(const role of CONTENT_ROLES)assert.equal(findNode(patchNode(createDefaultLayout(),'read-document',{role}),'read-document').props.role,role);
 for(const value of ['auto','fill',0,4000,12.5])assert.equal(findNode(patchNode(createDefaultLayout(),'library-main',{width:value}),'library-main').props.width,value);
 assert.throws(()=>patchNode(createDefaultLayout(),'read-document',{role:'html-script'}),chinese);
});

test('workspace and full-scene roots cannot be hidden in desktop or mobile overrides',()=>{
 for(const id of ['workspace','scene-library','scene-read','scene-edit','scene-topics'])for(const mobile of [false,true])assert.throws(()=>patchNode(createDefaultLayout(),id,{hidden:true},{mobile}),chinese);
 const edited=patchNode(createDefaultLayout(),'read-outline',{hidden:false});assert.equal(findNode(edited,'read-outline').props.hidden,false);
});

test('moves return a new tree, preserve descendants and use an index after removing the source',()=>{
 const original=createDefaultLayout(),before=structuredClone(original);
 const reordered=moveNode(original,'search-notes','library-toolbar',0);assert.deepEqual(childrenOf(reordered,'library-toolbar').map(node=>node.id),['search-notes','new-note','library-view']);
 const last=moveNode(reordered,'search-notes','library-toolbar',2);assert.deepEqual(childrenOf(last,'library-toolbar').map(node=>node.id),['new-note','library-view','search-notes']);
 const nested=moveNode(original,'library-toolbar','library-sidebar',0);assert.equal(findNode(nested,'new-note').parentId,'library-toolbar');assert.equal(findNode(nested,'library-toolbar').parentId,'library-sidebar');
 const shared=moveNode(original,'nav-search','nav-actions',1);assert.equal(findNode(shared,'nav-search').parentId,'nav-actions');assert.equal(findNode(shared,'nav-search').scene,'shared');
 assert.deepEqual(original,before);
});

test('moves reject fixed roots, cross-scene drops, non-containers, root drops, self and descendants',()=>{
 for(const id of ['workspace','global-nav','scene-host','nav-actions','scene-read'])assert.throws(()=>moveNode(createDefaultLayout(),id,'library-main',0),chinese);
 for(const parent of ['missing','new-note','workspace','scene-host','read-main','global-nav','library-toolbar','library-view']){
  assert.throws(()=>moveNode(createDefaultLayout(),'library-toolbar',parent,0),chinese);
 }
 for(const index of [-1,99,0.5,NaN])assert.throws(()=>moveNode(createDefaultLayout(),'search-notes','library-toolbar',index),chinese);
 assert.throws(()=>moveNode(createDefaultLayout(),'missing','library-main',0),chinese);
});

test('desktop and mobile patches are independent and preserve exact layout notes',()=>{
 const original=createDefaultLayout(),note='  布局说明🙂\r\n不要改写\t';
 const desktop=patchNode(original,'library-main',{name:'主区新名称',props:{gap:25,note}});
 const mobile=patchNode(desktop,'library-main',{gap:7,width:'fill',note:'手机备注'},{mobile:true});
 assert.equal(findNode(mobile,'library-main').name,'主区新名称');assert.equal(effectiveProps(findNode(mobile,'library-main'),false).gap,25);assert.equal(effectiveProps(findNode(mobile,'library-main'),false).note,note);
 assert.equal(effectiveProps(findNode(mobile,'library-main'),true).gap,7);assert.equal(effectiveProps(findNode(mobile,'library-main'),true).note,'手机备注');
 const cleared=patchNode(mobile,'library-main',{gap:undefined,note:undefined},{mobile:true});assert.equal(effectiveProps(findNode(cleared,'library-main'),true).gap,25);assert.equal(effectiveProps(findNode(cleared,'library-main'),true).note,note);
 assert.equal(findNode(original,'library-main').name,'笔记库主区');assert.equal(findNode(original,'library-main').props.gap,18);
 assert.throws(()=>patchNode(original,'library-main',{name:'手机改名'},{mobile:true}),chinese);
});

test('resetScene restores only the selected scene, including mobile values and custom nodes',()=>{
 let changed=patchNode(createDefaultLayout(),'library-main',{padding:40,note:'library note'});
 changed=patchNode(changed,'read-title',{text:'A retained read title'});changed=patchNode(changed,'brand',{text:'Retained brand'});changed=patchNode(changed,'scene-library',{padding:27},{mobile:true});add(changed,'custom-library','library-main');
 const reset=resetScene(changed,'library');assert.equal(findNode(reset,'custom-library'),null);assert.equal(findNode(reset,'library-main').props.padding,0);assert.equal(findNode(reset,'scene-library').mobile.padding,12);
 assert.equal(findNode(reset,'read-title').props.text,'A retained read title');assert.equal(findNode(reset,'brand').props.text,'Retained brand');
 const shared=resetScene(reset,'shared');assert.equal(findNode(shared,'brand').props.text,'DSH NOTEBOOK');assert.equal(findNode(shared,'read-title').props.text,'A retained read title');
 assert.throws(()=>resetScene(changed,'invalid'),chinese);
});

test('history snapshots are detached, undo and redo are ordered, and editing a branch clears redo',()=>{
 const initial=createDefaultLayout(),history=new LayoutHistory(initial);assert.equal(history.canUndo,false);assert.equal(history.canRedo,false);
 const first=patchNode(history.current,'read-title',{text:'First'}),second=patchNode(first,'read-title',{text:'Second'});history.commit(first);history.commit(second);
 first.nodes.length=0;const exposed=history.current;findNode(exposed,'read-title').props.text='mutated exposed value';assert.equal(findNode(history.current,'read-title').props.text,'Second');
 assert.equal(findNode(history.undo(),'read-title').props.text,'First');assert.equal(history.canRedo,true);assert.equal(findNode(history.redo(),'read-title').props.text,'Second');
 history.undo();history.commit(patchNode(history.current,'read-title',{text:'New branch'}));assert.equal(history.canRedo,false);assert.equal(findNode(history.redo(),'read-title').props.text,'New branch');
 history.reset(initial);assert.equal(history.canUndo,false);assert.equal(history.canRedo,false);assert.equal(findNode(history.current,'read-title').props.text,findNode(initial,'read-title').props.text);
});

test('history keeps at most 100 snapshots and rejects invalid commits atomically',()=>{
 const history=new LayoutHistory(createDefaultLayout());for(let i=0;i<130;i++)history.commit(patchNode(history.current,'read-title',{text:'Version '+i}));
 let undos=0;while(history.canUndo){history.undo();undos++;}assert.equal(undos,99);assert.equal(findNode(history.current,'read-title').props.text,'Version 30');
 const before=history.current;assert.throws(()=>history.commit({version:1,nodes:[]}),chinese);assert.deepEqual(history.current,before);
 history.redo();const canRedo=history.canRedo;history.commit(history.current);assert.equal(history.canRedo,canRedo,'a no-op must not destroy redo');
});
