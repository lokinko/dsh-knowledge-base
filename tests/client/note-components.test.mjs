import assert from 'node:assert/strict';
import test from 'node:test';
import {createNoteEditor} from '../../src/client/notes/editor.js';
import {createNotesHistory} from '../../src/client/notes/history.js';
import {createNotesUI} from '../../src/client/notes/ui.js';
import {NoteDraftCache} from '../../src/client/notes/legacy-draft-cache.js';
import {noteFieldsEqual} from '../../src/client/notes/draft-record.js';

function harness(){
 const slots=[];let cursor=0;
 const R={
  Fragment:Symbol('Fragment'),
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
  useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
  useId(){return 'test-id';},useEffect(){},useLayoutEffect(){},
  useMemo(fn){return fn();},useCallback(fn){return fn;}
 };
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(value=>value!==null&&value!==false&&value!==undefined)});
 return {R,h,render(Component,props){cursor=0;return Component(props);}};
}
function nodes(node){return node&&typeof node==='object'?[node,...node.children.flatMap(nodes)]:[];}
const note={id:'note-1',revision:1,title:'Raw',content:'# 文稿🙂\r\nbody\r\n## next\rtext',category:'document',tags:[],pinned:false,journalDate:'',updatedAt:'2026-01-01T00:00:00.000Z'};
function dependencies(app){
 return {...app,t:key=>key,Icon(){},Button(){},AutoTextarea(){},MarkdownField(){},MarkdownPreview(){},DocumentOutline(){},CategoryPicker(){},AttachmentPanel(){},NotesHistory(){},noteCache:new NoteDraftCache({storageGetter:()=>null}),notesRequest:async()=>{throw new Error('Unexpected request during render');},noteFieldsEqual,noteTime:()=>''};
}

test('extracted editor preserves raw source and delegates outline navigation to the mounted field',async()=>{
 const app=harness(),deps=dependencies(app),{NoteEditor}=createNoteEditor(deps);
 const props={note,categories:{categoryLabel:value=>value},onSaved(){}};
 let tree=app.render(NoteEditor,props);
 const field=nodes(tree).find(node=>node.type===deps.MarkdownField);
 assert.equal(field.props.value,note.content);
 assert.equal(field.props.label,'nbContent');
 const received=[];
 field.props.fieldRef.current={revealHeading:async heading=>{received.push(heading);return true;}};
 nodes(tree).find(node=>node.type===deps.Button&&node.props.label==='nbOutlineShow').props.onClick();
 tree=app.render(NoteEditor,props);
 const outline=nodes(tree).find(node=>node.type===deps.DocumentOutline);
 const heading={index:1,offset:note.content.indexOf('## next'),title:'next'};
 await outline.props.onNavigate(heading);
 assert.equal(received.length,1);assert.equal(received[0],heading);
 assert.equal(outline.props.content,note.content);
 field.props.fieldRef.current=null;
 await assert.doesNotReject(()=>outline.props.onNavigate(heading));
});

test('workspace creates stable editor and history component types during factory initialization',async()=>{
 const app=harness(),deps=dependencies(app),tree={id:'categories',revision:0,items:[]};
 Object.assign(deps,{
  useCategories:()=>({tree,flattened:[],categoryLabel:value=>value}),
  CategoryManager(){},DirectoryPanel(){},CommandMenu(){},ShortcutHelp(){},NoteSettings(){},NoteLibraryCard(){},CoauthorPanel(){},localCalendar:()=>'',
  notesRequest:async input=>{assert.equal(input.action,'get');return {note};}
 });
 const exported=createNotesUI(deps);
 assert.deepEqual(Object.keys(exported),['NotesWorkspace']);
 const workspaceProps={appearance:{fontSize:15},slotProps:{}};
 let root=app.render(exported.NotesWorkspace,workspaceProps);
 const menuTrigger=nodes(root).find(node=>node.props['aria-label']==='wbCommands');
 menuTrigger.props.onClick();
 root=app.render(exported.NotesWorkspace,workspaceProps);
 const menu=nodes(root).find(node=>node.type===deps.CommandMenu);
 await menu.props.onOpenNote(note);
 root=app.render(exported.NotesWorkspace,workspaceProps);
 const editor=nodes(root).find(node=>node.type?.name==='NoteEditor');
 assert.ok(editor);assert.equal(editor.props.note,note);
 const rerender=app.render(exported.NotesWorkspace,workspaceProps);
 assert.equal(nodes(rerender).find(node=>node.type?.name==='NoteEditor').type,editor.type);
 const editorApp=harness(),editorProps={...editor.props,categories:{categoryLabel:value=>value}};
 // Exercise the extracted history boundary with the editor's own hook state.
 const editorDeps=dependencies(editorApp),{NotesHistory}=createNotesHistory(editorDeps);
 const {NoteEditor}=createNoteEditor({...editorDeps,NotesHistory});
 let editorTree=editorApp.render(NoteEditor,editorProps);
 nodes(editorTree).find(node=>node.type===editorDeps.Button&&node.props.label==='nbHistory').props.onClick();
 editorTree=editorApp.render(NoteEditor,editorProps);
 assert.equal(nodes(editorTree).find(node=>node.type===NotesHistory).props.note,note);
});
