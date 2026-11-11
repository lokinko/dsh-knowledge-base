import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {migrateLayout, SAMPLE_EDITOR_TEXT} from '../../prototypes/workbench/atomic-layout.js';

const backup=JSON.parse(await fs.readFile(new URL('../../prototypes/workbench/user-design/layout-20261111.json',import.meta.url),'utf8'));
const seed=()=>structuredClone(backup.layout);
const find=(layout,id)=>layout.nodes.find(node=>node.id===id);
const children=(layout,id)=>layout.nodes.filter(node=>node.parentId===id);
function descendants(layout,id) {
  const result=[];
  for(const child of children(layout,id)) result.push(child,...descendants(layout,child.id));
  return result;
}
function freeze(value) { for(const item of Object.values(value)) if(item&&typeof item==='object') freeze(item); return Object.freeze(value); }
function assertAtomic(layout) {
  const types=new Set(['container','text','button','input','textarea','icon','image','separator']);
  const ids=new Set(layout.nodes.map(node=>node.id));
  assert.equal(ids.size,layout.nodes.length);
  assert.ok(layout.nodes.length<=2000);
  for(const node of layout.nodes) {
    assert.ok(types.has(node.type),node.id);
    assert.ok(node.id.length<=64,node.id);
    assert.ok(node.parentId===null||ids.has(node.parentId),node.id);
    assert.equal(node.props.hidden,false,node.id+' must not silently survive desktop cleanup');
    if(node.props.action) assert.match(node.props.action,/^[a-z][a-z0-9-]*$/);
    if(node.type==='button') {
      assert.equal(Object.hasOwn(node.props,'text'),false,node.id);
      const leaves=children(layout,node.id);
      assert.equal(leaves.length,2,node.id+' has separately editable icon and label');
      assert.deepEqual(leaves.map(child=>child.type),['icon','text']);
      assert.ok(leaves.every(child=>children(layout,child.id).length===0));
    } else if(node.type!=='container') assert.equal(children(layout,node.id).length,0,node.id);
    for(const forbidden of ['src','html','innerHTML','onclick','onClick']) assert.equal(Object.hasOwn(node.props,forbidden),false);
  }
}

test('the actual 59-node design migrates deterministically to a pure, fully atomic scene tree',()=>{
  const input=freeze(seed()),before=JSON.stringify(input);
  assert.equal(input.nodes.length,59);
  const result=migrateLayout(input);
  assert.equal(result.layout.version,2);
  assert.equal(result.layout.nodes.length,302);
  assert.equal(result.report.removed.length,20);
  assert.equal(result.report.preservedIds.length,39);
  assert.deepEqual(migrateLayout(input),result);
  assert.equal(JSON.stringify(input),before);
  assertAtomic(result.layout);
  assert.deepEqual(result.layout.nodes.filter(node=>['workspace','scene-host','scene-library','scene-read','scene-edit','scene-topics'].includes(node.id)).map(node=>node.id),
    ['workspace','scene-host','scene-library','scene-read','scene-edit','scene-topics']);
});

test('visible user IDs, names, parents, props, mobile overrides and original sibling order survive',()=>{
  const input=seed(),{layout,report}=migrateLayout(input);
  const removed=new Set(report.removed.map(row=>row.id));
  const preserved=input.nodes.filter(node=>!removed.has(node.id));
  assert.deepEqual(report.preservedIds,preserved.map(node=>node.id));
  assert.deepEqual(layout.nodes.filter(node=>report.preservedIds.includes(node.id)).map(node=>node.id),report.preservedIds);
  for(const original of preserved) {
    const next=find(layout,original.id);
    for(const key of ['name','parentId','scene']) assert.deepEqual(next[key],original[key],original.id+' '+key);
    const conversions=report.explicitConvertedStyles.filter(row=>row.id===original.id);
    const converted=conversions.reduce((result,row)=>({props:{...result.props,...row.props},mobile:{...result.mobile,...row.mobile}}),{props:{},mobile:{}});
    const expected={...structuredClone(original.props),...converted.props};
    if(original.type==='button') { delete expected.text; delete expected.action; }
    const actual={...next.props};
    if(original.type==='button') delete actual.action;
    assert.deepEqual(actual,expected,original.id+' props');
    const expectedMobile=Object.keys(converted.mobile).length?{...(original.mobile||{}),...converted.mobile}:original.mobile;
    assert.deepEqual(next.mobile,expectedMobile,original.id+' mobile');
    assert.equal(next.type,original.type==='content'?'container':original.type);
  }
  assert.equal(find(layout,'library-sidebar').props.width,160);
  assert.equal(find(layout,'topics-question-list').props.overflow,'hidden');
  assert.deepEqual(find(layout,'topics-body').mobile,{direction:'column',height:'auto'});
});

