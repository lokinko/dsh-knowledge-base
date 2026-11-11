import {validateLayout,moveNode,patchNode,effectiveProps,findNode,childrenOf,LayoutHistory,removeNode,duplicateNode,addNode} from './atomic-model.js';
import {migrateLayout} from './atomic-layout.js';

const $=id=>document.getElementById(id);
const SCENES={library:'笔记库',read:'阅读笔记',edit:'编辑笔记',topics:'问题与共创'};
const TYPES={container:'容器',text:'文字',button:'按钮',input:'单行输入',textarea:'多行输入',icon:'图标',image:'图片',separator:'分隔线'};
const FIXED=new Set(['workspace','scene-host',...Object.keys(SCENES).map(scene=>'scene-'+scene)]);
const LIMIT=8*1024*1024;
const ACTION=/^(?:open-note-[0-3]|open-read|open-edit|select-folder-[0-4]|select-question-[0-2]|(?:select|open|remove)-source-[0-2]|add-source|send-chat|save-demo|toggle-chat|new-question|new-note|toggle-view|open-settings|show-library|show-topics|attach-chat|(?:copy|quote)-chat-[0-2]|outline-section-[0-1]|demo-action)$/;
function el(tag,attrs={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)){
    if(value==null)continue;
    if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);
    else if(key==='class')node.className=value;
    else if(['value','checked','disabled','hidden','draggable','selected'].includes(key))node[key]=value;
    else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity))if(child!=null)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  if(tag==='select'&&attrs.value!==undefined)node.value=attrs.value;
  return node;
}
const button=(text,fn,attrs={})=>el('button',{type:'button',onclick:fn,...attrs},text);
const option=(value,text)=>el('option',{value},text);
const clone=value=>structuredClone(value);
function readJSON(text){if(new TextEncoder().encode(text).byteLength>LIMIT)throw new Error('布局数据上限为 8 MiB');return JSON.parse(text);}
function asLayout(value){return validateLayout(value?.version===1?migrateLayout(value).layout:value);}
let embedded;
try{embedded=readJSON($('prototype-state').textContent);}catch(error){throw new Error('内嵌布局读取失败：'+error.message);}
if(!embedded||embedded.format!=='dsh-workbench-prototype'||embedded.version!==2)throw new Error('需要 version:2 的原子布局原型');
let baseline=validateLayout(embedded.baseline||embedded.layout);
const documentId=embedded.documentId||'atomic-initial';
const storageKey='knowledge-workbench-prototype:v2:'+documentId+':'+location.pathname;
let cached=null;
try{
  const candidate=readJSON(localStorage.getItem(storageKey)||'null');
  if(candidate)cached={...candidate,layout:validateLayout(candidate.layout),baseline:validateLayout(candidate.baseline)};
}catch{cached=null;}
if(cached)baseline=clone(cached.baseline);
let seed=cached||embedded,layout;
try{layout=validateLayout(seed.layout);}catch{layout=clone(baseline);seed=embedded;}
const history=new LayoutHistory(layout);
function safeUI(value){
  const ui={scene:'topics',device:'desktop',mode:'design',zoom:'fit',dark:false,...value};
  if(!Object.hasOwn(SCENES,ui.scene))ui.scene='topics';
  if(!['desktop','narrow','mobile'].includes(ui.device))ui.device='desktop';
  if(!['design','preview'].includes(ui.mode))ui.mode='design';
  if(!['fit','100','75','50'].includes(String(ui.zoom)))ui.zoom='fit';
  ui.dark=ui.dark===true;return ui;
}
let ui=safeUI(seed.ui),selected='scene-'+ui.scene;
let treeVisible=innerWidth>960,inspectorVisible=innerWidth>960,dragging=null,zoomRatio=1,toastTimer,treeQuery='';
const collapsed=new Set(),draftValues=new Map();
const WINDOW_IMAGE='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="260" viewBox="0 0 720 260"><rect width="720" height="260" fill="#ebe5d8"/><rect x="60" y="24" width="240" height="210" rx="4" fill="#c6d5d0"/><circle cx="230" cy="82" r="36" fill="#f4daa1"/><path d="M60 185L150 105 225 170 300 118V234H60Z" fill="#819a85"/><path d="M180 24V234M60 126H300" stroke="#fcfaf3" stroke-width="10"/><path d="M300 232L480 108H660V232Z" fill="#ddd3bb"/><rect x="410" y="138" width="190" height="12" fill="#816e52"/><path d="M426 150V230M584 150V230" stroke="#816e52" stroke-width="9"/><rect x="470" y="116" width="60" height="22" rx="3" fill="#a47662"/></svg>');
const PLACEHOLDER_IMAGE='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220"><rect width="400" height="220" fill="#e1e3e0"/><circle cx="280" cy="65" r="25" fill="#b1b6ad"/><path d="M20 200L130 70L220 165L285 115L380 200Z" fill="#929b8b"/></svg>');

