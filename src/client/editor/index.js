import {Annotation,Compartment,EditorState,Transaction} from '@codemirror/state';
import {EditorView,keymap} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {defaultHighlightStyle,syntaxHighlighting} from '@codemirror/language';
import {markdown,markdownKeymap} from '@codemirror/lang-markdown';
import {search,searchKeymap} from '@codemirror/search';
import {autocompletion,completionKeymap} from '@codemirror/autocomplete';
import {markdownBlockCompletions} from './completions.js';
import {createRawSourceExtension,applySourceRawChange} from './source-state.js';
import {RawSourceMap} from './raw-source.js';
import {commandHelp,markdownCommandKeymap,runEditorCommand} from './commands.js';

export {commandHelp,runEditorCommand} from './commands.js';
const externalValue=Annotation.define();
function assignRef(ref,value){if(typeof ref==='function')ref(value);else if(ref)ref.current=value;}
function appearance(fontSize){return EditorView.theme({
 '&':{height:'100%',fontSize:`${Number(fontSize)||15}px`,backgroundColor:'transparent',color:'inherit'},
 '.cm-scroller':{overflow:'auto',fontFamily:'inherit',lineHeight:'1.7'},
 '.cm-content':{minHeight:'100%',padding:'16px 20px'},
 '&.cm-focused':{outline:'none'}
});}

export function createSourceEditor({R,h,t}){
 function SourceEditor({value='',onChange,busy=false,fontSize=15,label,inputRef,maxLength}){
  const host=R.useRef(null),instance=R.useRef(null),props=R.useRef(null),lastEmitted=R.useRef(value);
  props.current={value,onChange,busy,fontSize,label:label||t('mdEdit'),inputRef,maxLength};
  R.useLayoutEffect(()=>{
   const editable=new Compartment(),attributes=new Compartment(),theme=new Compartment(),undoHistory=new Compartment();
   const raw=createRawSourceExtension(props.current.value);
   let disposed=false,compositionTimer=0;
   const state=EditorState.create({doc:raw.initial.normalized,extensions:[
    raw.extension,undoHistory.of(history()),
    editable.of([EditorState.readOnly.of(!!props.current.busy),EditorView.editable.of(!props.current.busy)]),
    attributes.of(EditorView.contentAttributes.of({'aria-label':props.current.label,spellcheck:'false',role:'textbox','aria-multiline':'true'})),
    theme.of(appearance(props.current.fontSize)),
    EditorView.lineWrapping,markdown({addKeymap:false}),syntaxHighlighting(defaultHighlightStyle),search({top:true}),
    autocompletion({override:[markdownBlockCompletions],defaultKeymap:false}),
    keymap.of([...completionKeymap,...markdownCommandKeymap,...markdownKeymap,indentWithTab,...historyKeymap,...searchKeymap,...defaultKeymap]),
    EditorState.transactionFilter.of(transaction=>{
     const limit=props.current.maxLength;
     return transaction.docChanged&&!transaction.annotation(externalValue)&&Number.isFinite(limit)&&transaction.newDoc.length>limit&&transaction.newDoc.length>=transaction.startState.doc.length?[]:transaction;
    }),
    EditorView.domEventHandlers({compositionend(){
     clearTimeout(compositionTimer);compositionTimer=setTimeout(()=>{if(!disposed)syncValue();},0);return false;
    }}),
    EditorView.updateListener.of(update=>{
     if(!update.docChanged)return;
     const source=raw.getMap(update.state).raw;lastEmitted.current=source;
     if(!update.transactions.some(transaction=>transaction.annotation(externalValue)))props.current.onChange?.(source);
    })
   ]});
   // The CM Text tree owns the normalized representation after initialization.
   raw.initial.normalized=null;
   const view=new EditorView({state,parent:host.current});
   const handle={
    view,dom:view.dom,
    get value(){return raw.getMap(view.state).raw;},
    focus(options){if(options?.preventScroll)view.contentDOM.focus(options);else view.focus();},
    setAttribute(name,value){view.contentDOM.setAttribute(name,value);},
    revealOffset(offset){
     const position=raw.getMap(view.state).rawToNormalized(offset);
     view.dispatch({selection:{anchor:position},effects:EditorView.scrollIntoView(position,{y:'center'}),scrollIntoView:true});
     view.focus();
    },
    applyRawChange(change){return applySourceRawChange(view,raw,change);},
    runCommand(id){view.focus();return runEditorCommand(view,id);}
   };
   view.dom.__noteEditorView=view;view.dom.__noteEditorHandle=handle;
   assignRef(props.current.inputRef,handle);
   function syncValue(){
    if(disposed||view.composing)return;
    const next=String(props.current.value??'');
    if(next===lastEmitted.current||next===raw.getMap(view.state).raw)return;
    const replacement=new RawSourceMap(next),position=Math.min(view.state.selection.main.head,replacement.length);
    // A genuine external document replacement starts a new undo history.
    // The view and its DOM remain mounted; ordinary controlled echoes do nothing.
    view.dispatch({effects:undoHistory.reconfigure([]),annotations:Transaction.addToHistory.of(false)});
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:replacement.normalized},selection:{anchor:position},
     effects:raw.replaceRaw.of(replacement),annotations:[externalValue.of(true),Transaction.addToHistory.of(false)]});
    replacement.normalized=null;
    view.dispatch({effects:undoHistory.reconfigure(history()),annotations:Transaction.addToHistory.of(false)});
    lastEmitted.current=next;
   }
   let previous={...props.current};
   instance.current={view,handle,sync(){
    syncValue();const current=props.current,effects=[];
    if(previous.busy!==current.busy)effects.push(editable.reconfigure([EditorState.readOnly.of(!!current.busy),EditorView.editable.of(!current.busy)]));
    if(previous.label!==current.label)effects.push(attributes.reconfigure(EditorView.contentAttributes.of({'aria-label':current.label,spellcheck:'false',role:'textbox','aria-multiline':'true'})));
    if(previous.fontSize!==current.fontSize)effects.push(theme.reconfigure(appearance(current.fontSize)));
    if(previous.inputRef!==current.inputRef){assignRef(previous.inputRef,null);assignRef(current.inputRef,handle);}
    if(effects.length)view.dispatch({effects});previous={...current};
   }};
   return ()=>{
    disposed=true;clearTimeout(compositionTimer);assignRef(previous.inputRef,null);
    delete view.dom.__noteEditorView;delete view.dom.__noteEditorHandle;view.destroy();instance.current=null;
   };
  },[]);
  R.useLayoutEffect(()=>{instance.current?.sync();},[value,busy,fontSize,label,inputRef,maxLength]);
  return h('div',{ref:host,className:'nb-source-editor',onKeyDownCapture:event=>{
   // Chrome EditContext can report a composing key before view.composing is
   // set. Keep every CM keymap out of this event without cancelling IME input.
   if(event.nativeEvent?.isComposing||event.isComposing||event.keyCode===229)event.stopPropagation();
  }});
 }
 return {SourceEditor,commandHelp};
}