test('desktop hidden nodes and visible descendants disappear without resurrecting deleted coauthor panels',()=>{
  const input=seed(),{layout,report}=migrateLayout(input);
  assert.equal(find(input,'nav-actions').props.hidden,false);
  assert.equal(find(layout,'nav-actions'),undefined,'The visible child of a hidden nav is removed');
  assert.equal(report.removed.find(row=>row.id==='nav-actions').reason,'hidden-ancestor');
  for(const id of ['global-nav','category-search','search-notes','library-view','read-sidebar','read-note-list','read-coauthor','edit-coauthor','edit-preview','topics-heading']) {
    assert.equal(find(layout,id),undefined,id);
    assert.equal(layout.nodes.some(node=>node.id.startsWith(id+'--')),false,id+' children');
  }
  assert.ok(find(layout,'topics-chat'),'The user-kept chat is preserved');
  assert.equal(report.expanded.some(row=>row.id==='read-coauthor'),false);
});

test('phone-only hidden controls survive globally and mobile button labels move to their own leaf',()=>{
  const input=seed();
  find(input,'folder-tree').mobile={...find(input,'folder-tree').mobile,hidden:true};
  find(input,'new-note').mobile={hidden:true,text:'手机新建',fontSize:19};
  const {layout,report}=migrateLayout(input);
  assert.equal(find(layout,'folder-tree').mobile.hidden,true);
  assert.equal(children(layout,'folder-tree').length,5);
  assert.equal(report.removed.some(row=>['folder-tree','new-note'].includes(row.id)),false);
  const button=find(layout,'new-note'),label=children(layout,button.id).find(node=>node.type==='text');
  assert.deepEqual(button.mobile,{hidden:true,fontSize:19});
  assert.equal(label.props.text,'新建笔记');
  assert.deepEqual(label.mobile,{text:'手机新建'});
});

test('empty legacy nav containers are cleaned only after their hidden children have been removed',()=>{
  const input=seed();
  find(input,'global-nav').props.hidden=false;
  const {layout,report}=migrateLayout(input);
  assert.equal(find(layout,'global-nav'),undefined);
  assert.equal(find(layout,'nav-actions'),undefined);
  assert.equal(report.removed.find(row=>row.id==='global-nav').reason,'empty-legacy-container');
  assert.equal(report.removed.find(row=>row.id==='nav-actions').reason,'empty-legacy-container');
  assert.ok(find(layout,'read-actions'),'Ordinary containers are preserved even when empty');
});