function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,3200);}
function persist(){
  try{
    const text=JSON.stringify({layout:history.current,baseline,ui});if(new TextEncoder().encode(text).byteLength>LIMIT)throw new Error('布局超过 8 MiB');
    localStorage.setItem(storageKey,text);$('save-status').textContent='已保存在此浏览器 · 原子布局 v2';
  }catch{$('save-status').textContent='本地保存不可用 · 请导出文件';}
}
function ensureSelection(){if(!findNode(history.current,selected))selected='scene-'+ui.scene;}
function mutate(fn){try{history.commit(fn(history.current));ensureSelection();persist();render();}catch(error){toast(error.message);}}
function patch(values){mutate(layout=>patchNode(layout,selected,values,{mobile:ui.device==='mobile'}));}
function scene(value){if(!Object.hasOwn(SCENES,value))return;ui.scene=value;selected='scene-'+value;persist();render();}
function select(id){
  if(!findNode(history.current,id))return;
  selected=id;inspectorVisible=true;
  let node=findNode(history.current,id);while(node){collapsed.delete(node.id);node=findNode(history.current,node.parentId);}
  render();
}
function closeDialog(){$('dialogs').replaceChildren();}
function dialog(title,body,actions){
  const overlay=el('div',{class:'dialog-overlay',role:'presentation'},el('section',{class:'dialog',role:'dialog','aria-modal':'true','aria-label':title},el('h2',{},title),body,el('div',{class:'dialog-actions'},...actions)));
  $('dialogs').replaceChildren(overlay);overlay.addEventListener('click',event=>{if(event.target===overlay)closeDialog();});
  requestAnimationFrame(()=>overlay.querySelector('button,input,textarea,select')?.focus());
}
function confirmReset(all=false){
  dialog(all?'重置全部原子布局':'重置当前场景',el('p',{},'恢复这份文件内嵌的用户基线，不恢复已删除的旧控件。操作可以撤销。'),[
    button('取消',closeDialog),button('确认重置',()=>{
      draftValues.clear();
      mutate(current=>all?clone(baseline):validateLayout({version:2,nodes:[...current.nodes.filter(node=>node.scene!==ui.scene),...clone(baseline.nodes.filter(node=>node.scene===ui.scene))]}));
      closeDialog();
    })]);
}
function download(name,text,type){
  if(new TextEncoder().encode(text).byteLength>LIMIT){toast('导出文件上限为 8 MiB');return false;}
  const url=URL.createObjectURL(new Blob([text],{type})),anchor=el('a',{href:url,download:name});
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);return true;
}
function envelope(){return {format:'dsh-workbench-prototype',version:2,layout:history.current,baseline:clone(baseline),ui:{...ui},documentId:crypto.randomUUID?.()||Date.now().toString(36)};}
function exportHTML(){
  const copy=document.documentElement.cloneNode(true);copy.querySelector('#app').replaceChildren();
  copy.querySelector('#prototype-state').textContent=JSON.stringify(envelope()).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
  if(download('我的知识库原子布局.html','<!doctype html>\n'+copy.outerHTML,'text/html;charset=utf-8'))toast('已导出自包含原子布局 HTML，可离线继续调整');
}
async function importFile(file){
  if(!file)return;
  try{
    if(file.size>LIMIT)throw new Error('布局文件上限为 8 MiB');
    const input=readJSON(await file.text());
    if(input.layout&&(input.format!=='dsh-workbench-prototype'||![1,2].includes(input.version)||input.version!==input.layout.version))throw new Error('布局文件格式或版本不受支持，外壳与布局版本必须一致');
    const next=asLayout(input.layout||input);
    const nextBaseline=input.baseline?asLayout(input.baseline):next;
    history.commit(next);baseline=clone(nextBaseline);ui=safeUI({...ui,...input.ui});selected='scene-'+ui.scene;draftValues.clear();
    persist();render();toast('原子布局已导入，可撤销布局修改');
  }catch(error){toast('导入失败：'+error.message);}finally{$('import-file').value='';}
}
function help(){dialog('调整原子布局',el('div',{},
  el('p',{},'每一段文字、图标、按钮、输入框和图片都是独立图层。点击画布或搜索图层名称 / ID 后，在属性面板调整。按钮内也可独立选择文字和图标。'),
  el('p',{},'可新增、复制、删除控件，删除前会确认，全部布局操作支持撤销。拖动选中控件的手柄移动，或用所在容器与上下移动精确排序。'),
  el('p',{},'手机画布保存独立外观覆盖；父子关系与顺序在各尺寸共用。重置仅恢复本文件内嵌的用户基线。'),
  el('p',{},'体验模式只演示本地交互，不连接资料库或模型。输入内容仅保存在页面内存；要编辑输入框初始值，请使用属性面板。'),
  el('p',{},'导出 JSON 或保存 HTML 后可离线重新打开。Ctrl / Cmd + Z 撤销，Shift + Z 或 Ctrl + Y 重做；输入框里的撤销由浏览器处理。')),[button('开始调整',closeDialog)]);}

