import assert from 'node:assert/strict';
import test from 'node:test';
import {EditorState,EditorSelection,Transaction} from '@codemirror/state';
import {history} from '@codemirror/commands';
import {markdown} from '@codemirror/lang-markdown';
import {runEditorCommand,commandHelp,markdownCommandKeymap} from '../../src/client/editor/commands.js';
import {markdownBlockCompletions} from '../../src/client/editor/completions.js';
import {createRawSourceExtension} from '../../src/client/editor/source-state.js';
import {createSourceEditor} from '../../src/client/editor/index.js';

function editor(source,selection={anchor:0},extensions=[]){
 const raw=createRawSourceExtension(source);
 const view={state:EditorState.create({doc:raw.initial.normalized,selection,extensions:[raw.extension,history(),markdown({addKeymap:false}),...extensions]}),composing:false,
  dispatch(...specs){view.state=specs[0] instanceof Transaction?specs[0].state:view.state.update(...specs).state;},focus(){}
 };
 raw.initial.normalized=null;
 return {view,get text(){return view.state.doc.toString();},get raw(){return raw.getMap(view.state).raw;}};
}

test('formatting commands preserve selection, toggle wrapping, and retain mixed source separators',()=>{
 const app=editor('😀\r\nhello\nworld',{anchor:3,head:8});
 assert.equal(runEditorCommand(app.view,'bold'),true);
 assert.equal(app.raw,'😀\r\n**hello**\nworld');
 assert.equal(app.view.state.sliceDoc(app.view.state.selection.main.from,app.view.state.selection.main.to),'hello');
 assert.equal(runEditorCommand(app.view,'bold'),true);assert.equal(app.raw,'😀\r\nhello\nworld');
 runEditorCommand(app.view,'italic');assert.equal(app.raw,'😀\r\n*hello*\nworld');
 runEditorCommand(app.view,'undo');assert.equal(app.raw,'😀\r\nhello\nworld');
 runEditorCommand(app.view,'redo');assert.equal(app.raw,'😀\r\n*hello*\nworld');
});

test('link, headings, lists, quote and code toolbar aliases produce editable Markdown',()=>{
 const link=editor('title',{anchor:0,head:5});runEditorCommand(link.view,'link');
 assert.equal(link.text,'[title](https://)');
 const selection=link.view.state.selection.main;assert.equal(link.view.state.sliceDoc(selection.from,selection.to),'https://');
 for(const [id,expected] of [['heading2','## text'],['bulletList','- text'],['orderedList','1. text'],['taskList','- [ ] text'],['quote','> text']]){
  const app=editor('text');runEditorCommand(app.view,id);assert.equal(app.text,expected,id);runEditorCommand(app.view,id);assert.equal(app.text,'text',`${id} toggle`);
 }
 const code=editor('alpha\r\nbeta',{anchor:0,head:10});runEditorCommand(code.view,'code');
 assert.equal(code.raw,'```\r\nalpha\r\nbeta\r\n```');
 assert.equal(code.view.state.sliceDoc(code.view.state.selection.main.from,code.view.state.selection.main.to),'alpha\nbeta');
 const nested=editor('```js\ncode\n```',{anchor:0,head:14});runEditorCommand(nested.view,'code');
 assert.equal(nested.text,'````\n```js\ncode\n```\n````');
});

test('line commands cover selected lines once and preserve terminal unselected line',()=>{
 const app=editor('one\r\ntwo\nthree',{anchor:0,head:8});runEditorCommand(app.view,'bulletList');
 assert.equal(app.raw,'- one\r\n- two\nthree');
 const multi=editor('one\ntwo',EditorSelection.create([EditorSelection.range(0,1),EditorSelection.range(2,3)]),[EditorState.allowMultipleSelections.of(true)]);
 runEditorCommand(multi.view,'taskList');assert.equal(multi.text,'- [ ] one\ntwo');
});