test('every former content role expands to concrete leaves rather than a magic rendering block',()=>{
  const {layout,report}=migrateLayout(seed());
  for(const expanded of report.expanded) {
    assert.ok(expanded.addedIds.length);
    assert.ok(expanded.addedIds.every(id=>find(layout,id)));
  }
  assert.equal(children(layout,'folder-tree').length,5);
  for(const row of children(layout,'folder-tree')) assert.deepEqual(children(layout,row.id).map(node=>node.type),['icon','text','text']);
  const cards=children(layout,'library-grid');
  assert.equal(cards.length,4);
  for(const card of cards) {
    const all=descendants(layout,card.id);
    for(const label of ['材料分类','材料标题','材料摘要','标签 1','标签 2','更新时间','字数','打开材料图标','打开材料文字']) assert.ok(all.some(node=>node.name===label),label);
  }
  const document=descendants(layout,'read-document');
  assert.equal(document.filter(node=>node.props.role==='document-heading').length,2);
  assert.equal(document.filter(node=>node.props.role==='document-paragraph').length,4);
  assert.equal(document.filter(node=>node.props.role==='document-quote').length,1);
  assert.equal(document.find(node=>node.type==='image').props.srcRole,'window');
  assert.ok(document.some(node=>node.props.role==='image-caption'));
  const editor=descendants(layout,'edit-editor').find(node=>node.type==='textarea');
  assert.equal(editor.props.value,SAMPLE_EDITOR_TEXT);
  assert.equal(editor.props.text,'在这里编辑样例正文…');
  assert.equal(editor.props.fontSize,'inherit');
  assert.ok(document.filter(node=>node.props.role==='document-paragraph').every(node=>node.props.fontSize==='inherit'));
  assert.equal(children(layout,'topics-question-list').length,3);
  const sources=descendants(layout,'topics-sources');
  for(const name of ['来源列表标题','来源总数','来源类型','来源标题','来源摘要','来源时间','打开来源图标','打开来源文字','移除来源图标','移除来源文字','查找并选择来源文字']) assert.ok(sources.some(node=>node.name===name),name);
  const reader=descendants(layout,'topics-reader');
  for(const role of ['reader-kind','reader-title','reader-author','reader-time','reader-quote','reader-location']) assert.ok(reader.some(node=>node.props.role===role),role);
  const chat=descendants(layout,'topics-chat');
  for(const name of ['会话标题','会话状态','会话标题图标','消息历史分组','消息头像','消息作者','消息时间','复制消息图标','复制消息文字','引用消息图标','引用消息文字','模拟会话输入','会话附件图标','会话附件文字','发送消息图标','发送消息文字']) assert.ok(chat.some(node=>node.name===name),name);
  assert.equal(chat.filter(node=>['user-message','assistant-message'].includes(node.props.role)).length,2);
  assert.equal(chat.filter(node=>node.props.role==='message-body').length,3,'Assistant paragraphs remain separately editable');
  assert.ok(chat.some(node=>node.type==='separator'));
});

test('legacy two-column card presentation becomes explicit grid with one mobile column without changing user sizes',()=>{
  const {layout,report}=migrateLayout(seed());
  assert.deepEqual(report.explicitConvertedStyles.find(row=>row.id==='library-grid'),{id:'library-grid',reason:'v1-mock-cards-grid',props:{display:'grid',columns:2,overflow:'auto'},mobile:{columns:1}});
  const grid=find(layout,'library-grid');
  assert.equal(grid.props.display,'grid');
  assert.equal(grid.props.columns,2);
  assert.equal(grid.mobile.columns,1);
  assert.equal(grid.props.direction,'column','The original direction remains available as a stored user property');
  assert.equal(grid.props.width,'fill');
  assert.equal(find(layout,'folder-tree').props.width,160);
  assert.equal(find(layout,'topics-question-list').props.overflow,'hidden');
  assert.ok(children(layout,grid.id).every(card=>card.props.width==='fill'));
  assert.ok(children(layout,'folder-tree').every(row=>row.props.direction==='row'));
  const inputRow=descendants(layout,'topics-chat').find(node=>node.name==='会话输入与操作横排');
  assert.equal(inputRow.props.direction,'row');
  assert.equal(inputRow.mobile.direction,'column');
  assert.ok(children(layout,inputRow.id).some(node=>node.type==='textarea'));
  assert.ok(children(layout,inputRow.id).some(node=>node.name==='附件与发送操作'));
});

