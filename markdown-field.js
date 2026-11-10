function MarkdownPreview({value,busy,onChange,label}){
 const ref=R.useRef(null),frame=R.useRef(0);
 const html=R.useMemo(()=>renderMarkdown(value),[value]);
 R.useLayoutEffect(()=>{ref.current?.querySelectorAll('input.task-list-item-checkbox').forEach(input=>{input.disabled=busy;});},[html,busy]);
 R.useEffect(()=>()=>cancelAnimationFrame(frame.current),[]);
 function toggle(e){
  const input=e.target;if(busy||input.tagName!=='INPUT'||!input.classList.contains('task-list-item-checkbox'))return;
  const index=Number(input.getAttribute('data-md-task-index'));if(!Number.isSafeInteger(index)||index<0)return;
  const updated=setMarkdownTask(value,index,input.checked);if(updated===value)return;
  onChange(updated);
  cancelAnimationFrame(frame.current);frame.current=requestAnimationFrame(()=>ref.current?.querySelector('input[data-md-task-index="'+index+'"]')?.focus({preventScroll:true}));
 }
 return h('div',{ref,className:'em-markdown',role:'region','aria-label':label,onClick:toggle,dangerouslySetInnerHTML:{__html:html||'<p class="em-md-empty">'+t('mdEmpty')+'</p>'}});
}
function MarkdownField({value,onChange,busy,fontSize,label,textareaProps={},startEditing=false,maxLength=20000,autoGrow=true}){
 const [mode,setMode]=R.useState(startEditing||!value?'edit':'preview');
 const wrapper=R.useRef(null),input=R.useRef(null),frames=R.useRef([]);
 R.useEffect(()=>()=>frames.current.forEach(cancelAnimationFrame),[]);
 R.useEffect(()=>{if(!value&&mode==='preview')setMode('edit');},[value]);
 function choose(next){
  if(busy||next===mode)return;
  const node=wrapper.current,root=fieldScrollRoot(node);
  const top=root?.scrollTop;
  node.style.minHeight=node.getBoundingClientRect().height+'px';
  setMode(next);
  frames.current.forEach(cancelAnimationFrame);
  frames.current=[requestAnimationFrame(()=>{frames.current.push(requestAnimationFrame(()=>{node.style.minHeight='';if(root)root.scrollTop=top;if(next==='edit'&&input.current){input.current.setAttribute('data-em-preserve-scroll','true');input.current.focus({preventScroll:true});}}));})];
 }
 return h('div',{ref:wrapper,className:'em-md-field'},
  h('div',{className:'em-md-toolbar'},h('span',{className:'em-md-label'},'Markdown'),h('div',{className:'em-md-modes',role:'group','aria-label':label+' · '+t('mdMode')},...['edit','preview'].map(key=>h('button',{key,type:'button',className:'em-md-toggle','aria-pressed':mode===key,disabled:busy,onClick:()=>choose(key)},t(key==='edit'?'mdEdit':'mdPreview'))))),
  h('div',{className:'em-md-source',hidden:mode!=='edit'},autoGrow?h(AutoTextarea,{...textareaProps,inputRef:input,fontSize,value,maxLength,disabled:busy,'aria-label':label,required:!!textareaProps.required&&mode==='edit',onChange:e=>onChange(e.target.value)}):h('textarea',{...textareaProps,ref:input,value,maxLength,spellCheck:false,disabled:busy,'aria-label':label,required:!!textareaProps.required&&mode==='edit',onChange:e=>onChange(e.target.value)})),
  mode==='preview'&&h(MarkdownPreview,{value,busy,onChange,label:label+' · '+t('mdPreview')}));
}
