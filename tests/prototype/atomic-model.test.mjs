import test from 'node:test';
import assert from 'node:assert/strict';
import {SCENES,NODE_TYPES,IMAGE_ROLES,FIXED_IDS,validateLayout,moveNode,patchNode,effectiveProps,findNode,childrenOf,removeNode,duplicateNode,addNode,LayoutHistory} from '../../prototypes/workbench/atomic-model.js';

const node=(id,type,parentId,scene='library',props={},mobile)=>({id,type,name:id,parentId,scene,props,...(mobile?{mobile}:{})});
function fixture(){return validateLayout({version:2,nodes:[
 node('workspace','container',null,'shared',{height:'fill',overflow:'hidden'}),node('scene-host','container','workspace','shared',{height:'fill',overflow:'auto'}),
 ...['library','read','edit','topics'].map(scene=>node('scene-'+scene,'container','scene-host',scene)),
 node('card','container','scene-library','library',{fontSize:22,fontWeight:600,background:'#f0f0f0',borderColor:'#AAAAAA',borderWidth:1,borderRadius:12,padding:16,note:'  原备注🙂\r\n保留\t'},{padding:8}),
 node('title','text','card','library',{text:'  标题🙂\r\n原字串  '}),node('open','button','card','library',{action:'note:open-1',direction:'row',gap:6}),node('label','text','open','library',{text:'打开'}),node('glyph','icon','open','library',{text:'↗',fontSize:18}),
 node('search','input','card','library',{text:'关键词'}),node('body','textarea','card','library',{text:'正文\r\n🙂',height:240}),node('photo','image','card','library',{srcRole:'window',imageFit:'cover'}),node('divider','separator','card','library',{height:1}),
 node('read-main','container','scene-read','read'),node('read-text','text','read-main','read',{text:'阅读内容'}),node('shared-tools','container','workspace','shared'),node('shared-title','text','shared-tools','shared',{text:'共用'})
 ]});}
const chinese=error=>error instanceof Error&&/[\u4e00-\u9fff]/.test(error.message);
const append=(layout,value)=>{layout.nodes.push(value);return layout;};

test('v2 requires only six fixed roots and supports all eight atomic node types without legacy navigation',()=>{
 const layout=fixture();assert.equal(layout.version,2);assert.equal(findNode(layout,'global-nav'),null);assert.equal(findNode(layout,'nav-actions'),null);
 assert.equal(FIXED_IDS.length,6);assert.equal(SCENES.length,5);assert.equal(NODE_TYPES.length,8);assert.deepEqual(IMAGE_ROLES,['window','landscape','portrait','placeholder']);
 for(const type of NODE_TYPES)assert(layout.nodes.some(value=>value.type===type),type);
 assert.throws(()=>validateLayout({version:1,nodes:layout.nodes}),chinese);
 for(const id of FIXED_IDS){const next=fixture();next.nodes=next.nodes.filter(value=>value.id!==id);assert.throws(()=>validateLayout(next),chinese);}
 const legacy=fixture();findNode(legacy,'card').type='content';assert.throws(()=>validateLayout(legacy),chinese);
});

test('validation detaches input, removes unknown properties and preserves sparse migrated styles and exact text',()=>{
 const input=fixture();input.untrusted='ignored';findNode(input,'title').props.cssText='position:fixed';findNode(input,'title').props.onclick='alert(1)';
 const valid=validateLayout(input);assert.equal(valid.untrusted,undefined);assert.equal(findNode(valid,'title').props.cssText,undefined);assert.equal(findNode(valid,'title').props.onclick,undefined);
 assert.equal(findNode(valid,'card').props.fontSize,22);assert.equal(findNode(valid,'title').props.fontSize,'inherit');
 for(const key of ['color','background','borderWidth','borderColor','fontWeight','lineHeight'])assert.equal(findNode(valid,'title').props[key],undefined,key+' must stay inherited or sparse');
 findNode(input,'title').props.text='changed';findNode(input,'card').mobile.padding=47;
 assert.equal(findNode(valid,'title').props.text,'  标题🙂\r\n原字串  ');assert.equal(findNode(valid,'card').mobile.padding,8);assert.equal(findNode(valid,'card').props.note,'  原备注🙂\r\n保留\t');
});