// Product rendering is entirely recursive. Roles select semantics or a safe
// demonstration action; they never manufacture unregistered product children.
function applyProps(wrapper,node,parent,props,parentProps){
  const s=wrapper.style,axis=parentProps?.direction||'column';
  Object.assign(s,{display:props.display==='grid'?'grid':node.type==='text'?'block':'flex',position:'relative',minWidth:'0',minHeight:'0',flexDirection:props.direction||'column',flexWrap:props.wrap?'wrap':'nowrap',gap:(props.gap??0)+'px',padding:(props.padding??0)+'px',margin:(props.margin??0)+'px',alignItems:{stretch:'stretch',start:'flex-start',center:'center',end:'flex-end'}[props.align]||'stretch',overflow:props.overflow||'visible',fontSize:typeof props.fontSize==='number'?props.fontSize+'px':'inherit'});
  for(const key of ['color','background','borderColor','fontWeight','lineHeight','textAlign','fontStyle'])if(props[key]!==undefined)s[key]=String(props[key]);
  for(const key of ['borderWidth','borderRadius'])if(props[key]!==undefined)s[key]=typeof props[key]==='number'?props[key]+'px':props[key];
  if(props.borderWidth!==undefined)s.borderStyle=props.borderWidth?'solid':'none';
  for(const group of ['padding','margin'])for(const side of ['Top','Right','Bottom','Left'])if(props[group+side]!==undefined)s[group+side]=props[group+side]+'px';
  if(props.display==='grid')s.gridTemplateColumns='repeat('+(props.columns??1)+', minmax(0, 1fr))';
  if(props.width==='fill'){if(parentProps?.display==='grid')s.width='100%';else if(axis==='row')s.flex=parentProps?.wrap?'1 1 100%':'1 1 0';else s.width='100%';}
  else if(typeof props.width==='number'){s.width=props.width+'px';if(axis==='row')s.flex='0 0 '+props.width+'px';}
  else s.width='auto';
  if(props.height==='fill'){if(!parent)s.height='100%';else if(axis==='column')s.flex='1 1 0';else s.height='100%';}
  else if(typeof props.height==='number'){s.height=props.height+'px';if(axis==='column')s.flex='0 0 '+props.height+'px';}
  else if(parent&&axis==='column')s.flex='0 0 auto';
  if(node.type==='text'||node.type==='icon')s.whiteSpace='pre-wrap';
}
function nodeView(node,current){
  if(!node||node.scene!=='shared'&&node.scene!==ui.scene)return null;
  const props=effectiveProps(node,ui.device==='mobile');if(props.hidden)return null;
  const tag=node.type==='button'?'button':['text','icon'].includes(node.type)?'span':'div';
  const wrapper=el(tag,{class:'layout-node atomic-node'+(node.type==='container'?' container':'')+(selected===node.id?' selected':''),'data-id':node.id,'data-type':node.type,'data-role':props.role||'','aria-label':node.name,...(tag==='button'?{type:'button'}:{})});
  const parent=findNode(current,node.parentId),parentProps=parent?effectiveProps(parent,ui.device==='mobile'):null;
  applyProps(wrapper,node,parent,props,parentProps);
  if(node.type==='container'||node.type==='button'){
    for(const child of childrenOf(current,node.id)){const view=nodeView(child,current);if(view)wrapper.append(view);}
  }else if(node.type==='text'||node.type==='icon')wrapper.append(document.createTextNode(props.text??''));
  else if(node.type==='input'||node.type==='textarea'){
    const initial=props.value??'';
    const input=el(node.type==='textarea'?'textarea':'input',{class:'atomic-field','aria-label':node.name,...(node.type==='input'?{type:'text'}:{}),placeholder:props.text??'',value:draftValues.get(node.id)??initial,oninput:event=>{draftValues.set(node.id,event.target.value);}});
    wrapper.append(input);
  }else if(node.type==='image')wrapper.append(el('img',{class:'atomic-image',src:props.srcRole==='window'?WINDOW_IMAGE:PLACEHOLDER_IMAGE,alt:node.name,draggable:false,style:'object-fit:'+(props.imageFit||'contain')}));
  else if(node.type==='separator')wrapper.setAttribute('role','separator');
  if(ui.mode==='design'&&selected===node.id){
    wrapper.append(el('span',{class:'node-badge','data-designer-only':'badge'},node.name+' · '+node.id));
    if(!FIXED.has(node.id))wrapper.append(el('span',{class:'drag-grip',draggable:true,tabindex:0,role:'button','data-designer-only':'drag',title:'拖动到兼容区域','aria-label':'拖动 '+node.name,ondragstart:event=>{dragging=node.id;event.dataTransfer.setData('text/plain',node.id);event.dataTransfer.effectAllowed='move';},ondragend:clearDrag},'⠿'));
    if(node.type==='container')wrapper.append(el('span',{class:'resize-handle',role:'separator','data-designer-only':'resize','aria-label':'调整 '+node.name+' 宽度',onpointerdown:event=>resize(event,node.id,wrapper)}));
  }
  return wrapper;
}
function renderCanvas(){const current=history.current,view=nodeView(findNode(current,'workspace'),current);$('canvas').replaceChildren(...(view?[view]:[]));fit();}
function fit(){
  const width={desktop:1180,narrow:860,mobile:390}[ui.device];$('viewport').dataset.device=ui.device;
  $('viewport').style.setProperty('--viewport-width',width+'px');zoomRatio=ui.zoom==='fit'?Math.max(.2,Math.min(1,($('stage-scroll').clientWidth-48)/width)):Number(ui.zoom)/100;
  $('viewport').style.zoom=zoomRatio;$('zoom-readout').textContent=Math.round(zoomRatio*100)+'%';
}
function resize(event,id,node){
  if(ui.mode!=='design')return;event.preventDefault();event.stopPropagation();
  const x=event.clientX,start=node.getBoundingClientRect().width/zoomRatio,mobile=ui.device==='mobile';let width=start;
  const move=event=>{width=Math.max(0,Math.min(4000,Math.round(start+(event.clientX-x)/zoomRatio)));node.style.width=width+'px';node.style.flex='0 0 '+width+'px';};
  const clear=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.removeEventListener('pointercancel',cancel);};
  const end=()=>{clear();mutate(current=>patchNode(current,id,{width},{mobile}));};
  const cancel=()=>{clear();renderCanvas();};
  document.addEventListener('pointermove',move);document.addEventListener('pointerup',end,{once:true});document.addEventListener('pointercancel',cancel,{once:true});
}
function clearDrag(){dragging=null;for(const node of $('canvas').querySelectorAll('.drop-target'))node.classList.remove('drop-target');}
function canParent(candidate,node){return candidate.id!==node.id&&candidate.scene===node.scene&&!['workspace','scene-host'].includes(candidate.id)&&(candidate.type==='container'||candidate.type==='button'&&['text','icon'].includes(node.type));}
function dropSpec(event){
  if(!dragging)return null;
  const target=event.target.closest('.layout-node');if(!target||target.dataset.id===dragging)return null;
  const current=history.current,node=findNode(current,target.dataset.id),moving=findNode(current,dragging);if(!node||!moving)return null;
  const props=effectiveProps(node,ui.device==='mobile'),parent=findNode(current,node.parentId),rect=target.getBoundingClientRect();
  const direction=['container','button'].includes(node.type)?props.direction:effectiveProps(parent,ui.device==='mobile').direction;
  const ratio=direction==='row'?(event.clientX-rect.left)/rect.width:(event.clientY-rect.top)/rect.height;
  let parentId,index;
  if(canParent(node,moving)&&ratio>.22&&ratio<.78){parentId=node.id;index=childrenOf(current,node.id).filter(child=>child.id!==dragging).length;}
  else{parentId=node.parentId;const siblings=childrenOf(current,parentId).filter(child=>child.id!==dragging);index=siblings.findIndex(child=>child.id===node.id)+(ratio>.5?1:0);}
  try{moveNode(current,dragging,parentId,index);return {parentId,index,target};}catch{return null;}
}

