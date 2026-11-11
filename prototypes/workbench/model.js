export const SCENES=['shared','library','read','edit','topics'];
export const CONTENT_ROLES=['folders','note-cards','note-list','document','editor','outline','questions','sources','source-reader','chat'];
const TYPES=['container','text','button','input','content'];
const BASE_PROPS={hidden:false,width:'auto',height:'auto',direction:'column',wrap:false,gap:12,padding:0,margin:0,fontSize:14,align:'stretch',overflow:'visible',note:''};
const PROP_KEYS=new Set([...Object.keys(BASE_PROPS),'text','role']);
const FIXED={workspace:{parentId:null,scene:'shared'},'global-nav':{parentId:'workspace',scene:'shared'},'scene-host':{parentId:'workspace',scene:'shared'},'nav-actions':{parentId:'global-nav',scene:'shared'},...Object.fromEntries(SCENES.filter(scene=>scene!=='shared').map(scene=>['scene-'+scene,{parentId:'scene-host',scene}]))};
const RESERVED={brand:{type:'text',scene:'shared'},'nav-library':{type:'button',scene:'shared'},'nav-topics':{type:'button',scene:'shared'},'nav-search':{type:'input',scene:'shared'}};
const fail=message=>{throw new Error(message);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const idValid=value=>typeof value==='string'&&!['constructor','prototype','__proto__'].includes(value)&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const copy=layout=>({version:1,nodes:layout.nodes.map(node=>({...node,props:{...node.props},...(node.mobile?{mobile:{...node.mobile}}:{})}))});
function boundedText(value,name,max){if(typeof value!=='string'||value.length>max)fail(name+'必须是长度不超过 '+max+' 的文字');return value;}
function sanitizeProps(input,type,{partial=false}={}){
 if(!plain(input))fail('节点属性必须是普通对象');
 const result=partial?{}:{...BASE_PROPS};
 for(const key of Object.keys(input)){
  if(!PROP_KEYS.has(key))continue;
  const value=input[key];
  if(value===undefined){if(partial)continue;else continue;}
  if(key==='text')result.text=boundedText(value,'显示文字',10000);
  else if(key==='note')result.note=boundedText(value,'布局备注',2000);
  else if(key==='hidden'||key==='wrap'){if(typeof value!=='boolean')fail((key==='hidden'?'隐藏':'换行')+'属性必须为布尔值');result[key]=value;}
  else if(key==='width'||key==='height'){
   if(value!=='auto'&&value!=='fill'&&!(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=4000))fail('宽高必须为 auto、fill 或 0 到 4000 的数字');
   result[key]=value;
  }else if(key==='direction'){if(!['row','column'].includes(value))fail('排列方向必须为 row 或 column');result.direction=value;}
  else if(key==='align'){if(!['stretch','start','center','end'].includes(value))fail('对齐方式无效');result.align=value;}
  else if(key==='overflow'){if(!['auto','hidden','visible'].includes(value))fail('滚动方式必须为 auto、hidden 或 visible');result.overflow=value;}
  else if(key==='role'){
   if(type!=='content'||!CONTENT_ROLES.includes(value))fail('内容角色无效，且只能用于内容节点');result.role=value;
  }else{
   const [min,max]=key==='fontSize'?[8,96]:key==='gap'?[0,128]:[0,160];
   if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(key+' 必须为 '+min+' 到 '+max+' 的数字');result[key]=value;
  }
 }
 if(type==='content'&&!partial&&result.role===undefined)result.role='document';
 return result;
}

export function createDefaultLayout(){
 const nodes=[];
 function add(id,type,name,parentId,scene,props={},mobile){nodes.push({id,type,name,parentId,scene,props:{...BASE_PROPS,...props},...(mobile?{mobile:{...mobile}}:{})});}
 const box=(id,name,parent,scene,props={},mobile)=>add(id,'container',name,parent,scene,props,mobile);
 const text=(id,name,parent,scene,value,props={},mobile)=>add(id,'text',name,parent,scene,{text:value,...props},mobile);
 const button=(id,name,parent,scene,value,props={})=>add(id,'button',name,parent,scene,{text:value,...props});
 const input=(id,name,parent,scene,value,props={},mobile)=>add(id,'input',name,parent,scene,{text:value,...props},mobile);
 const content=(id,name,parent,scene,role,props={},mobile)=>add(id,'content',name,parent,scene,{role,...props},mobile);
 box('workspace','工作区',null,'shared',{width:'fill',height:'fill',gap:0,overflow:'hidden'});
 box('global-nav','全局导航','workspace','shared',{direction:'row',height:64,padding:16,gap:12,align:'center'},{height:'auto',direction:'row',wrap:true,padding:12,gap:8,align:'center'});
 text('brand','品牌','global-nav','shared','DSH NOTEBOOK',{fontSize:17});
 button('nav-library','笔记页签','global-nav','shared','笔记');button('nav-topics','待整理页签','global-nav','shared','待整理');
 input('nav-search','全局搜索','global-nav','shared','搜索笔记与讨论…',{width:'fill'},{width:'fill'});
 box('nav-actions','全局操作','global-nav','shared',{direction:'row',gap:8},{hidden:true});button('action-settings','设置','nav-actions','shared','设置');
 box('scene-host','场景区域','workspace','shared',{width:'fill',height:'fill',gap:0,overflow:'auto'});
 for(const scene of ['library','read','edit','topics']){
  box('scene-'+scene,({library:'笔记库',read:'阅读',edit:'编辑',topics:'待整理'})[scene]+'场景','scene-host',scene,{width:'fill',height:'fill',direction:'row',gap:18,padding:20},{direction:'column',height:'auto',padding:12,gap:12});
  if(scene==='library'){
   box('library-sidebar','分类侧栏','scene-library',scene,{width:220,gap:14},{width:'fill',height:'auto'});
   input('category-search','分类搜索','library-sidebar',scene,'筛选分类…');content('folder-tree','文件夹树','library-sidebar',scene,'folders',{height:'fill',overflow:'auto'},{height:140});
   box('library-main','笔记库主区','scene-library',scene,{width:'fill',height:'fill',gap:18},{height:'auto'});
   box('library-toolbar','笔记库工具栏','library-main',scene,{direction:'row',gap:10,align:'center'},{direction:'column',align:'stretch'});
   button('new-note','新建笔记','library-toolbar',scene,'新建笔记');input('search-notes','搜索笔记','library-toolbar',scene,'搜索标题、正文、标签…',{width:'fill'});button('library-view','切换视图','library-toolbar',scene,'切换视图');
   content('library-grid','笔记卡片','library-main',scene,'note-cards',{width:'fill',height:'fill',gap:16},{height:'auto'});
  }else if(scene==='read'||scene==='edit'){
   box(scene+'-sidebar','笔记列表侧栏','scene-'+scene,scene,{width:205},{width:'fill',height:160});content(scene+'-note-list','笔记列表',scene+'-sidebar',scene,'note-list',{height:'fill',overflow:'auto'});
   box(scene+'-main',scene==='read'?'阅读主区':'编辑主区','scene-'+scene,scene,{width:'fill',height:'fill',gap:18},{height:'auto'});
   box(scene+'-header','文档标题栏',scene+'-main',scene,{direction:'row',gap:14,align:'center'},{direction:'column',align:'stretch'});
   text(scene+'-title','文档标题',scene+'-header',scene,'把值得留下的内容，放在这里',{fontSize:24,width:'fill'},{fontSize:21});
   box(scene+'-actions','文档操作',scene+'-header',scene,{direction:'row',gap:8});
   if(scene==='read'){button('read-edit','进入编辑','read-actions',scene,'编辑');button('read-source','打开共创','read-actions',scene,'AI 共创');content('read-document','正文阅读','read-main',scene,'document',{width:'fill',height:'fill',fontSize:16,padding:20,overflow:'auto'},{height:500,padding:12,fontSize:16});}
   else{button('edit-preview','预览笔记','edit-actions',scene,'预览');button('edit-save','保存笔记','edit-actions',scene,'保存');button('edit-source','打开共创','edit-actions',scene,'AI 共创');content('edit-editor','正文编辑','edit-main',scene,'editor',{width:'fill',height:'fill',fontSize:16,padding:16,overflow:'auto'},{height:500,padding:10});}
   content(scene+'-outline','页内目录','scene-'+scene,scene,'outline',{width:180,hidden:true},{width:'fill',hidden:true});
   content(scene+'-coauthor','原生共创','scene-'+scene,scene,'chat',{width:310,hidden:true},{width:'fill',height:420,hidden:true});
  }else{
   box('topics-sidebar','问题侧栏','scene-topics',scene,{width:220,gap:12},{width:'fill',height:'auto'});text('topics-heading','问题列表标题','topics-sidebar',scene,'待整理的问题',{fontSize:18});button('topic-new','新增问题','topics-sidebar',scene,'新建问题');content('topics-question-list','问题列表','topics-sidebar',scene,'questions',{height:'fill',overflow:'auto'},{height:100});
   box('topics-main','问题工作区','scene-topics',scene,{width:'fill',height:'fill',gap:18},{height:'auto'});box('topics-header','问题标题栏','topics-main',scene,{direction:'row',align:'center'},{direction:'column',align:'stretch'});
   text('topics-title','当前问题','topics-header',scene,'怎样把这些材料联系起来？',{fontSize:23,width:'fill'},{fontSize:21});box('topics-actions','问题操作','topics-header',scene,{direction:'row'});button('topic-new-note','手工成稿','topics-actions',scene,'新建正式笔记');
   box('topics-body','来源与共创并排区','topics-main',scene,{direction:'row',width:'fill',height:'fill',gap:18},{direction:'column',height:'auto'});box('topics-evidence','来源工作区','topics-body',scene,{width:'fill',height:'fill',gap:14},{height:'auto'});
   content('topics-sources','已选来源','topics-evidence',scene,'sources',{height:180,overflow:'auto'},{height:150});content('topics-reader','来源原文','topics-evidence',scene,'source-reader',{height:'fill',fontSize:15,overflow:'auto'},{height:260});content('topics-chat','原生共创','topics-body',scene,'chat',{width:340,height:'fill'},{width:'fill',height:440});
  }
 }
 return validateLayout({version:1,nodes});
}

export function validateLayout(input){
 if(!plain(input)||input.version!==1||!Array.isArray(input.nodes))fail('布局必须为 version:1 且包含 nodes 数组');
 if(input.nodes.length>250)fail('布局最多允许 250 个节点');
 const seen=new Set(),nodes=input.nodes.map(value=>{
  if(!plain(value)||!idValid(value.id))fail('节点 ID 必须以字母开头，仅含字母、数字、短横线或下划线，长度最多 64');
  if(seen.has(value.id))fail('节点 ID 不能重复：'+value.id);seen.add(value.id);
  if(!TYPES.includes(value.type))fail('节点类型无效：'+value.id);
  if(!SCENES.includes(value.scene))fail('节点场景无效：'+value.id);
  if(value.parentId!==null&&!idValid(value.parentId))fail('父节点 ID 无效：'+value.id);
  const node={id:value.id,type:value.type,name:boundedText(value.name??value.id,'节点名称',80),parentId:value.parentId,scene:value.scene,props:sanitizeProps(value.props??{},value.type)};
  if(value.mobile!==undefined)node.mobile=sanitizeProps(value.mobile,value.type,{partial:true});
  return node;
 });
 const layout={version:1,nodes},byId=new Map(nodes.map(node=>[node.id,node]));
 for(const [id,definition] of Object.entries(FIXED)){
  const node=byId.get(id);
  if(!node||node.type!=='container'||node.parentId!==definition.parentId||node.scene!==definition.scene)fail('固定结构节点缺失或位置无效：'+id);
  if((id==='workspace'||id.startsWith('scene-'))&&(node.props.hidden||node.mobile?.hidden))fail('工作区和场景根节点不能隐藏：'+id);
 }
 for(const [id,definition] of Object.entries(RESERVED)){const node=byId.get(id);if(!node||node.type!==definition.type||node.scene!==definition.scene)fail('保留功能节点缺失或类型无效：'+id);}
 for(const node of nodes){
  if(node.id==='workspace')continue;
  const parent=byId.get(node.parentId);
  if(!parent||parent.type!=='container')fail('父节点必须是已有容器：'+node.id);
  if(!Object.hasOwn(FIXED,node.id)&&(['workspace','scene-host'].includes(parent.id)||node.scene!==parent.scene))fail('节点只能位于同一场景的普通容器内：'+node.id);
  const path=new Set([node.id]);let current=parent;
  while(current){if(path.has(current.id))fail('布局不能包含循环父子关系：'+node.id);path.add(current.id);current=byId.get(current.parentId);}
 }
 return layout;
}
export function findNode(layout,id){return layout.nodes.find(node=>node.id===id)??null;}
export function childrenOf(layout,id){return layout.nodes.filter(node=>node.parentId===id);}
export function effectiveProps(node,mobile=false){return {...node.props,...(mobile?node.mobile:{})};}

export function moveNode(layout,id,parentId,index){
 const next=validateLayout(layout),node=findNode(next,id),parent=findNode(next,parentId);
 if(!node)fail('找不到要移动的节点');if(Object.hasOwn(FIXED,id))fail('固定结构节点不能移动');
 if(!parent||parent.type!=='container'||['workspace','scene-host'].includes(parentId))fail('只能移入普通容器');
 if(node.scene!==parent.scene)fail('不能跨场景移动节点');
 let ancestor=parent;while(ancestor){if(ancestor.id===node.id)fail('不能将节点移入自身或后代');ancestor=findNode(next,ancestor.parentId);}
 next.nodes=next.nodes.filter(item=>item.id!==id);const siblings=childrenOf(next,parentId);
 if(!Number.isSafeInteger(index)||index<0||index>siblings.length)fail('目标排序位置无效');
 const before=siblings[index],last=siblings.at(-1),position=before?next.nodes.findIndex(item=>item.id===before.id):last?next.nodes.findIndex(item=>item.id===last.id)+1:next.nodes.findIndex(item=>item.id===parentId)+1;
 node.parentId=parentId;next.nodes.splice(position,0,node);return validateLayout(next);
}
export function patchNode(layout,id,patch,{mobile=false}={}){
 const next=validateLayout(layout),node=findNode(next,id);if(!node)fail('找不到要修改的节点');if(!plain(patch))fail('属性修改必须是普通对象');
 if(Object.hasOwn(patch,'name')){if(mobile)fail('节点名称不属于手机独立属性');node.name=boundedText(patch.name,'节点名称',80);}
 for(const key of ['id','type','parentId','scene'])if(Object.hasOwn(patch,key))fail('不能通过属性面板更改节点结构：'+key);
 if(patch.props!==undefined&&!plain(patch.props))fail('props 必须是普通对象');
 const values={...patch,...(patch.props||{})},target={...(mobile?node.mobile:node.props)};
 for(const key of PROP_KEYS)if(Object.hasOwn(values,key)){if(values[key]===undefined)delete target[key];else target[key]=values[key];}
 if(mobile)node.mobile=sanitizeProps(target,node.type,{partial:true});else node.props=sanitizeProps(target,node.type);
 return validateLayout(next);
}
export function resetScene(layout,scene){
 if(!SCENES.includes(scene))fail('要重置的场景无效');const current=validateLayout(layout),defaults=createDefaultLayout().nodes.filter(node=>node.scene===scene),nodes=[];let inserted=false;
 for(const node of current.nodes){if(node.scene===scene){if(!inserted){nodes.push(...defaults);inserted=true;}}else nodes.push(node);}
 if(!inserted)nodes.push(...defaults);return validateLayout({version:1,nodes});
}
export class LayoutHistory{
 constructor(initial){this.reset(initial);}
 get current(){return copy(this._entries[this._index]);}
 get canUndo(){return this._index>0;}
 get canRedo(){return this._index<this._entries.length-1;}
 commit(next){const valid=validateLayout(next);if(JSON.stringify(valid)===JSON.stringify(this._entries[this._index]))return this.current;this._entries=this._entries.slice(0,this._index+1);this._entries.push(valid);if(this._entries.length>100)this._entries.shift();this._index=this._entries.length-1;return this.current;}
 undo(){if(this.canUndo)this._index--;return this.current;}
 redo(){if(this.canRedo)this._index++;return this.current;}
 reset(next){this._entries=[validateLayout(next)];this._index=0;return this.current;}
}