test('buttons accept independently movable text and icons and prohibit nested controls or descendants on leaves',()=>{
 const original=fixture(),moved=moveNode(original,'title','open',1);assert.deepEqual(childrenOf(moved,'open').map(value=>value.id),['label','title','glyph']);
 for(const type of ['container','button','input','textarea','image','separator'])assert.throws(()=>validateLayout(append(fixture(),node('bad-child',type,'open'))),chinese);
 for(const parentId of ['title','glyph','search','body','photo','divider'])assert.throws(()=>validateLayout(append(fixture(),node('child','text',parentId))),chinese);
 for(const id of ['card','open'])assert.throws(()=>patchNode(original,id,{text:'must be its own node'}),chinese);
 const value=patchNode(original,'body',{text:'  Exact\r\n正文🙂\t'});assert.equal(findNode(value,'body').props.text,'  Exact\r\n正文🙂\t');
});

test('moves preserve scene and subtree structure, permit shared root placement, and reject cycles or fixed movement',()=>{
 const original=fixture(),before=structuredClone(original),moved=moveNode(original,'open','scene-library',0);
 assert.equal(findNode(moved,'open').parentId,'scene-library');assert.equal(findNode(moved,'label').parentId,'open');assert.deepEqual(original,before);
 const shared=moveNode(original,'shared-title','workspace',0);assert.equal(childrenOf(shared,'workspace')[0].id,'shared-title');
 for(const id of FIXED_IDS)assert.throws(()=>moveNode(original,id,'card',0),chinese);
 assert.throws(()=>moveNode(original,'card','open',0),chinese);assert.throws(()=>moveNode(original,'card','card',0),chinese);assert.throws(()=>moveNode(original,'open','read-main',0),chinese);assert.throws(()=>moveNode(original,'open','workspace',0),chinese);
 for(const index of [-1,100,NaN,0.5])assert.throws(()=>moveNode(original,'title','card',index),chinese);
 const reordered=moveNode(original,'glyph','open',0);assert.deepEqual(childrenOf(reordered,'open').map(value=>value.id),['glyph','label']);
});

test('remove deletes whole hidden subtrees, while phone-only hidden nodes remain until explicitly deleted',()=>{
 let original=fixture();original=append(original,node('old-nav','container','workspace','shared',{hidden:true}));original=append(original,node('old-actions','container','old-nav','shared'));original=append(original,node('old-button','button','old-actions','shared'));original=append(original,node('old-label','text','old-button','shared',{text:'旧设置'}));original=validateLayout(original);
 const clean=removeNode(original,'old-nav');for(const id of ['old-nav','old-actions','old-button','old-label'])assert.equal(findNode(clean,id),null);
 assert(findNode(original,'old-label'));assert.equal(clean.nodes.length,original.nodes.length-4);
 const phone=patchNode(clean,'title',{hidden:true},{mobile:true}),valid=validateLayout(phone);assert(findNode(valid,'title'));assert.equal(findNode(valid,'title').props.hidden,false);assert.equal(effectiveProps(findNode(valid,'title'),true).hidden,true);
 for(const id of FIXED_IDS)assert.throws(()=>removeNode(original,id),chinese);assert.throws(()=>removeNode(original,'missing'),chinese);
});