test('Enter continues list/task syntax, exits empty list, and Tab/ShiftTab indent safely',()=>{
 for(const [source,expected] of [['- item','- item\n- '],['1. item','1. item\n2. '],['- [x] done','- [x] done\n- [ ] '],['- ','']]){
  const app=editor(source,{anchor:source.length});assert.equal(runEditorCommand(app.view,'continueList'),true);assert.equal(app.text,expected,source);
 }
 const app=editor('text');runEditorCommand(app.view,'indent');assert.match(app.text,/^\s+text$/);
 runEditorCommand(app.view,'outdent');assert.equal(app.text,'text');
});

test('composition and read-only state do not intercept or mutate editor content',()=>{
 const app=editor('文字',{anchor:2});app.view.composing=true;
 for(const id of ['bold','italic','link','heading2','code','taskList','undo','continueList'])assert.equal(runEditorCommand(app.view,id),false);
 assert.equal(app.text,'文字');
 assert.ok(markdownCommandKeymap.every(binding=>binding.preventDefault!==true));
 app.view.composing=false;
 const locked=editor('busy',{anchor:0},[EditorState.readOnly.of(true)]);
 assert.equal(runEditorCommand(locked.view,'bold'),false);assert.equal(runEditorCommand(locked.view,'undo'),false);assert.equal(locked.text,'busy');
});

test('slash completion only opens on otherwise empty lines and inserts eight standard blocks',()=>{
 const app=editor('intro\r\n/');
 const result=markdownBlockCompletions({state:app.view.state,pos:7,view:app.view});
 assert.equal(result.options.length,8);
 const code=result.options.find(option=>option.label==='code');code.apply(app.view,code,result.from,7);
 assert.equal(app.raw,'intro\r\n```\r\n\r\n```');
 assert.equal(app.view.state.selection.main.head,10);
 for(const source of ['https://example.com/','normal /','`/`']){
  const other=editor(source);assert.equal(markdownBlockCompletions({state:other.view.state,pos:source.length,view:other.view}),null);
 }
 const composing=editor('/');composing.view.composing=true;
 assert.equal(markdownBlockCompletions({state:composing.view.state,pos:1,view:composing.view}),null);
});

test('source capture leaves native IME defaults alone and blocks only composing key propagation',()=>{
 const R={useRef:value=>({current:value}),useLayoutEffect(){}},h=(type,props)=>({type,props});
 const {SourceEditor}=createSourceEditor({R,h,t:key=>key}),root=SourceEditor({value:'原文'});
 for(const attributes of [{nativeEvent:{isComposing:true}},{isComposing:true},{keyCode:229}]){
  let stopped=0;const event={...attributes,stopPropagation(){stopped++;},preventDefault(){assert.fail('IME default must not be cancelled');}};
  root.props.onKeyDownCapture(event);assert.equal(stopped,1);
 }
 let stopped=0;root.props.onKeyDownCapture({keyCode:66,ctrlKey:true,nativeEvent:{isComposing:false},stopPropagation(){stopped++;}});
 assert.equal(stopped,0,'ordinary formatting keys still reach CM');
});

test('factory exposes source editor and command help with standard shortcut coverage',()=>{
 const exported=createSourceEditor({R:{},h(){},t:key=>key});assert.equal(typeof exported.SourceEditor,'function');
 assert.equal(exported.commandHelp,commandHelp);
 const redoBinding=markdownCommandKeymap.find(binding=>binding.key==='Mod-Shift-z');
 assert.ok(redoBinding,'Windows also binds the advertised Shift+Mod+Z redo shortcut');
 const app=editor('before');app.view.dispatch({changes:{from:0,to:6,insert:'after'}});runEditorCommand(app.view,'undo');
 assert.equal(app.text,'before');assert.equal(redoBinding.run(app.view),true);assert.equal(app.text,'after');
 for(const key of ['Mod-b','Mod-i','Mod-k','Mod-Shift-7','Mod-Shift-8','Mod-f','Mod-g','Mod-z'])assert.ok(commandHelp.some(item=>item.key===key),key);
});