test('neutral surfaces and message bubbles are explicit editable props without adding or moving controls',async()=>{
  const {layout,report}=migrateLayout(seed());
  assert.equal(layout.nodes.length,302);
  const surface=(node,radius)=>{
    assert.equal(node.props.background,'#fcfbf9',node.id);
    assert.equal(node.props.color,'#333632',node.id);
    assert.equal(node.props.borderColor,'#e4e1da',node.id);
    assert.equal(node.props.borderWidth,1,node.id);
    assert.equal(node.props.borderRadius,radius,node.id);
  };
  children(layout,'library-grid').forEach(node=>surface(node,8));
  children(layout,'topics-question-list').forEach(node=>surface(node,6));
  descendants(layout,'topics-sources').filter(node=>/^select-source-/.test(node.props.action||'')).forEach(node=>surface(node,6));
  surface(find(layout,'topics-reader'),8);
  layout.nodes.filter(node=>node.type==='button').forEach(node=>surface(node,6));
  const chat=descendants(layout,'topics-chat');
  assert.equal(chat.find(node=>node.props.role==='user-message').props.background,'#e6eadf');
  surface(chat.find(node=>node.props.role==='assistant-message'),8);
  surface(chat.find(node=>node.props.role==='chat-compose'),8);
  assert.equal(chat.find(node=>node.props.role==='chat-history').props.overflow,'auto');
  assert.equal(find(layout,'topics-question-list').props.overflow,'hidden');
  assert.equal(find(layout,'read-document').props.overflow,'auto');
  assert.equal(find(layout,'library-grid').props.overflow,'auto');
  assert.ok(report.explicitConvertedStyles.some(row=>row.id==='topics-reader'&&row.reason==='v1-neutral-surface'));
  const {validateLayout}=await import('../../prototypes/workbench/atomic-model.js');
  const checked=validateLayout(layout);
  assert.equal(find(checked,'topics-reader').props.background,'#fcfbf9');
  assert.equal(find(checked,'read-edit').props.borderWidth,1);
});

test('old default native buttons become a single icon-label row while custom layouts remain untouched',()=>{
  const input=seed();
  Object.assign(find(input,'read-edit').props,{direction:'column',gap:9,padding:20,align:'end'});
  find(input,'edit-save').props.align='end';
  const {layout,report}=migrateLayout(input);
  const button=find(layout,'new-note');
  assert.equal(button.props.direction,'row');
  assert.equal(button.props.align,'center');
  assert.equal(button.props.gap,6);
  assert.equal(button.props.padding,6);
  assert.deepEqual(report.explicitConvertedStyles.find(row=>row.id==='new-note'&&row.reason==='v1-native-button-content-layout').props,
    {direction:'row',gap:6,padding:6,align:'center'});
  const custom=find(layout,'read-edit');
  for(const key of ['direction','gap','padding','align']) assert.equal(custom.props[key],find(input,'read-edit').props[key]);
  assert.equal(report.explicitConvertedStyles.some(row=>row.id==='read-edit'&&row.reason==='v1-native-button-content-layout'),false);
  assert.equal(find(layout,'edit-save').props.direction,'row');
  assert.equal(find(layout,'edit-save').props.align,'end','An explicit non-default alignment is preserved');
  assert.equal(layout.nodes.length,302);
});

test('surface defaults preserve explicit transparent colors, zero borders and mobile styles; overflow changes are narrowly reported',()=>{
  const input=seed();
  Object.assign(find(input,'read-edit').props,{background:'transparent',color:'transparent',borderColor:'#123456',borderWidth:0,borderRadius:0});
  Object.assign(find(input,'topics-reader').props,{background:'#010203',borderWidth:0});
  find(input,'topics-reader').mobile={...find(input,'topics-reader').mobile,background:'#040506',borderWidth:0};
  find(input,'library-grid').props.overflow='hidden';
  find(input,'read-document').props.overflow='visible';
  const {layout,report}=migrateLayout(input);
  for(const key of ['background','color','borderColor','borderWidth','borderRadius']) assert.deepEqual(find(layout,'read-edit').props[key],find(input,'read-edit').props[key]);
  assert.equal(find(layout,'topics-reader').props.background,'#010203');
  assert.equal(find(layout,'topics-reader').props.borderWidth,0);
  assert.equal(find(layout,'topics-reader').props.borderColor,'#e4e1da');
  assert.equal(find(layout,'topics-reader').mobile.background,'#040506');
  assert.equal(find(layout,'topics-reader').mobile.borderWidth,0);
  assert.equal(report.explicitConvertedStyles.some(row=>row.id==='read-edit'&&row.reason==='v1-neutral-surface'),false,'An already-styled button gets no default surface rewrite');
  assert.equal(Object.hasOwn(report.explicitConvertedStyles.find(row=>row.id==='topics-reader').props,'background'),false);
  assert.equal(find(layout,'library-grid').props.overflow,'hidden');
  assert.equal(Object.hasOwn(report.explicitConvertedStyles.find(row=>row.id==='library-grid').props,'overflow'),false);
  assert.equal(find(layout,'read-document').props.overflow,'visible','A customized document overflow remains a user choice');
  assert.equal(find(layout,'topics-question-list').props.overflow,'hidden');
});