test('duplicate copies complete independent subtrees with collision-free bounded IDs and preserved mobile properties',()=>{
 const original=fixture(),next=duplicateNode(original,'card'),added=next.nodes.filter(value=>!findNode(original,value.id)),root=added.find(value=>value.parentId==='scene-library');
 assert(root);assert.equal(added.length,original.nodes.filter(value=>value.id==='card'||value.parentId==='card'||value.parentId==='open').length);
 assert.equal(root.props.note,findNode(original,'card').props.note);assert.equal(root.mobile.padding,8);
 const copiedButton=added.find(value=>value.type==='button');assert.equal(childrenOf(next,copiedButton.id).length,2);assert(childrenOf(next,copiedButton.id).every(value=>value.type==='text'||value.type==='icon'));
 const third=duplicateNode(next,'card');assert.equal(new Set(third.nodes.map(value=>value.id)).size,third.nodes.length);
 root.props.note='changed copy';assert.notEqual(findNode(original,'card').props.note,'changed copy');
 const long=append(fixture(),node('x'.repeat(96),'text','card','library',{text:'long id'}));findNode(long,'x'.repeat(96)).name='长 ID';
 const duplicate=duplicateNode(long,'x'.repeat(96));assert(duplicate.nodes.every(value=>value.id.length<=96));
 for(const id of FIXED_IDS)assert.throws(()=>duplicateNode(original,id),chinese);
});

test('add creates every atom, automatically supplies button label children, and rejects illegal button children',()=>{
 const original=fixture();
 for(const type of NODE_TYPES){const next=addNode(original,'card',type),added=next.nodes.filter(value=>!findNode(original,value.id)),root=added.find(value=>value.parentId==='card');assert.equal(root.type,type);assert.equal(root.scene,'library');assert.equal(root.props.fontSize,'inherit');if(type==='button'){assert.equal(added.length,2);assert.equal(childrenOf(next,root.id)[0].type,'text');assert.equal(root.props.text,undefined);}else assert.equal(added.length,1);}
 assert.equal(addNode(original,'open','text').nodes.length,original.nodes.length+1);assert.equal(addNode(original,'open','icon').nodes.length,original.nodes.length+1);
 assert.throws(()=>addNode(original,'open','button'),chinese);assert.throws(()=>addNode(original,'title','text'),chinese);assert.throws(()=>addNode(original,'card','content'),chinese);assert.throws(()=>addNode(original,'missing','text'),chinese);
});

test('safe style values include inheritance and independent edge spacing without altering stored totals',()=>{
 const original=fixture();
 const next=patchNode(original,'card',{fontSize:'inherit',fontWeight:'inherit',lineHeight:1.8,textAlign:'right',fontStyle:'italic',color:'#123abc',background:'transparent',borderColor:'#ABCDEF',borderWidth:12,borderRadius:64,padding:20,paddingLeft:7,margin:12,marginBottom:3});
 const mobile=patchNode(next,'card',{padding:10,paddingRight:4,fontSize:18,background:'#ffffff'},{mobile:true});
 const desktopProps=effectiveProps(findNode(mobile,'card'),false),phoneProps=effectiveProps(findNode(mobile,'card'),true);
 assert.equal(desktopProps.paddingTop,20);assert.equal(desktopProps.paddingLeft,7);assert.equal(desktopProps.marginTop,12);assert.equal(desktopProps.marginBottom,3);
 assert.equal(phoneProps.paddingTop,10);assert.equal(phoneProps.paddingLeft,7);assert.equal(phoneProps.paddingRight,4);assert.equal(desktopProps.fontSize,'inherit');assert.equal(phoneProps.fontSize,18);
 assert.equal(findNode(mobile,'card').props.paddingTop,undefined,'fallback sides are derived, not persisted');assert.equal(findNode(mobile,'card').props.background,'transparent');
 const cleared=patchNode(mobile,'card',{paddingRight:undefined},{mobile:true});assert.equal(effectiveProps(findNode(cleared,'card'),true).paddingRight,10);
 for(const [key,values] of Object.entries({fontSize:[7,97,'14px'],fontWeight:[300,800,'600'],lineHeight:[0.9,3.1],fontStyle:['oblique'],textAlign:['justify'],color:['red','#fff','var(--x)','url(bad)'],background:['https://bad'],borderWidth:[-1,13],borderRadius:[-1,65],paddingTop:[-1,161],marginLeft:[-1,161]}))for(const value of values)assert.throws(()=>patchNode(original,'card',{[key]:value}),chinese);
});

