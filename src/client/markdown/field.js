import {createDocumentOutline} from './outline.js';
import {createAsyncMarkdown} from './virtual-preview.js';
import {createSourceEditor} from '../editor/index.js';
import {runEditorCommand} from '../editor/commands.js';

export function createMarkdownField({R,h,t,AutoTextarea,fieldScrollRoot,ctx}){
 const {MarkdownPreview,renderService}=createAsyncMarkdown({R,h,t,fieldScrollRoot,ctx});
 const {SourceEditor}=createSourceEditor({R,h,t});
 const DocumentOutline=createDocumentOutline({R,h,t,renderService});
 function MarkdownField({value,onChange,busy,fontSize,label,textareaProps={},startEditing=false,maxLength=20000,autoGrow=true,headingPrefix,fieldRef}){
  const [mode,setMode]=R.useState(startEditing||!value?'edit':'preview');
  const wrapper=R.useRef(null),input=R.useRef(null),preview=R.useRef(null),frames=R.useRef([]);
  R.useEffect(()=>()=>{frames.current.forEach(cancelAnimationFrame);if(fieldRef)fieldRef.current=null;},[]);
  R.useEffect(()=>{if(!value&&mode==='preview')setMode('edit');},[value]);
  function choose(next,focus=true){
   if(busy||next===mode)return;
   const node=wrapper.current,root=fieldScrollRoot(node),top=root?.scrollTop;
   setMode(next);
   frames.current.forEach(cancelAnimationFrame);
   frames.current=[requestAnimationFrame(()=>{frames.current.push(requestAnimationFrame(()=>{
    if(root&&next!=='preview')root.scrollTop=top;
    if(focus&&next!=='preview'&&input.current){input.current.view?.requestMeasure();input.current.setAttribute?.('data-em-preserve-scroll','true');input.current.focus({preventScroll:true});}
   }));})];
  }
  function applyRawChange(change){
   if(busy)return false;
   const editor=input.current;
   if(editor?.applyRawChange){if(editor.value!==value)return false;return editor.applyRawChange(change);}
   onChange(value.slice(0,change.from)+change.insert+value.slice(change.to));return true;
  }
  R.useLayoutEffect(()=>{
   if(!fieldRef)return;
   fieldRef.current={
    get source(){return input.current;},get mode(){return mode;},
    focus:()=>input.current?.focus({preventScroll:true}),
    chooseMode:choose,toggleMode:()=>choose(mode==='preview'?'edit':'preview'),applyRawChange,
    runCommand:id=>{const run=()=>input.current?.runCommand?.(id)??(input.current?.view?runEditorCommand(input.current.view,id):false);if(mode!=='preview')return run();choose('edit',false);frames.current.push(requestAnimationFrame(()=>{frames.current.push(requestAnimationFrame(run));}));return true;},
    async revealHeading(heading){
     if(mode!=='edit'&&await preview.current?.revealHeading(heading.index))return true;
     if(mode==='preview')return false;
     input.current?.revealOffset?.(heading.offset);return !!input.current;
    },
   };
  });
  const commands=[['bold','wbBold','B'],['italic','wbItalic','I'],['link','wbLink','↗'],['code','wbCode','</>'],['heading2','wbHeading','H2'],['bulletList','wbBullet','≡'],['taskList','wbTask','☑'],['quote','wbQuote','❝']];
  return h('div',{ref:wrapper,className:'em-md-field nb-writing-field is-'+mode},
   h('div',{className:'em-md-toolbar'},
    h('span',{className:'em-md-label'},'Markdown'),
    h('div',{className:'nb-format-actions','aria-label':t('wbFormatting')},...commands.map(([id,key,text])=>h('button',{key:id,type:'button',className:'em-md-toggle',disabled:busy||mode==='preview',title:t(key),'aria-label':t(key),onMouseDown:e=>e.preventDefault(),onClick:()=>input.current?.runCommand?.(id)},text))),
    h('div',{className:'em-md-modes',role:'group','aria-label':label+' · '+t('mdMode')},...['edit','preview','split'].map(key=>h('button',{key,type:'button',className:'em-md-toggle','aria-pressed':mode===key,disabled:busy,onClick:()=>choose(key)},t(key==='edit'?'mdEdit':key==='preview'?'mdPreview':'wbSplit'))))),
   h('div',{className:'nb-writing-panes'},
    h('div',{className:'em-md-source',hidden:mode==='preview'},autoGrow?
     h(AutoTextarea,{...textareaProps,inputRef:input,fontSize,value,maxLength,disabled:busy,'aria-label':label,required:!!textareaProps.required&&mode!=='preview',onChange:e=>onChange(e.target.value)}):
     h(SourceEditor,{value,onChange,busy,fontSize,label,inputRef:input,maxLength})),
    mode!=='edit'&&h('div',{className:'nb-preview-pane'},h(MarkdownPreview,{key:mode,value,busy,onChange:(next,change)=>{if(change)return applyRawChange(change);onChange(next);return true;},headingPrefix,previewRef:preview,label:label+' · '+t('mdPreview')}))));
 }
 return {MarkdownField,MarkdownPreview,DocumentOutline,renderService};
}