function renderTree(){
  const current=history.current,host=$('node-tree'),query=treeQuery.trim().toLowerCase();host.replaceChildren();
  const byId=new Map(current.nodes.map(node=>[node.id,node])),childMap=new Map(),matched=new Set();
  for(const node of current.nodes){if(!childMap.has(node.parentId))childMap.set(node.parentId,[]);childMap.get(node.parentId).push(node);}
  if(query)for(const node of current.nodes){
    if(node.scene!=='shared'&&node.scene!==ui.scene)continue;
    if(!(node.name+' '+node.id).toLowerCase().includes(query))continue;
    let ancestor=node;while(ancestor){matched.add(ancestor.id);ancestor=byId.get(ancestor.parentId);}
  }
  function add(node,depth){
    if(!node||node.scene!=='shared'&&node.scene!==ui.scene||query&&!matched.has(node.id))return;
    const props=effectiveProps(node,ui.device==='mobile'),children=childMap.get(node.id)||[],folded=!query&&collapsed.has(node.id);
    const row=el('div',{class:'tree-item'+(selected===node.id?' is-selected':'')+(props.hidden?' is-hidden':'')+(folded?' is-collapsed':''),'data-node-id':node.id,'data-depth':depth,title:node.name+' · '+node.id});row.style.paddingLeft=(8+depth*12)+'px';
    row.append(button(children.length?(folded?'▸':'▾'):'·',event=>{event.stopPropagation();if(collapsed.has(node.id))collapsed.delete(node.id);else collapsed.add(node.id);renderTree();},{class:'tree-toggle',disabled:!children.length,'aria-label':(folded?'展开 ':'折叠 ')+node.name,'aria-expanded':children.length?!folded:undefined}),
      button('',()=>select(node.id),{class:'tree-label'},),el('small',{},props.hidden?'隐藏':TYPES[node.type]));
    row.querySelector('.tree-label').textContent=node.name;row.querySelector('.tree-label').title=node.id;
    host.append(row);if(!folded)for(const child of children)add(child,depth+1);
  }
  add(byId.get('workspace'),0);
  if(!host.children.length)host.append(el('p',{class:'inspector-empty'},'没有匹配的图层'));
}
function field(label,control){const id='prop-'+label;control.id=id;return el('div',{class:'property-row'},el('label',{for:id},label),control);}
function numeric(key,label,value,{min=0,max=4000}={}){return field(label,el('input',{type:'number',min,max,step:'any',value,onchange:event=>patch({[key]:Number(event.target.value)})}));}
function selectProperty(key,label,values,value){const control=el('select',{onchange:event=>patch({[key]:event.target.value==='inherit'?undefined:event.target.value})},...Object.entries(values).map(([id,name])=>option(id,name)));control.value=value??'inherit';return field(label,control);}
function inheritanceNumber(key,label,value,min,max){
  const mode=el('select',{'aria-label':label+'模式',onchange:event=>patch({[key]:event.target.value==='inherit'?(key==='fontSize'?'inherit':undefined):key==='fontSize'?14:1.5})},option('inherit','继承父级'),option('number','自定义数值'));
  mode.value=value==='inherit'||value===undefined?'inherit':'number';
  const group=el('div',{class:'property-grid'},field(label,mode));if(mode.value==='number')group.append(numeric(key,label+'数值',value,{min,max}));return group;
}
function confirmDelete(){const node=findNode(history.current,selected);if(!node||FIXED.has(node.id))return;
  dialog('删除控件',el('p',{},'删除“'+node.name+'”及其全部子控件？可以撤销恢复。'),[button('取消',closeDialog),button('确认删除',()=>{const id=node.id;mutate(current=>removeNode(current,id));closeDialog();})]);}