test('input values stay separate from placeholder text and preserve up to 20000 UTF-16 units',()=>{
 const original=fixture(),value='  原始🙂\r\n正文\t\\literal  ',updated=patchNode(original,'body',{text:'占位提示',value});
 assert.equal(findNode(updated,'body').props.text,'占位提示');assert.equal(findNode(updated,'body').props.value,value);assert.equal(findNode(original,'body').props.value,undefined);
 const imported=validateLayout(JSON.parse(JSON.stringify(updated)));assert.equal(findNode(imported,'body').props.value,value);
 const mobile=patchNode(updated,'body',{value:'手机独立值\r\n🙂'},{mobile:true});assert.equal(effectiveProps(findNode(mobile,'body'),false).value,value);assert.equal(effectiveProps(findNode(mobile,'body'),true).value,'手机独立值\r\n🙂');
 const boundary='x'.repeat(19998)+'🙂';assert.equal(findNode(patchNode(original,'search',{value:boundary}),'search').props.value,boundary);
 assert.throws(()=>patchNode(original,'search',{value:boundary+'x'}),chinese);assert.throws(()=>patchNode(original,'open',{value:'not an input'}),chinese);assert.throws(()=>patchNode(original,'body',{value:42}),chinese);
 const added=addNode(original,'card','textarea'),newInput=added.nodes.find(item=>!findNode(original,item.id));assert.equal(newInput.props.value,'');
});

test('grid columns are explicit layout properties, survive import and stay independent on mobile',()=>{
 const original=fixture(),semanticOnly=patchNode(original,'card',{role:'note-cards'});assert.equal(findNode(semanticOnly,'card').props.display,undefined,'a role never introduces a renderer layout');assert.equal(findNode(semanticOnly,'card').props.columns,undefined);
 const grid=patchNode(original,'card',{display:'grid',columns:2}),mobile=patchNode(grid,'card',{columns:1},{mobile:true}),imported=validateLayout(JSON.parse(JSON.stringify(mobile)));
 assert.equal(findNode(imported,'card').props.display,'grid');assert.equal(effectiveProps(findNode(imported,'card'),false).columns,2);assert.equal(effectiveProps(findNode(imported,'card'),true).columns,1);
 const cleared=patchNode(imported,'card',{columns:undefined},{mobile:true});assert.equal(effectiveProps(findNode(cleared,'card'),true).columns,2);
 assert.equal(findNode(patchNode(original,'card',{display:'flex'}),'card').props.display,'flex');
 for(const columns of [0,7,1.5,'2',NaN])assert.throws(()=>patchNode(original,'card',{columns}),chinese);for(const display of ['block','url(bad)',42])assert.throws(()=>patchNode(original,'card',{display}),chinese);
 const inherit=patchNode(patchNode(original,'title',{color:'#123456',fontWeight:600,lineHeight:1.5}), 'title',{color:undefined,fontWeight:undefined,lineHeight:undefined});assert.equal(findNode(inherit,'title').props.color,undefined);assert.equal(findNode(inherit,'title').props.fontWeight,undefined);assert.equal(findNode(inherit,'title').props.lineHeight,undefined);
});

test('image sources use static roles only and action/role/icon strings cannot carry code or URLs',()=>{
 const original=fixture();for(const srcRole of IMAGE_ROLES)assert.equal(findNode(patchNode(original,'photo',{srcRole,imageFit:'contain'}),'photo').props.srcRole,srcRole);
 const alias=fixture();findNode(alias,'photo').props={image:'window'};assert.equal(findNode(validateLayout(alias),'photo').props.srcRole,'window');assert.equal(findNode(validateLayout(alias),'photo').props.image,undefined);
 for(const src of ['https://example.com/a.png','data:image/png;base64,AAAA','data:image/svg+xml,<svg onload="alert(1)"></svg>','<svg><script>bad()</script></svg>']){assert.throws(()=>patchNode(original,'photo',{src}),chinese);const bad=fixture();findNode(bad,'photo').props.src=src;assert.throws(()=>validateLayout(bad),chinese);}
 for(const action of ['javascript:alert','data:text','https:bad','alert(1)','x => y','<script>','constructor','x;run'])assert.throws(()=>patchNode(original,'open',{action}),chinese);
 for(const action of ['note:open-1','scene:topics','toggle-coauthor'])assert.equal(findNode(patchNode(original,'open',{action}),'open').props.action,action);
 assert.equal(findNode(patchNode(original,'card',{role:'note-card'}),'card').props.role,'note-card');assert.equal(findNode(patchNode(original,'glyph',{icon:'chevron-right'}),'glyph').props.icon,'chevron-right');
 assert.throws(()=>patchNode(original,'card',{role:'<html>'}),chinese);assert.throws(()=>patchNode(original,'photo',{srcRole:'remote-url'}),chinese);assert.throws(()=>patchNode(original,'title',{srcRole:'window'}),chinese);
});

