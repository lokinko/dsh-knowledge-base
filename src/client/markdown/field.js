import {createDocumentOutline} from './outline.js';
import {createAsyncMarkdown} from './virtual-preview.js';
import {createSourceEditor} from '../editor/index.js';

export function createMarkdownField({R,h,t,fieldScrollRoot,ctx}){
 const {MarkdownPreview,renderService}=createAsyncMarkdown({R,h,t,fieldScrollRoot,ctx});
 const {SourceEditor}=createSourceEditor({R,h,t});
 const DocumentOutline=createDocumentOutline({R,h,t,renderService});
 function MarkdownField({value,onChange,busy,fontSize,label,maxLength=20000,fieldRef}){
  const input=R.useRef(null);
  R.useLayoutEffect(()=>{
   if(!fieldRef)return;
   fieldRef.current={
    get source(){return input.current;},
    focus:()=>input.current?.focus({preventScroll:true}),
    // expected is the caller's current source; the value prop may trail a
    // deferred render by a keystroke and is only a fallback.
    applyRawChange:(change,expected=value)=>!busy&&input.current?.value===expected&&input.current.applyRawChange(change),
    runCommand:id=>input.current?.runCommand(id),
    async revealHeading(heading){input.current?.revealOffset(heading.offset);return !!input.current;},
   };
   return()=>{fieldRef.current=null;};
  });
  const commands=[['bold','wbBold','B'],['italic','wbItalic','I'],['link','wbLink','↗'],['code','wbCode','</>'],['math','wbMath','∑'],['heading2','wbHeading','H2'],['bulletList','wbBullet','≡'],['taskList','wbTask','☑'],['quote','wbQuote','❝']];
  return h('div',{className:'em-md-field nb-writing-field is-live'},
   h('div',{className:'em-md-toolbar'},
    h('div',{className:'nb-format-actions','aria-label':t('wbFormatting')},...commands.map(([id,key,text])=>h('button',{key:id,type:'button',className:'em-md-toggle',disabled:busy,title:t(key),'aria-label':t(key),onMouseDown:e=>e.preventDefault(),onClick:()=>input.current?.runCommand(id)},text)))),
   h('div',{className:'nb-writing-panes'},h('div',{className:'em-md-source'},h(SourceEditor,{value,onChange,busy,fontSize,label,inputRef:input,maxLength}))));
 }
 return {MarkdownField,MarkdownPreview,DocumentOutline,renderService};
}