function addDialog(){
  const current=history.current,chosen=findNode(current,selected),type=el('select',{'aria-label':'新增控件类型'},...Object.entries(TYPES).map(([id,label])=>option(id,label)));
  const parent=el('select',{'aria-label':'新增所在容器'});
  function fillParents(){parent.replaceChildren();for(const candidate of current.nodes){if(candidate.scene!==ui.scene&&candidate.scene!=='shared')continue;if(['workspace','scene-host'].includes(candidate.id))continue;if(candidate.type!=='container'&&!(candidate.type==='button'&&['text','icon'].includes(type.value)))continue;parent.append(option(candidate.id,candidate.name+' · '+candidate.id));}const preferred=['container','button'].includes(chosen?.type)?chosen.id:chosen?.parentId;if([...parent.options].some(option=>option.value===preferred))parent.value=preferred;}
  type.addEventListener('change',fillParents);fillParents();
  dialog('新增原子控件',el('div',{},field('控件类型',type),field('目标父节点',parent)),[button('取消',closeDialog),button('新增',()=>{if(!parent.value){toast('请先选择兼容容器');return;}const before=new Set(history.current.nodes.map(node=>node.id));mutate(current=>addNode(current,parent.value,type.value));const added=history.current.nodes.find(node=>!before.has(node.id));if(added)selected=added.id;closeDialog();render();})]);
}
function renderInspector(){
  ensureSelection();const current=history.current,node=findNode(current,selected),host=$('inspector');host.replaceChildren();if(!node)return;
  const mobile=ui.device==='mobile',props=effectiveProps(node,mobile);
  host.append(el('h2',{},node.name),el('p',{},node.id+' · '+TYPES[node.type]+' · '+(mobile?'仅手机覆盖':'桌面基础布局')),
    el('div',{class:'inspector-actions toolbar-group'},button('新增',addDialog),button('复制',()=>{const before=new Set(history.current.nodes.map(node=>node.id));mutate(current=>duplicateNode(current,node.id));const added=history.current.nodes.find(node=>!before.has(node.id));if(added)select(added.id);},{disabled:FIXED.has(node.id)}),button('删除',confirmDelete,{disabled:FIXED.has(node.id)})),
    field('控件名称',el('input',{value:node.name,maxlength:80,onchange:event=>mutate(current=>patchNode(current,node.id,{name:event.target.value}))})));
  if(['text','icon'].includes(node.type))host.append(field(node.type==='icon'?'图标字符':'显示文字',el('textarea',{value:props.text??'',rows:3,onchange:event=>patch({text:event.target.value})})));
  if(['input','textarea'].includes(node.type))host.append(field('占位文字',el('textarea',{value:props.text??'',rows:2,onchange:event=>patch({text:event.target.value})})),field('输入初始值',el('textarea',{value:props.value??'',maxlength:20000,rows:4,onchange:event=>{draftValues.delete(node.id);patch({value:event.target.value});}})));
  if(node.type==='image')host.append(selectProperty('srcRole','内嵌图片',{window:'窗边样例',landscape:'风景占位图',portrait:'肖像占位图',placeholder:'占位图'},props.srcRole||'placeholder'),selectProperty('imageFit','图片适配',{contain:'完整显示',cover:'裁剪填满'},props.imageFit||'contain'));
  host.append(field('隐藏控件',el('input',{type:'checkbox',checked:props.hidden,disabled:FIXED.has(node.id),onchange:event=>patch({hidden:event.target.checked})})));
  const sizes=el('div',{class:'property-grid'});
  for(const key of ['width','height']){
    const value=props[key],label=key==='width'?'宽度':'高度',mode=el('select',{'aria-label':label+'模式',onchange:event=>patch({[key]:event.target.value==='fixed'?200:event.target.value})},option('auto','按内容'),option('fill','占满剩余'),option('fixed','固定像素'));
    mode.value=typeof value==='number'?'fixed':value;sizes.append(field(label,mode));if(typeof value==='number')sizes.append(numeric(key,label+'像素',value));
  }
  for(const [key,label,max] of [['gap','子项间距',128],['padding','统一内边距',160],['margin','统一外边距',160]])sizes.append(numeric(key,label,props[key]??0,{max}));
  host.append(sizes,inheritanceNumber('fontSize','字号',props.fontSize,8,96));
  for(const [key,label] of [['color','文字颜色'],['background','背景颜色'],['borderColor','边框颜色']])host.append(field(label,el('input',{value:props[key]??'inherit',placeholder:'inherit / #333333 / transparent',onchange:event=>{const value=event.target.value.trim();patch({[key]:!value||value==='inherit'?undefined:value});}})));
  host.append(el('div',{class:'property-grid'},numeric('borderWidth','边框宽度',props.borderWidth??0,{max:12}),numeric('borderRadius','圆角',props.borderRadius??0,{max:64})),
    field('字重',el('select',{value:props.fontWeight??'inherit',onchange:event=>patch({fontWeight:event.target.value==='inherit'?'inherit':Number(event.target.value)})},...['inherit',400,500,600,700].map(value=>option(value,value==='inherit'?'继承父级':String(value))))),
    inheritanceNumber('lineHeight','行高',props.lineHeight,1,3),
    selectProperty('textAlign','文字对齐',{inherit:'继承父级',left:'左对齐',center:'居中',right:'右对齐'},props.textAlign),
    selectProperty('fontStyle','字体样式',{inherit:'继承父级',normal:'常规',italic:'斜体'},props.fontStyle),
    selectProperty('overflow','滚动与溢出',{visible:'自然溢出',auto:'超出时滚动',hidden:'裁剪超出内容'},props.overflow));
  if(['container','button'].includes(node.type))host.append(
    selectProperty('display','布局方式',{flex:'弹性布局',grid:'网格布局'},props.display||'flex'),
    numeric('columns','网格列数',props.columns??1,{min:1,max:6}),
    field('允许折行',el('input',{type:'checkbox',checked:!!props.wrap,onchange:event=>patch({wrap:event.target.checked})})),
    selectProperty('direction','排列方向',{row:'横向排列',column:'纵向排列'},props.direction),
    selectProperty('align','交叉轴对齐',{stretch:'拉伸',start:'起始',center:'居中',end:'末端'},props.align));
  const advanced=el('details',{class:'property-advanced'},el('summary',{},'高级：四边内外间距'));
  for(const group of ['padding','margin'])for(const [side,label] of [['Top','上'],['Right','右'],['Bottom','下'],['Left','左']]){
    const key=group+side,rawProps={...node.props,...(mobile?node.mobile:{})},input=el('input',{type:'number',min:0,max:160,value:rawProps[key]??'',placeholder:'跟随统一值',onchange:event=>patch({[key]:event.target.value===''?undefined:Number(event.target.value)})});
    advanced.append(field((group==='padding'?'内':'外')+'边距'+label,input));
  }
  host.append(advanced);
  const parent=el('select',{disabled:FIXED.has(node.id),onchange:event=>mutate(current=>moveNode(current,node.id,event.target.value,childrenOf(current,event.target.value).filter(child=>child.id!==node.id).length))});
  for(const candidate of current.nodes)if(canParent(candidate,node)){
    try{moveNode(current,node.id,candidate.id,childrenOf(current,candidate.id).filter(child=>child.id!==node.id).length);parent.append(option(candidate.id,candidate.name+' · '+candidate.id));}catch{}
  }
  parent.value=node.parentId;host.append(field('所在容器',parent));
  const siblings=childrenOf(current,node.parentId),index=siblings.findIndex(sibling=>sibling.id===node.id);
  host.append(el('div',{class:'toolbar-group'},button('↑ 上移',()=>mutate(current=>moveNode(current,node.id,node.parentId,index-1)),{disabled:FIXED.has(node.id)||index===0}),button('↓ 下移',()=>mutate(current=>moveNode(current,node.id,node.parentId,index+1)),{disabled:FIXED.has(node.id)||index===siblings.length-1})),
    field('交互动作（只读）',el('input',{value:props.action||'无',readonly:'',title:'仅支持预定义的安全动作，不执行代码'})),
    field('给实现者的备注',el('textarea',{value:props.note||'',maxlength:2000,placeholder:'例如：这里需要批量操作。',onchange:event=>patch({note:event.target.value})})));
  if(mobile)host.append(button('清除此控件的手机覆盖',()=>mutate(current=>patchNode(current,node.id,Object.fromEntries(Object.keys(node.mobile||{}).map(key=>[key,undefined])),{mobile:true}))));
  host.append(el('p',{class:'help-note'},'手机只覆盖外观；位置与顺序在各尺寸共用。按钮只能容纳文字和图标，所有产品元素都能独立选中。'));
}