test('imports reject invalid IDs, duplicates, cross-scenes, wrong parents and roots hidden on either device',()=>{
 for(const id of ['../x','bad id','constructor','prototype','__proto__','x'.repeat(97)])assert.throws(()=>validateLayout(append(fixture(),node(id,'text','card'))),chinese);
 assert.throws(()=>validateLayout(append(fixture(),node('title','text','card'))),chinese);
 const badParent=fixture();findNode(badParent,'card').parentId='missing';assert.throws(()=>validateLayout(badParent),chinese);
 const cross=fixture();findNode(cross,'title').parentId='read-main';assert.throws(()=>validateLayout(cross),chinese);
 const cycle=fixture();findNode(cycle,'card').parentId='other';append(cycle,node('other','container','card'));assert.throws(()=>validateLayout(cycle),chinese);
 for(const id of FIXED_IDS)for(const mobile of [false,true])assert.throws(()=>patchNode(fixture(),id,{hidden:true},{mobile}),chinese);
});

test('2000-node cap and deep subtree edits are bounded and do not rely on recursive traversal',()=>{
 const full=fixture();while(full.nodes.length<2000)append(full,node('extra-'+full.nodes.length,'text','card'));
 assert.equal(validateLayout(full).nodes.length,2000);assert.throws(()=>addNode(full,'card','text'),chinese);assert.throws(()=>duplicateNode(full,'title'),chinese);append(full,node('too-many','text','card'));assert.throws(()=>validateLayout(full),chinese);
 const deep=fixture();let parent='card';for(let i=0;i<1500;i++){const id='deep-'+i;append(deep,node(id,'container',parent));parent=id;}
 const valid=validateLayout(deep),removed=removeNode(valid,'deep-0');assert.equal(removed.nodes.length,fixture().nodes.length);assert.equal(findNode(valid,'deep-1499').parentId,'deep-1498');
});

test('v2 history retains at most 100 detached snapshots and supports atomic branching and reset',()=>{
 const initial=fixture(),history=new LayoutHistory(initial);history.commit(patchNode(initial,'title',{text:'first'}));history.commit(removeNode(history.current,'photo'));
 const exposed=history.current;findNode(exposed,'title').props.text='mutated';assert.equal(findNode(history.current,'title').props.text,'first');assert.equal(findNode(history.current,'photo'),null);
 assert(findNode(history.undo(),'photo'));assert.equal(history.canRedo,true);history.commit(duplicateNode(history.current,'open'));assert.equal(history.canRedo,false);
 const before=history.current;assert.throws(()=>history.commit({version:2,nodes:[]}),chinese);assert.deepEqual(history.current,before);
 history.reset(initial);for(let i=0;i<130;i++)history.commit(patchNode(history.current,'title',{text:String(i)}));let undos=0;while(history.canUndo){history.undo();undos++;}assert.equal(undos,99);assert.equal(findNode(history.current,'title').props.text,'30');
 history.redo();history.commit(history.current);assert.equal(history.canRedo,true);history.reset(initial);assert.equal(history.canUndo,false);assert.equal(history.canRedo,false);assert.deepEqual(history.current,initial);
});
