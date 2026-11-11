import {validateLayout as validateV1} from './model.js';

// Fictional local samples only. Migration never evaluates HTML, scripts, URLs,
// action strings or user notes. All labels and icons become editable leaves.
export const SAMPLE_NOTES = [
  {title:'从收集材料，到形成自己的理解',category:'心得',date:'今天',intro:'保存内容时，也记下它为什么吸引我，以及我还没有想明白的地方。',tags:['思考','整理'],words:'1350 字'},
  {title:'论文阅读：怎样提出一个好问题',category:'论文',date:'昨天',intro:'一篇论文可以参与多个问题。摘录、反驳和自己的判断，值得分别留下。',tags:['阅读','研究'],words:'2480 字'},
  {title:'图像观察：窗边的光与结构',category:'图片',date:'周二',intro:'同一张图，也可以成为设计、摄影与观察日常的入口。',tags:['观察','灵感'],words:'620 字'},
  {title:'教程实践：构建可持续的工作流',category:'教程',date:'周一',intro:'把步骤和实践后的心得分开，保留那些只有亲手尝试才知道的细节。',tags:['实践','工作流'],words:'1860 字'},
];
export const SAMPLE_QUESTIONS = ['AI 应该怎样参与我的知识整理？','怎样把零散的好奇心变成研究方向？','阅读之后，我真正留下了什么？'];
export const SAMPLE_SOURCES = [
  {kind:'笔记片段',title:'论文：提出好问题的方法',excerpt:'材料可以成为一个入口，而不是最终的结论。',author:'我',time:'11 月 11 日',location:'论文阅读 · 第二节'},
  {kind:'讨论',title:'讨论：AI 应当参与到哪一步',excerpt:'先展示相关回顾，再给出你的思考；不够相关时，不需要强行回顾。',author:'用户',time:'11 月 10 日',location:'会话 A · 消息 12'},
  {kind:'心得',title:'心得：保留自己的判断',excerpt:'保留出处、疑问与自己的观察，让以后还有机会重新理解。',author:'我',time:'11 月 9 日',location:'自己的心得 · 第一段'},
];
export const SAMPLE_EDITOR_TEXT = '# 从收集材料，到形成自己的理解\n\n我想保存的不只是材料，还有当时的疑问、判断和变化。\n\n## 一个值得继续的问题\n\n怎样让下一次讨论，接上以前的思考？';
const BASE = {hidden:false,width:'auto',height:'auto',direction:'column',wrap:false,gap:8,padding:0,margin:0,fontSize:'inherit',align:'stretch',overflow:'visible',note:''};
const SURFACE={background:'#fcfbf9',color:'#333632',borderColor:'#e4e1da',borderWidth:1,borderRadius:8};
const BUTTON_SURFACE={...SURFACE,borderRadius:6};
function fillDefaults(props,defaults) {
  const added={};
  for(const [key,value] of Object.entries(defaults)) if(!Object.hasOwn(props,key)) { props[key]=value;added[key]=value; }
  return added;
}
// Older v1 validation predates editable surface colors. Preserve explicitly
// supplied compatible surface values rather than replacing them with defaults.
function retainSurface(input,output) {
  for(const key of Object.keys(SURFACE)) if(input&&Object.hasOwn(input,key)) {
    const value=input[key];
    const valid=key==='background'||key==='borderColor'||key==='color'
      ? typeof value==='string'&&(value==='transparent'||/^#[0-9a-f]{6}$/i.test(value))
      : typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=(key==='borderWidth'?12:64);
    if(!valid) throw new Error('无效的旧布局表面样式：'+key);
    output[key]=value;
  }
}
const SIMPLE_ACTIONS = {
  'nav-library':['show-library','▤'], 'nav-topics':['show-topics','?'], 'action-settings':['open-settings','⚙'],
  'new-note':['open-edit','＋'], 'library-view':['toggle-view','▦'], 'read-edit':['open-edit','✎'],
  'read-source':['toggle-chat','◇'], 'edit-preview':['open-read','▤'], 'edit-save':['save-demo','✓'],
  'edit-source':['toggle-chat','◇'], 'topic-new':['new-question','＋'], 'topic-new-note':['open-edit','✎'],
};

function expandContent(root, add) {
  const group = (slug,name,parent=root,props={}) => add(slug,'container',name,parent,{...props});
  const text = (slug,name,value,parent=root,props={}) => add(slug,'text',name,parent,{text:value,...props});
  const icon = (slug,name,value,parent=root) => add(slug,'icon',name,parent,{text:value,width:20,height:20,align:'center'});
  const button = (slug,name,label,symbol,action,parent=root) => {
    const item=add(slug,'button',name,parent,{...BUTTON_SURFACE,direction:'row',align:'center',gap:6,padding:6,action});
    icon(slug+'-icon',name+'图标',symbol,item);
    text(slug+'-label',name+'文字',label,item,{role:'button-label'});
    return item;
  };
  const role=root.props.role;
  if(role==='folders') {
    [['全部材料','24'],['论文与阅读','8'],['图片与灵感','6'],['教程与实践','7'],['自己的心得','3']].forEach(([name,count],i)=>{
      const row=group('folder-'+i,'分类行：'+name,root,{direction:'row',gap:8,align:'center',padding:8,action:'select-folder-'+i});
      icon('folder-'+i+'-icon','文件夹图标','▱',row);
      text('folder-'+i+'-name','分类名称',name,row,{width:'fill'});
      text('folder-'+i+'-count','分类数量',count,row,{fontSize:12});
    });
  } else if(role==='note-cards'||role==='note-list') {
    SAMPLE_NOTES.forEach((note,i)=>{
      const card=group('note-'+i,'材料卡片 '+(i+1),root,{...SURFACE,width:'fill',gap:10,padding:17,action:'open-note-'+i});
      card.mobile={padding:15};
      const category=group('note-'+i+'-category','分类信息',card,{direction:'row',gap:6,align:'center'});
      icon('note-'+i+'-icon','材料图标',i===2?'▧':'▤',category);
      text('note-'+i+'-kind','材料分类',note.category,category,{fontSize:12});
      text('note-'+i+'-title','材料标题',note.title,card,{fontSize:18,role:'note-title'});
      text('note-'+i+'-excerpt','材料摘要',note.intro,card,{role:'note-excerpt'});
      const tags=group('note-'+i+'-tags','标签列表',card,{direction:'row',wrap:true,gap:6});
      note.tags.forEach((tag,j)=>text('note-'+i+'-tag-'+j,'标签 '+(j+1),tag,tags,{fontSize:12}));
      const meta=group('note-'+i+'-meta','更新时间与字数',card,{direction:'row',wrap:true,gap:6,align:'center'});
      icon('note-'+i+'-time-icon','更新时间图标','◷',meta);
      text('note-'+i+'-updated','更新时间',note.date,meta,{fontSize:12});
      icon('note-'+i+'-words-icon','字数图标','≋',meta);
      text('note-'+i+'-words','字数',note.words,meta,{fontSize:12});
      button('note-'+i+'-open','打开材料','打开','↗','open-note-'+i,card);
    });
  } else if(role==='document') {
    const category=group('document-meta','正文元信息',root,{direction:'row',gap:6});
    icon('document-kind-icon','正文类型图标','▤',category);
    text('document-category','正文分类',SAMPLE_NOTES[0].category,category,{fontSize:12});
    text('document-sample','样例标识','本地样例',category,{fontSize:12});
    text('document-intro','正文第一段',SAMPLE_NOTES[0].intro,root,{role:'document-paragraph'});
    text('document-heading-0','正文标题一','先保留问题，再形成判断',root,{fontSize:22,role:'document-heading'});
    text('document-paragraph-0','正文第二段','一篇论文、一张图片或者一段讨论，可以同时关联不同的问题。值得留下的，不仅是原文，还有自己为什么关注它。',root,{role:'document-paragraph'});
    text('document-quote','正文引用','我希望下一次聊到一个话题时，能够接上过去的思考。',root,{padding:12,role:'document-quote'});
    text('document-heading-1','正文标题二','允许尚未成形的内容存在',root,{fontSize:22,role:'document-heading'});
    text('document-paragraph-1','正文第三段','这是一份用于讨论布局的虚构内容。你可以调整正文宽度，观察阅读空间是否舒适。',root,{role:'document-paragraph'});
    add('document-image','image','窗边图片样例',root,{srcRole:'window',width:'fill',height:220,role:'document-image'});
    text('document-caption','图片说明','窗边的光与几何结构 · 静态本地图片样例',root,{fontSize:12,role:'image-caption'});
    text('document-paragraph-2','正文第四段','正式产品里的材料与原文不受这份原型影响。',root,{role:'document-paragraph'});
  } else if(role==='editor') {
    text('editor-label','正文编辑标签','正文草稿',root,{role:'editor-label'});
    add('editor-body','textarea','样例正文输入',root,{...BUTTON_SURFACE,text:'在这里编辑样例正文…',value:SAMPLE_EDITOR_TEXT,width:'fill',height:'fill',padding:18,lineHeight:1.9,role:'editor-body'});
    const status=group('editor-status','编辑状态',root,{direction:'row',gap:6,align:'center'});
    icon('editor-status-icon','草稿状态图标','◦',status);
    text('editor-status-label','草稿状态文字','演示草稿 · 仅当前页面内存',status,{fontSize:12});
  } else if(role==='outline') {
    text('outline-heading','目录标题','本文目录');
    ['先保留问题，再形成判断','允许尚未成形的内容存在'].forEach((title,i)=>button('outline-'+i,'目录项 '+(i+1),title,'§','outline-section-'+i));
  } else if(role==='questions') {
    SAMPLE_QUESTIONS.forEach((question,i)=>{
      const row=group('question-'+i,'问题卡片 '+(i+1),root,{...SURFACE,borderRadius:6,gap:7,padding:10,action:'select-question-'+i});
      text('question-'+i+'-title','问题标题',question,row,{fontSize:16});
      const meta=group('question-'+i+'-meta','问题元信息',row,{direction:'row',wrap:true,gap:6,align:'center'});
      icon('question-'+i+'-count-icon','来源数量图标','▱',meta);
      text('question-'+i+'-count','来源数量',String(i?2:4)+' 个来源',meta,{fontSize:12});
      icon('question-'+i+'-time-icon','问题更新时间图标','◷',meta);
      text('question-'+i+'-updated','问题更新时间',i?'昨天':'今天',meta,{fontSize:12});
      button('question-'+i+'-continue','继续讨论','继续讨论','↗','select-question-'+i,row);
    });
  } else if(role==='sources') {
    const header=group('sources-header','来源列表标题栏',root,{direction:'row',gap:8,align:'center'});
    icon('sources-icon','来源列表图标','▱',header);
    text('sources-heading','来源列表标题','已选择的来源',header,{width:'fill'});
    text('sources-total','来源总数','3 个来源',header,{fontSize:12,role:'source-count'});
    SAMPLE_SOURCES.forEach((source,i)=>{
      const row=group('source-'+i,'来源条目 '+(i+1),root,{...SURFACE,borderRadius:6,gap:6,padding:13,action:'select-source-'+i});
      const kind=group('source-'+i+'-kind-row','来源种类',row,{direction:'row',gap:6,align:'center'});
      icon('source-'+i+'-kind-icon','来源类型图标',i===1?'◇':'▤',kind);
      text('source-'+i+'-kind','来源类型',source.kind,kind,{fontSize:12});
      text('source-'+i+'-title','来源标题',source.title,row,{role:'source-title'});
      text('source-'+i+'-excerpt','来源摘要',source.excerpt,row,{fontSize:13,role:'source-excerpt'});
      const time=group('source-'+i+'-time-row','来源时间信息',row,{direction:'row',gap:6,align:'center'});
      icon('source-'+i+'-time-icon','来源时间图标','◷',time);
      text('source-'+i+'-updated','来源时间',source.time,time,{fontSize:12});
      const actions=group('source-'+i+'-actions','来源操作',row,{direction:'row',wrap:true,gap:8});
      button('source-'+i+'-open','打开来源','打开','↗','open-source-'+i,actions);
      button('source-'+i+'-remove','移除来源','移除','−','remove-source-'+i,actions);
    });
    button('source-add','查找并选择来源','查找并选择来源','＋','add-source');
  } else if(role==='source-reader') {
    const header=group('reader-header','原文类型栏',root,{direction:'row',gap:6,align:'center'});
    icon('reader-kind-icon','原文类型图标','▤',header);
    text('reader-kind','原文类型','笔记 · 原文片段',header,{fontSize:12,role:'reader-kind'});
    text('reader-title','原文标题',SAMPLE_SOURCES[0].title,root,{fontSize:18,role:'reader-title'});
    const meta=group('reader-meta','原文作者与时间',root,{direction:'row',wrap:true,gap:8});
    text('reader-author','原文作者',SAMPLE_SOURCES[0].author,meta,{fontSize:12,role:'reader-author'});
    text('reader-time','原文时间',SAMPLE_SOURCES[0].time,meta,{fontSize:12,role:'reader-time'});
    text('reader-quote','原文引用','材料可以成为一个入口，而不是最终的结论。保留出处、疑问与自己的观察，让以后还有机会重新理解。',root,{padding:12,role:'reader-quote'});
    text('reader-location','原文位置',SAMPLE_SOURCES[0].location,root,{fontSize:12,role:'reader-location'});
    button('reader-open','打开原文','打开原文','↗','open-read');
  } else if(role==='chat') {
    const header=group('chat-header','会话标题栏',root,{direction:'row',gap:8,align:'center'});
    icon('chat-title-icon','会话标题图标','◇',header);
    text('chat-title','会话标题','围绕问题继续讨论',header,{fontSize:16,width:'fill'});
    text('chat-status','会话状态','离线演示',header,{fontSize:12});
    const history=group('chat-history','消息历史分组',root,{height:'fill',overflow:'auto',gap:14,role:'chat-history'});
    text('chat-disclaimer','会话演示标识','AI 会话交互样例 · 未连接模型',history,{fontSize:12});
    add('chat-history-separator','separator','消息分隔线',history,{});
    const messages=[
      ['我','10:24','我希望整理时机和观点合并由自己决定。','人'],
      ['助手','10:25','回顾：你之前倾向于保留待整理空间，最后亲手写成正式内容。\n\n我的思考：我们可以先对照材料之间的重复、补充和分歧，再决定哪些值得写下来。','◇'],
    ];
    messages.forEach(([author,time,body,avatar],i)=>{
      const message=group('chat-message-'+i,'消息 '+(i+1),history,{...SURFACE,background:i?'#fcfbf9':'#e6eadf',gap:6,padding:10,lineHeight:1.95,role:i?'assistant-message':'user-message'});
      icon('chat-message-'+i+'-avatar','消息头像',avatar,message);
      const meta=group('chat-message-'+i+'-meta','消息署名时间',message,{direction:'row',gap:8});
      text('chat-message-'+i+'-author','消息作者',author,meta,{fontSize:12});
      text('chat-message-'+i+'-time','消息时间',time,meta,{fontSize:12});
      // Message paragraphs remain meaningful atomic text, never individual glyphs.
      body.split('\n\n').forEach((paragraph,j)=>text('chat-message-'+i+'-body-'+j,'消息正文段 '+(j+1),paragraph,message,{role:'message-body'}));
      const actions=group('chat-message-'+i+'-actions','消息操作',message,{direction:'row',gap:8});
      button('chat-message-'+i+'-copy','复制消息','复制','▣','copy-chat-'+i,actions);
      button('chat-message-'+i+'-quote','引用消息','引用','❞','quote-chat-'+i,actions);
    });
    const compose=group('chat-compose','会话输入分组',root,{...SURFACE,padding:10,gap:8,role:'chat-compose'});
    text('chat-compose-label','会话输入标签','继续对话',compose,{fontSize:12});
    const inputRow=group('chat-compose-row','会话输入与操作横排',compose,{direction:'row',gap:7,align:'end'});
    inputRow.mobile={direction:'column',align:'stretch'};
    add('chat-input','textarea','模拟会话输入',inputRow,{text:'输入一句话，体验会话区的空间…',height:92,width:'fill',background:'transparent',borderWidth:0,role:'chat-input'});
    const actions=group('chat-compose-actions','附件与发送操作',inputRow,{direction:'row',wrap:true,gap:8});
    button('chat-attach','会话附件','添加附件','⌁','attach-chat',actions);
    button('chat-send','发送消息','发送','↑','send-chat',actions);
    text('chat-compose-status','输入状态说明','仅页面内存 · 不调用模型',compose,{fontSize:12});
  }
}

/** Deterministic conversion from the validated v1 data model. It never edits
 * input, does not depend on browser globals, and does not read or run HTML.
 */
export function migrateLayout(input) {
  const source=validateV1(input);
  source.nodes.forEach((node,index)=>{
    retainSurface(input.nodes[index].props,node.props);
    if(node.mobile) retainSurface(input.nodes[index].mobile,node.mobile);
  });
  const byId=new Map(source.nodes.map(node=>[node.id,node])), removed=new Map();
  for(const node of source.nodes) {
    if(node.props.hidden===true) { removed.set(node.id,'hidden'); continue; }
    let parent=byId.get(node.parentId);
    while(parent) { if(parent.props.hidden===true) { removed.set(node.id,'hidden-ancestor'); break; } parent=byId.get(parent.parentId); }
  }
  let changed=true;
  while(changed) {
    changed=false;
    for(const id of ['nav-actions','global-nav']) if(byId.has(id)&&!removed.has(id)&&
      !source.nodes.some(node=>node.parentId===id&&!removed.has(node.id))) {
      removed.set(id,'empty-legacy-container'); changed=true;
    }
  }
  const layout={version:2,nodes:[]}, reserved=new Set(source.nodes.map(node=>node.id));
  const report={removed:source.nodes.filter(node=>removed.has(node.id)).map(node=>({id:node.id,name:node.name,reason:removed.get(node.id)})),expanded:[],preservedIds:[],explicitConvertedStyles:[]};
  for(const original of source.nodes) {
    if(removed.has(original.id)) continue;
    const node=structuredClone(original);
    if(node.type==='content') node.type='container';
    if(original.type==='content'&&node.props.role==='note-cards') {
      // The v1 renderer's mock-cards stylesheet supplied a two-column grid.
      // Make that real layout explicit now that roles have no rendering magic.
      node.props.display='grid';node.props.columns=2;
      node.mobile={...(node.mobile||{}),columns:1};
      const converted={display:'grid',columns:2};
      if(node.props.overflow==='visible') { node.props.overflow='auto';converted.overflow='auto'; }
      report.explicitConvertedStyles.push({id:node.id,reason:'v1-mock-cards-grid',props:converted,mobile:{columns:1}});
    }
    if(original.type==='button'||(original.type==='content'&&node.props.role==='source-reader')) {
      const converted=fillDefaults(node.props,original.type==='button'?BUTTON_SURFACE:SURFACE);
      if(Object.keys(converted).length) report.explicitConvertedStyles.push({id:node.id,reason:'v1-neutral-surface',props:converted});
    }
    layout.nodes.push(node); report.preservedIds.push(node.id);
    const addedIds=[];
    const add=(slug,type,name,parent,props={})=>{
      const stem=node.id.slice(0,25)+'--'+slug.slice(0,32);
      let id=stem,index=1;
      while(reserved.has(id)) id=stem+'-'+index++;
      reserved.add(id);
      const child={id,type,name:name.slice(0,80),parentId:parent.id,scene:node.scene,props:{...BASE,...props}};
      layout.nodes.push(child);addedIds.push(id);return child;
    };
    if(original.type==='content') {
      expandContent(node,add);
      report.expanded.push({id:node.id,name:node.name,role:node.props.role,addedIds});
    } else if(original.type==='button') {
      if(node.props.direction==='column'&&node.props.gap===12&&node.props.padding===0) {
        const converted={direction:'row',gap:6,padding:6};
        if(node.props.align==='stretch') converted.align='center';
        Object.assign(node.props,converted);
        report.explicitConvertedStyles.push({id:node.id,reason:'v1-native-button-content-layout',props:converted});
      }
      const label=node.props.text??node.name;
      const mobileText=node.mobile?.text;
      delete node.props.text;
      if(node.mobile) delete node.mobile.text;
      const [action,symbol]=SIMPLE_ACTIONS[node.id]??['demo-action','•'];
      node.props.action=action;
      add('icon','icon',node.name+'图标',node,{text:symbol,width:20,height:20,align:'center'});
      const leaf=add('label','text',node.name+'文字',node,{text:label,role:'button-label'});
      if(mobileText!==undefined) leaf.mobile={text:mobileText};
      report.expanded.push({id:node.id,name:node.name,role:'button',addedIds});
    }
  }
  if(layout.nodes.length>2000) throw new Error('原子布局最多允许 2000 个节点');
  return {layout,report};
}