test('visible legacy note-list and outline variants also expand into ordinary containers and independent controls',()=>{
  const input=seed();
  for(const id of ['read-sidebar','read-note-list','read-outline']) find(input,id).props.hidden=false;
  const {layout}=migrateLayout(input);
  assert.equal(find(layout,'read-note-list').type,'container');
  assert.equal(children(layout,'read-note-list').length,4);
  assert.equal(find(layout,'read-outline').type,'container');
  assert.equal(find(layout,'read-outline').mobile.hidden,true,'Phone-only hiding remains an override');
  const buttons=children(layout,'read-outline').filter(node=>node.type==='button');
  assert.equal(buttons.length,2);
  assert.deepEqual(buttons.map(node=>node.props.action),['outline-section-0','outline-section-1']);
  assertAtomic(layout);
});

test('generated IDs avoid user collisions, literal text stays data, and actions are safe tokens',()=>{
  const input=seed();
  input.nodes.push({id:'folder-tree--folder-0',type:'text',name:'用户自己的控件',parentId:'library-sidebar',scene:'library',props:{text:'原 ID 不可覆盖'}});
  find(input,'read-title').props.text='<script>globalThis.__atomicMigrationExecuted=true</script>';
  const {layout}=migrateLayout(input);
  assert.equal(find(layout,'folder-tree--folder-0').name,'用户自己的控件');
  assert.equal(children(layout,'folder-tree')[0].id,'folder-tree--folder-0-1');
  assert.equal(find(layout,'read-title').props.text,find(input,'read-title').props.text);
  assert.equal(globalThis.__atomicMigrationExecuted,undefined);
  assertAtomic(layout);
});

test('invalid v1 trees and migrations exceeding the v2 node budget fail without changing the input',()=>{
  const bad=seed(); bad.nodes.push(structuredClone(bad.nodes[0]));
  assert.throws(()=>migrateLayout(bad),/ID/);
  assert.throws(()=>migrateLayout({version:2,nodes:[]}),/version:1/);
  const input=seed();
  for(let i=0;i<44;i++) input.nodes.push({id:'extra-chat-'+i,type:'content',name:'新增演示会话',parentId:'topics-main',scene:'topics',props:{role:'chat'}});
  const before=JSON.stringify(input);
  assert.throws(()=>migrateLayout(input),/2000/);
  assert.equal(JSON.stringify(input),before);
});

test('migration output is accepted by the independent v2 model and all role expansions remain editable',async()=>{
  const {validateLayout,patchNode,removeNode,duplicateNode}=await import('../../prototypes/workbench/atomic-model.js');
  const {layout}=migrateLayout(seed());
  const checked=validateLayout(layout);
  assert.equal(checked.nodes.length,layout.nodes.length);
  assert.equal(find(checked,'library-grid').props.display,'grid');
  assert.equal(find(checked,'library-grid').props.columns,2);
  assert.equal(find(checked,'library-grid').mobile.columns,1);
  assert.equal(descendants(checked,'edit-editor').find(node=>node.type==='textarea').props.value,SAMPLE_EDITOR_TEXT);
  const label=children(layout,'edit-save').find(node=>node.type==='text');
  const patched=patchNode(checked,label.id,{text:'由用户决定保存'});
  assert.equal(find(patched,label.id).props.text,'由用户决定保存');
  const removed=removeNode(patched,label.id);
  assert.equal(find(removed,label.id),undefined);
  assert.ok(find(removed,'edit-save'),'Deleting a label does not implicitly replace its button');
  const duplicated=duplicateNode(checked,'topics-reader');
  assert.ok(duplicated.nodes.length>checked.nodes.length);
  assert.equal(checked.nodes.length,layout.nodes.length,'Model operations keep prior snapshots intact');
});
