import {EditorSelection,Transaction} from '@codemirror/state';
import {undo,redo,indentMore,indentLess} from '@codemirror/commands';
import {insertNewlineContinueMarkup} from '@codemirror/lang-markdown';
import {openSearchPanel,findNext,findPrevious} from '@codemirror/search';

function allowed(view){return !view.composing&&!view.state.readOnly;}
function wrap(view,before,after=before,placeholder=''){
 if(!allowed(view))return false;
 const {state}=view;
 const change=state.changeByRange(range=>{
  const text=state.sliceDoc(range.from,range.to);
  if(!range.empty&&text.startsWith(before)&&text.endsWith(after)&&text.length>=before.length+after.length){
   const inner=text.slice(before.length,text.length-after.length);
   return {changes:{from:range.from,to:range.to,insert:inner},range:EditorSelection.range(range.from,range.from+inner.length)};
  }
  if(state.sliceDoc(Math.max(0,range.from-before.length),range.from)===before&&state.sliceDoc(range.to,range.to+after.length)===after){
   return {changes:[{from:range.from-before.length,to:range.from},{from:range.to,to:range.to+after.length}],range:EditorSelection.range(range.from-before.length,range.to-before.length)};
  }
  const inner=text||placeholder;
  return {changes:{from:range.from,to:range.to,insert:before+inner+after},range:EditorSelection.range(range.from+before.length,range.from+before.length+inner.length)};
 });
 view.dispatch({...change,scrollIntoView:true,annotations:Transaction.userEvent.of('input.format')});return true;
}
function linePrefix(view,kind){
 if(!allowed(view))return false;
 const {state}=view,lines=new Map();
 for(const range of state.selection.ranges){
  let line=state.doc.lineAt(range.from),last=state.doc.lineAt(range.to);
  if(range.to>range.from&&last.from===range.to)last=state.doc.line(Math.max(1,last.number-1));
  while(line.number<=last.number){lines.set(line.number,line);if(line.number===last.number)break;line=state.doc.line(line.number+1);}
 }
 const pattern=kind==='heading'?/^(\s{0,3})(#{1,6}\s+)?/:kind==='quote'?/^(\s*)(>\s?)?/:/^(\s*)(?:(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;
 const prefix=kind==='ordered'?'1. ':kind==='bullet'?'- ':kind==='task'?'- [ ] ':kind==='quote'?'> ':'## ';
 const changes=[...lines.values()].map(line=>{
  const match=pattern.exec(line.text),indent=match?.[1]||'',old=match?.[0]||'';
  let next=indent+prefix;
  if(kind==='heading'&&match?.[2])next=indent;
  else if(kind!=='heading'&&old===next)next=indent;
  return {from:line.from,to:line.from+old.length,insert:next};
 });
 view.dispatch({changes,scrollIntoView:true,annotations:Transaction.userEvent.of('input.format')});return true;
}
function link(view){
 if(!allowed(view))return false;
 const {state}=view;
 view.dispatch({...state.changeByRange(range=>{
  const text=state.sliceDoc(range.from,range.to)||'text',insert=`[${text}](https://)`;
  const start=range.from+text.length+3;
  return {changes:{from:range.from,to:range.to,insert},range:EditorSelection.range(start,start+8)};
 }),scrollIntoView:true,annotations:Transaction.userEvent.of('input.format')});return true;
}
function codeBlock(view){
 if(!allowed(view))return false;
 const {state}=view;
 view.dispatch({...state.changeByRange(range=>{
  const text=state.sliceDoc(range.from,range.to),line=state.doc.lineAt(range.from),pad=range.from===line.from?'':'\n';
  let fenceLength=3;for(const match of text.matchAll(/`+/g))fenceLength=Math.max(fenceLength,match[0].length+1);
  const fence='`'.repeat(fenceLength),prefix=pad+fence+'\n',suffix=(text.endsWith('\n')?'':'\n')+fence;
  return {changes:{from:range.from,to:range.to,insert:prefix+text+suffix},range:EditorSelection.range(range.from+prefix.length,range.from+prefix.length+text.length)};
 }),scrollIntoView:true,annotations:Transaction.userEvent.of('input.format')});return true;
}

const commands={
 bold:view=>wrap(view,'**'),italic:view=>wrap(view,'*'),link,
 heading:view=>linePrefix(view,'heading'),orderedList:view=>linePrefix(view,'ordered'),
 bulletList:view=>linePrefix(view,'bullet'),taskList:view=>linePrefix(view,'task'),codeBlock,
 code:codeBlock,math:view=>wrap(view,'$', '$','x^2'),heading2:view=>linePrefix(view,'heading'),quote:view=>linePrefix(view,'quote'),
 undo,redo,indent:indentMore,outdent:indentLess,search:openSearchPanel,
 findNext,findPrevious,continueList:insertNewlineContinueMarkup
};
export const commandHelp=Object.freeze([
 {id:'bold',key:'Mod-b',label:'Bold'},
 {id:'italic',key:'Mod-i',label:'Italic'},
 {id:'link',key:'Mod-k',label:'Link'},
 {id:'orderedList',key:'Mod-Shift-7',label:'Numbered list'},
 {id:'bulletList',key:'Mod-Shift-8',label:'Bullet list'},
 {id:'taskList',key:'Mod-Shift-9',label:'Task list'},
 {id:'heading',key:'Mod-Alt-2',label:'Heading'},
 {id:'codeBlock',key:'Mod-Alt-c',label:'Code block'},
 {id:'search',key:'Mod-f',label:'Find and replace'},
 {id:'findNext',key:'Mod-g',label:'Find next'},
 {id:'undo',key:'Mod-z',label:'Undo'},
 {id:'redo',key:'Mod-Shift-z',label:'Redo'}
]);
export function runEditorCommand(view,id){
 if(!view||view.composing)return false;
 if(view.state.readOnly&&!['search','findNext','findPrevious'].includes(id))return false;
 const command=commands[id];
 return command?command(view):false;
}
export const markdownCommandKeymap=commandHelp.filter(item=>!['undo','search','findNext'].includes(item.id)).map(item=>({
 key:item.key,run:view=>runEditorCommand(view,item.id)
}));