function action(token,node){
  if(!ACTION.test(token))return;
  if(token==='show-library')return scene('library');if(token==='show-topics'||token==='toggle-chat')return scene('topics');
  if(token==='open-read'||/^open-note-/.test(token)||/^open-source-/.test(token))return scene('read');
  if(token==='open-edit'||token==='new-note')return scene('edit');
  if(token==='open-settings')return help();
  if(token==='send-chat'){
    const input=$('canvas').querySelector('[data-role="chat-input"] .atomic-field');
    return toast(input?.value.trim()?'离线发送演示：已读取输入，不调用模型，也不生成未注册消息。':'请先在会话输入框写点内容');
  }
  if(token==='save-demo')return toast('样例保存：不会写入真实资料库');
  if(token.startsWith('outline-section-')){
    const headings=[...$('canvas').querySelectorAll('[data-role="document-heading"]')];headings[Number(token.at(-1))]?.scrollIntoView({block:'nearest'});return;
  }
  if(token.startsWith('remove-source-'))return toast('移除来源演示：如需删除展示控件，请在调整模式选择对应来源并删除');
  if(token==='add-source')return toast('添加来源演示：可在调整模式新增原子控件，所有新增内容都进入图层树');
  if(token==='new-question')return toast('新问题演示：可在调整模式复制问题控件并编辑文字');
  if(token==='toggle-view')return toast('请在调整模式更改材料容器的排列、宽度与折行');
  if(token.startsWith('select-')){
    for(const item of $('canvas').querySelectorAll('[data-demo-selected]'))item.removeAttribute('data-demo-selected');
    node?.setAttribute('data-demo-selected','true');return toast('已选择：'+(findNode(history.current,node?.dataset.id)?.name||'样例'));
  }
  if(token.startsWith('copy-chat-'))return toast('复制消息：离线演示');
  if(token.startsWith('quote-chat-'))return toast('引用消息：离线演示');
  if(token==='attach-chat')return toast('附件：离线样例，不访问真实文件');
  toast('原子控件交互演示');
}
function syncChrome(){
  $('designer').classList.toggle('preview-mode',ui.mode==='preview');$('designer').classList.toggle('design-mode',ui.mode==='design');
  $('designer').classList.toggle('tree-open',treeVisible);$('designer').classList.toggle('inspector-open',inspectorVisible);
  $('tree-panel').hidden=!treeVisible||ui.mode==='preview';$('inspector-panel').hidden=!inspectorVisible||ui.mode==='preview';
  document.body.classList.toggle('dark-theme',ui.dark);$('mode-button').textContent=ui.mode==='design'?'▶ 体验模式':'✎ 调整模式';
  $('scene-select').value=ui.scene;$('device-select').value=ui.device;$('zoom-select').value=String(ui.zoom);
  $('undo-button').disabled=!history.canUndo;$('redo-button').disabled=!history.canRedo;
  $('mode-hint').textContent=ui.mode==='design'?'每个文字、图标与控件均可选中；拖手柄移动，属性面板编辑。':'本地交互演示 · 不连接资料库或模型';
}
function render(){ensureSelection();syncChrome();renderTree();renderInspector();renderCanvas();}
function historyAction(redo=false){redo?history.redo():history.undo();ensureSelection();persist();render();}
function init(){
  const root=el('div',{id:'designer',class:'designer atomic-designer'},
    el('header',{class:'designer-toolbar'},
      el('div',{class:'brand-title'},'▧ 知识库原子布局',el('small',{},'离线设计器 v2')),
      el('div',{class:'toolbar-group'},
        button('图层',()=>{treeVisible=!treeVisible;syncChrome();fit();}),button('属性',()=>{inspectorVisible=!inspectorVisible;syncChrome();fit();}),
        button('▶ 体验模式',()=>{ui.mode=ui.mode==='design'?'preview':'design';persist();render();},{id:'mode-button'})),
      el('div',{class:'toolbar-group'},button('撤销',()=>historyAction(),{id:'undo-button'}),button('重做',()=>historyAction(true),{id:'redo-button'}),button('新增控件',addDialog),button('重置场景',()=>confirmReset()),button('重置全部',()=>confirmReset(true))),
      el('div',{class:'toolbar-group'},button('导入布局',()=>$('import-file').click()),button('导出 JSON',()=>download('我的知识库原子布局.json',JSON.stringify(envelope(),null,2),'application/json;charset=utf-8')),button('保存 HTML',exportHTML)),
      el('div',{class:'toolbar-group'},button('明暗',()=>{ui.dark=!ui.dark;persist();syncChrome();}),button('使用说明',help),el('span',{id:'save-status',class:'save-status'},'布局仅保存在此浏览器'))),
    el('div',{class:'designer-body'},
      el('aside',{id:'tree-panel',class:'tree-panel'},
        el('header',{},el('strong',{},'原子控件图层'),button('×',()=>{treeVisible=false;syncChrome();fit();},{'aria-label':'关闭图层'})),
        el('input',{class:'tree-search',type:'search',placeholder:'搜索名称或 ID…','aria-label':'搜索图层',oninput:event=>{treeQuery=event.target.value;renderTree();}}),
        el('div',{class:'tree-actions toolbar-group'},button('全部展开',()=>{collapsed.clear();renderTree();}),button('全部折叠',()=>{for(const node of history.current.nodes)if(!FIXED.has(node.id))collapsed.add(node.id);renderTree();})),
        el('div',{id:'node-tree',class:'node-tree'})),
      el('main',{class:'stage-panel'},
        el('div',{class:'stage-tools'},el('span',{},'场景'),
          el('select',{id:'scene-select','aria-label':'原型场景',onchange:event=>scene(event.target.value)},...Object.entries(SCENES).map(([id,name])=>option(id,name))),
          el('span',{},'画布'),el('select',{id:'device-select','aria-label':'画布尺寸',onchange:event=>{ui.device=event.target.value;persist();render();}},option('desktop','桌面 · 1180'),option('narrow','窄窗口 · 860'),option('mobile','手机 · 390')),
          el('select',{id:'zoom-select','aria-label':'画布缩放',onchange:event=>{ui.zoom=event.target.value;persist();fit();}},option('fit','适应可用区域'),option('100','100%'),option('75','75%'),option('50','50%')),el('span',{id:'zoom-readout'}),el('span',{id:'mode-hint'})),
        el('div',{id:'stage-scroll',class:'stage-scroll'},el('div',{id:'viewport',class:'viewport'},el('div',{id:'canvas',class:'canvas'})))),
      el('aside',{id:'inspector-panel',class:'inspector-panel'},el('header',{},el('strong',{},'控件属性'),button('×',()=>{inspectorVisible=false;syncChrome();fit();},{'aria-label':'关闭属性'})),el('div',{id:'inspector',class:'inspector'}))),
    el('input',{id:'import-file',type:'file',accept:'.json,application/json',hidden:true,onchange:event=>importFile(event.target.files?.[0])}),el('div',{id:'dialogs'}),el('div',{id:'toast',class:'toast',role:'status',hidden:true}));
  $('app').replaceChildren(root);
  $('canvas').addEventListener('click',event=>{
    const target=event.target.closest('.layout-node');if(!target)return;
    if(ui.mode==='design'){event.preventDefault();event.stopPropagation();select(target.dataset.id);return;}
    for(let node=target;node&&$('canvas').contains(node);node=node.parentElement?.closest('.layout-node')){
      const record=findNode(history.current,node.dataset.id),token=record&&effectiveProps(record,ui.device==='mobile').action;
      if(token&&ACTION.test(token)){event.preventDefault();action(token,node);break;}
    }
  },true);
  $('canvas').addEventListener('dragover',event=>{if(ui.mode!=='design')return;const spec=dropSpec(event);for(const node of $('canvas').querySelectorAll('.drop-target'))node.classList.remove('drop-target');if(spec){event.preventDefault();spec.target.classList.add('drop-target');event.dataTransfer.dropEffect='move';}});
  $('canvas').addEventListener('drop',event=>{if(ui.mode!=='design')return;const spec=dropSpec(event);event.preventDefault();if(spec)mutate(current=>moveNode(current,dragging,spec.parentId,spec.index));else toast('此位置不可放置，请选择同场景内的兼容父节点');clearDrag();});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){closeDialog();clearDrag();}
    if(event.target.closest('input,textarea,select,[contenteditable]'))return;
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='z'){event.preventDefault();historyAction(event.shiftKey);}
    else if(event.ctrlKey&&!event.altKey&&event.key.toLowerCase()==='y'){event.preventDefault();historyAction(true);}
  });
  new ResizeObserver(fit).observe($('stage-scroll'));render();persist();
}
init();
