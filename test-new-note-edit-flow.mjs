import assert from 'node:assert/strict';
import {apply} from './index.js';
import {NoteDraftCache,NoteEditSession} from './note-edit-session.js';
const tables=new Map(),tools=new Map(),routes=new Map(),effects=[];
await apply({storageDomain:{async open(spec){return{table(name){if(!tables.has(name))tables.set(name,new Map());const rows=tables.get(name);return{get:key=>rows.get(key),entries:()=>rows.entries(),async put(key,value){rows.set(key,spec.tables[name].valueSchema.parse(value));},async delete(key){rows.delete(key);}};},async close(){}};}},connection:{fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path);}}},tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},effect(fn){effects.push(fn());}});
class Storage{data=new Map();get length(){return this.data.size;}key(i){return [...this.data.keys()][i]??null;}getItem(key){return this.data.get(key)??null;}setItem(key,value){this.data.set(key,String(value));}removeItem(key){this.data.delete(key);}}
const cache=new NoteDraftCache({storageGetter:()=>storage}),storage=new Storage(),timers=new Map();let next=0;
function setTimer(callback){assert.equal(this,globalThis,'Native timer receiver');const id=next++;timers.set(id,callback);return id;}
function clearTimer(id){assert.equal(this,globalThis,'Native cancel receiver');timers.delete(id);}
async function request(input){const response=await routes.get('/api/dsh-note/notes').fetch(new Request('http://localhost/api/dsh-note/notes',{method:'POST',body:JSON.stringify(input)}));const data=await response.json();assert.equal(response.ok,true,data.error);return data;}
try{
 const created=await request({action:'create',title:'未命名笔记',category:'document'});
 const opened=await request({action:'get',id:created.note.id});
 const session=new NoteEditSession({note:opened.note,cache,save:request,setTimer,clearTimer,writerId:'new-note-fixture',paused:true});
 session.start();await session.pause();session.start();
 session.change({title:'第一篇新笔记'});
 assert.equal(session.snapshot().status,'pending');assert.equal(timers.size,1);assert.equal(cache.latest(created.note.id).fields.title,'第一篇新笔记');
 const callback=[...timers.values()][0];timers.clear();callback();assert.equal(await session.flush(),true);
 let saved=await request({action:'get',id:created.note.id});assert.equal(saved.note.title,'第一篇新笔记');assert.equal(saved.note.revision,2);
 session.change({title:'第一篇新笔记 · 再编辑',content:'# 正文\r\n\r\n保留原始内容🙂\n'});
 assert.equal(await session.pause(),true);session.start();
 saved=await request({action:'get',id:created.note.id});assert.equal(saved.note.title,'第一篇新笔记 · 再编辑');assert.equal(saved.note.content,'# 正文\r\n\r\n保留原始内容🙂\n');assert.equal(saved.note.revision,3);assert.deepEqual(cache.records(),[]);
 assert.equal((await tools.get('manage_notes').execute({action:'get',id:created.note.id})).note.title,saved.note.title);
 await session.stop();assert.equal(timers.size,0);
 console.log('PASS: production Host create/get + first short-title edit, receiver-sensitive autosave, pause/resume, second title/body save, exact CRLF/Unicode, revisions, cache cleanup and HTTP/tool read parity. Private memory fixtures only.');
}finally{for(const effect of effects.reverse())await(await effect)?.();assert.equal(routes.size,0);assert.equal(tools.size,0);}
