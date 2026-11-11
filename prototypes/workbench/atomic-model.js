// Offline-only layout data. No DOM, React, code evaluation or external resources.
export const SCENES=Object.freeze(['shared','library','read','edit','topics']);
export const NODE_TYPES=Object.freeze(['container','text','button','input','textarea','icon','image','separator']);
export const IMAGE_ROLES=Object.freeze(['window','landscape','portrait','placeholder']);
export const FIXED_IDS=Object.freeze(['workspace','scene-host','scene-library','scene-read','scene-edit','scene-topics']);
const FIXED=new Map([['workspace',{parentId:null,scene:'shared'}],['scene-host',{parentId:'workspace',scene:'shared'}],...SCENES.filter(scene=>scene!=='shared').map(scene=>['scene-'+scene,{parentId:'scene-host',scene}])]);
const BASE={hidden:false,width:'auto',height:'auto',direction:'column',wrap:false,gap:12,padding:0,margin:0,fontSize:'inherit',align:'stretch',overflow:'visible',note:''};
const EDGES=['paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft'];
const COLORS=['color','background','borderColor'];
const PROP_KEYS=new Set([...Object.keys(BASE),...EDGES,...COLORS,'text','action','role','fontWeight','lineHeight','textAlign','fontStyle','borderWidth','borderRadius','imageFit','srcRole','image','icon','value','display','columns']);
const fail=message=>{throw new Error(message);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const idValid=value=>typeof value==='string'&&!['constructor','prototype','__proto__'].includes(value)&&/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value);
const safeToken=(value,max)=>typeof value==='string'&&value.length<=max&&/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)&&!['constructor','prototype','__proto__'].includes(value)&&! /^(?:javascript|vbscript|data|https?|file):/i.test(value);
const finite=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
function text(value,name,max){if(typeof value!=='string'||value.length>max)fail(name+'必须为不超过 '+max+' 个字符的文字');return value;}
function sanitizeProps(input,type,partial=false){
 if(!plain(input))fail('节点属性必须是普通对象');
 if(Object.hasOwn(input,'src')&&input.src!==undefined)fail('不允许任意图片地址；请使用内置图片 srcRole');
 const result=partial?{}:{...BASE};
 for(const key of Object.keys(input)){
  if(!PROP_KEYS.has(key)||input[key]===undefined)continue;
  const value=input[key];
  if(key==='text'){
   if(!['text','icon','input','textarea'].includes(type))fail('可见文字必须放在独立文字或图标节点，输入控件正文除外');result.text=text(value,'显示文字',10000);
  }else if(key==='value'){
   if(!['input','textarea'].includes(type))fail('初始内容只能用于输入控件');result.value=text(value,'输入控件初始内容',20000);
  }else if(key==='display'){if(!['flex','grid'].includes(value))fail('显示方式只能为 flex 或 grid');result.display=value;}
  else if(key==='columns'){if(!Number.isSafeInteger(value)||value<1||value>6)fail('网格列数必须为 1 到 6 的整数');result.columns=value;}
  else if(key==='note')result.note=text(value,'布局备注',2000);
  else if(key==='hidden'||key==='wrap'){if(typeof value!=='boolean')fail('隐藏与换行属性必须为布尔值');result[key]=value;}
  else if(key==='width'||key==='height'){if(!['auto','fill'].includes(value)&&!finite(value,0,4000))fail('宽高必须为 auto、fill 或 0 到 4000 的数字');result[key]=value;}
  else if(key==='direction'){if(!['row','column'].includes(value))fail('排列方向只能为 row 或 column');result.direction=value;}
  else if(key==='align'){if(!['stretch','start','center','end'].includes(value))fail('对齐方式无效');result.align=value;}
  else if(key==='overflow'){if(!['auto','hidden','visible'].includes(value))fail('滚动方式无效');result.overflow=value;}
  else if(key==='fontSize'){if(value!=='inherit'&&!finite(value,8,96))fail('字号必须为 inherit 或 8 到 96 的数字');result.fontSize=value;}
  else if(key==='fontWeight'){if(value!=='inherit'&&![400,500,600,700].includes(value))fail('字重只能为 inherit、400、500、600 或 700');result.fontWeight=value;}
  else if(key==='lineHeight'){if(!finite(value,1,3))fail('行高必须为 1 到 3 的数字');result.lineHeight=value;}
  else if(key==='textAlign'){if(!['left','center','right'].includes(value))fail('文字对齐方式无效');result.textAlign=value;}
  else if(key==='fontStyle'){if(!['normal','italic'].includes(value))fail('字形只能为 normal 或 italic');result.fontStyle=value;}
  else if(COLORS.includes(key)){if(typeof value!=='string'||!(value==='transparent'||/^#[0-9a-f]{6}$/i.test(value)))fail('颜色只能为六位十六进制色值或 transparent');result[key]=value;}
  else if(key==='action'||key==='role'||key==='icon'){
   if(!safeToken(value,key==='role'?64:96))fail(key+' 必须为短安全标识，不允许代码或网址');if(key==='icon'&&type!=='icon')fail('图标名称只能用于图标节点');result[key]=value;
  }else if(key==='srcRole'||key==='image'){
   if(type!=='image'||!IMAGE_ROLES.includes(value))fail('图片只能使用内置 srcRole');
   if(key==='srcRole'||!Object.hasOwn(input,'srcRole'))result.srcRole=value;
  }else if(key==='imageFit'){if(type!=='image'||!['cover','contain'].includes(value))fail('图片适配方式只能为 cover 或 contain');result.imageFit=value;}
  else{
   const [min,max]=key==='gap'?[0,128]:key==='borderWidth'?[0,12]:key==='borderRadius'?[0,64]:[0,160];
   if(!finite(value,min,max))fail(key+' 必须为 '+min+' 到 '+max+' 的数字');result[key]=value;
  }
 }
 return result;
}
function copy(layout){return {version:2,nodes:layout.nodes.map(node=>({...node,props:{...node.props},...(node.mobile?{mobile:{...node.mobile}}:{})}))};}
export function findNode(layout,id){return layout.nodes.find(node=>node.id===id)??null;}
export function childrenOf(layout,id){return layout.nodes.filter(node=>node.parentId===id);}
export function effectiveProps(node,mobile=false){
 const result={...node.props,...(mobile?node.mobile:{})};
 for(const edge of EDGES)if(result[edge]===undefined)result[edge]=result[edge.startsWith('padding')?'padding':'margin']??0;
 return result;
}
function permits(parent,child){return parent.type==='container'||(parent.type==='button'&&['text','icon'].includes(child.type));}
export function validateLayout(input){
 if(!plain(input)||input.version!==2||!Array.isArray(input.nodes))fail('原子布局必须为 version:2 且包含 nodes 数组');
 if(input.nodes.length>2000)fail('原子布局最多允许 2000 个节点');
 const seen=new Set(),nodes=input.nodes.map(value=>{
  if(!plain(value)||!idValid(value.id))fail('节点 ID 必须为安全标识，以字母开头，长度最多 96');
  if(seen.has(value.id))fail('节点 ID 不能重复：'+value.id);seen.add(value.id);
  if(!NODE_TYPES.includes(value.type))fail('原子节点类型无效：'+value.id);
  if(!SCENES.includes(value.scene))fail('节点场景无效：'+value.id);
  if(value.parentId!==null&&!idValid(value.parentId))fail('父节点 ID 无效：'+value.id);
  const node={id:value.id,type:value.type,name:text(value.name??value.id,'节点名称',80),parentId:value.parentId,scene:value.scene,props:sanitizeProps(value.props??{},value.type)};
  if(value.mobile!==undefined)node.mobile=sanitizeProps(value.mobile,value.type,true);
  return node;
 });
 const layout={version:2,nodes},byId=new Map(nodes.map(node=>[node.id,node]));
 for(const [id,fixed] of FIXED){const node=byId.get(id);if(!node||node.type!=='container'||node.parentId!==fixed.parentId||node.scene!==fixed.scene)fail('固定结构节点缺失或位置无效：'+id);if(node.props.hidden||node.mobile?.hidden)fail('工作区和场景根节点不能隐藏：'+id);}
 for(const node of nodes){
  if(node.id==='workspace')continue;
  const parent=byId.get(node.parentId);
  if(!parent||!permits(parent,node))fail('父节点必须是容器，按钮只能包含文字或图标：'+node.id);
  if(!FIXED.has(node.id)&&node.scene!==parent.scene)fail('节点不能跨场景放置：'+node.id);
 }
 const complete=new Set();
 for(const node of nodes){
  if(complete.has(node.id))continue;
  const path=new Set();let current=node;
  while(current&&!complete.has(current.id)){if(path.has(current.id))fail('布局不能包含循环父子关系：'+node.id);path.add(current.id);current=byId.get(current.parentId);}
  for(const id of path)complete.add(id);
 }
 return layout;
}
export function moveNode(layout,id,parentId,index){
 const next=validateLayout(layout),node=findNode(next,id),parent=findNode(next,parentId);
 if(!node)fail('找不到要移动的节点');if(FIXED.has(id))fail('固定结构节点不能移动');
 if(!parent||!permits(parent,node))fail('只能移入容器，按钮只接收文字和图标');
 if(node.scene!==parent.scene)fail('不能跨场景移动节点');
 const byId=new Map(next.nodes.map(value=>[value.id,value]));let current=parent;
 while(current){if(current.id===id)fail('不能将节点移入自身或后代');current=byId.get(current.parentId);}
 next.nodes=next.nodes.filter(value=>value.id!==id);const siblings=childrenOf(next,parentId);
 if(!Number.isSafeInteger(index)||index<0||index>siblings.length)fail('目标排序位置无效');
 const before=siblings[index],last=siblings.at(-1),position=before?next.nodes.findIndex(value=>value.id===before.id):last?next.nodes.findIndex(value=>value.id===last.id)+1:next.nodes.findIndex(value=>value.id===parentId)+1;
 node.parentId=parentId;next.nodes.splice(position,0,node);return validateLayout(next);
}
export function patchNode(layout,id,patch,{mobile=false}={}){
 const next=validateLayout(layout),node=findNode(next,id);if(!node)fail('找不到要修改的节点');if(!plain(patch))fail('属性修改必须为普通对象');
 if(Object.hasOwn(patch,'name')){if(mobile)fail('节点名称不属于手机覆盖属性');node.name=text(patch.name,'节点名称',80);}
 for(const key of ['id','type','parentId','scene'])if(Object.hasOwn(patch,key))fail('属性修改不能更改结构：'+key);
 if(patch.props!==undefined&&!plain(patch.props))fail('props 必须为普通对象');
 const values={...patch,...(patch.props||{})};if(Object.hasOwn(values,'src')&&values.src!==undefined)fail('不允许任意图片地址；请使用内置图片 srcRole');
 const target={...(mobile?node.mobile:node.props)};
 for(const key of PROP_KEYS)if(Object.hasOwn(values,key)){if(values[key]===undefined)delete target[key];else target[key]=values[key];}
 if(mobile)node.mobile=sanitizeProps(target,node.type,true);else node.props=sanitizeProps(target,node.type);
 return validateLayout(next);
}
function subtree(layout,id){
 const children=new Map();for(const node of layout.nodes){if(!children.has(node.parentId))children.set(node.parentId,[]);children.get(node.parentId).push(node.id);}
 const ids=new Set(),pending=[id];while(pending.length){const current=pending.pop();if(ids.has(current))continue;ids.add(current);pending.push(...children.get(current)||[]);}return ids;
}
export function removeNode(layout,id){
 const next=validateLayout(layout);if(!findNode(next,id))fail('找不到要删除的节点');const ids=subtree(next,id);if(FIXED_IDS.some(value=>ids.has(value)))fail('不能删除工作区或场景根节点');
 next.nodes=next.nodes.filter(node=>!ids.has(node.id));return validateLayout(next);
}
function availableId(base,used){let sequence=1,id;do{const suffix='-copy-'+sequence++;id=base.slice(0,96-suffix.length)+suffix;}while(used.has(id));used.add(id);return id;}
export function duplicateNode(layout,id){
 const next=validateLayout(layout),node=findNode(next,id);if(!node)fail('找不到要复制的节点');if(FIXED.has(id))fail('不能复制工作区或场景根节点');
 const ids=subtree(next,id);if(next.nodes.length+ids.size>2000)fail('复制后节点数将超过 2000');
 const used=new Set(next.nodes.map(value=>value.id)),mapping=new Map([...ids].map(value=>[value,availableId(value,used)]));
 const copies=next.nodes.filter(value=>ids.has(value.id)).map(value=>({...value,id:mapping.get(value.id),name:value.id===id?value.name.slice(0,76)+'（副本）':value.name,parentId:value.id===id?value.parentId:mapping.get(value.parentId),props:{...value.props},...(value.mobile?{mobile:{...value.mobile}}:{})}));
 next.nodes.splice(next.nodes.findIndex(value=>value.id===id)+1,0,...copies);return validateLayout(next);
}
export function addNode(layout,parentId,type){
 const next=validateLayout(layout),parent=findNode(next,parentId);if(!NODE_TYPES.includes(type))fail('要新增的原子类型无效');if(!parent||!permits(parent,{type}))fail('新增位置必须为容器，按钮只能新增文字和图标');
 const used=new Set(next.nodes.map(node=>node.id)),id=availableId('node-'+type,used),name=({container:'容器',text:'文字',button:'按钮',input:'输入框',textarea:'多行输入',icon:'图标',image:'图片',separator:'分隔线'})[type];
 const props=type==='text'?{text:'文字'}:type==='icon'?{text:'•'}:type==='input'?{text:'',value:''}:type==='textarea'?{text:'',value:'',height:120}:type==='image'?{srcRole:'window',imageFit:'cover',width:240,height:160}:type==='separator'?{height:1,background:'#d0d0d0'}:type==='button'?{direction:'row',gap:6,padding:8}:{};
 const added=[{id,type,name,parentId,scene:parent.scene,props}];
 if(type==='button')added.push({id:availableId(id+'-label',used),type:'text',name:'按钮文字',parentId:id,scene:parent.scene,props:{text:'按钮'}});
 if(next.nodes.length+added.length>2000)fail('新增后节点数将超过 2000');next.nodes.push(...added);return validateLayout(next);
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
