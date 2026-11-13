import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {NoteStorage,NOTE_STORAGE_CONTROL_KEY} from '../../src/host/storage/note-storage.js';
import {categoryTreeSchema,defaultCategoryTree} from '../../src/host/categories/store.js';
import {noteSchema,noteVersionSchema} from '../../src/host/notes/store.js';
import {chatBindingSchema} from '../../src/host/coauthor/note-chats.js';
import {attachmentSchema} from '../../src/host/attachments/schema.js';
import {topicSchema} from '../../src/host/topics/store.js';

const now='2026-11-11T01:00:00.000Z';
const digest=value=>createHash('sha256').update(value).digest('hex');
const schemas={notes:noteSchema,note_versions:noteVersionSchema,note_chats:chatBindingSchema,
 attachments:attachmentSchema,note_categories:categoryTreeSchema,note_topics:topicSchema};
class Table{
 data=new Map();puts=0;deletes=0;failPut=false;
 async get(key){return structuredClone(this.data.get(key));}
 async entries(){return structuredClone([...this.data]);}
 async put(key,value){if(this.failPut)throw new Error('fixture control put failed');this.puts++;this.data.set(key,structuredClone(value));}
 async delete(key){this.deletes++;this.data.delete(key);}
}
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
function topic(question='为什么要保留完整上下文？',overrides={}){
 return topicSchema.parse({id:randomUUID(),question,revision:1,references:[
  {kind:'note',atomId:'ctx1:fixture-note:0',label:'原文🙂'},
  {kind:'discussion',sessionId:'fixture-discussion',seq:3,label:'第三条讨论'},
 ],sessionId:'fixture-topic-chat',createdAt:now,updatedAt:now,...overrides});
}
async function fileSnapshot(root){
 const files={};
 async function visit(directory,prefix=''){
  const entries=await fs.readdir(directory,{withFileTypes:true});entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){
   const relative=path.posix.join(prefix,entry.name),absolute=path.join(directory,entry.name);
   if(entry.isDirectory()){files[relative+'/']='directory';await visit(absolute,relative);}
   else files[relative]=(await fs.readFile(absolute)).toString('base64');
  }
 }
 await visit(root);return files;
}
async function fixture(t){
 const temp=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'dsh-topic-storage-test-'));
 const legacy=Object.fromEntries(Object.keys(schemas).map(name=>[name,new Table()]));
 const controlTable=new Table(),managers=[],objects=new Map();
 const blobs={
  async save({data,name}){const parts=[];for await(const chunk of data)parts.push(chunk);const bytes=Buffer.concat(parts),attachmentId='fixture:'+digest(bytes);objects.set(attachmentId,bytes);return {attachmentId,bytes:bytes.length,name};},
  async *read(ref){const bytes=objects.get(ref.attachmentId);if(!bytes)throw new Error('fixture missing blob');yield bytes;},
  hostPath(){return undefined;},
 };
 const note=noteSchema.parse({id:randomUUID(),title:'历史笔记',content:'  exact\r\n正文🙂\r\n',createdAt:now,updatedAt:now,revision:1});
 const version=noteVersionSchema.parse({...note,versionId:note.id+':1',noteId:note.id,savedAt:now});
 const binding=chatBindingSchema.parse({noteId:note.id,sessionId:'fixture-note-chat',createdAt:now,updatedAt:now});
 const categories=categoryTreeSchema.parse({...defaultCategoryTree(),revision:1,items:[...defaultCategoryTree().items,
  {id:randomUUID(),name:'研究问题',parentId:'document',order:0}]});
 await legacy.notes.put(note.id,note);await legacy.note_versions.put(version.versionId,version);
 await legacy.note_chats.put(note.id,binding);await legacy.note_categories.put('categories',categories);
 const make=({topics=true,categories:enableCategories=true,attachments=true,topicSchema:enableTopicSchema=true,
  native=legacy,control=controlTable}={})=>{
  const enabled={...native},enabledSchemas={...schemas};
  if(!topics)delete enabled.note_topics;
  if(!enableCategories)delete enabled.note_categories;
  if(!attachments)delete enabled.attachments;
  if(!enableTopicSchema)delete enabledSchemas.note_topics;
  const manager=new NoteStorage({legacy:enabled,schemas:enabledSchemas,controlTable:control,blobs});managers.push(manager);return manager;
 };
 const checked=target=>{const absolute=path.resolve(target);assert.ok(absolute.startsWith(path.resolve(temp)+path.sep),'Only owned fixture descendants may be mutated');return absolute;};
 t.after(async()=>{
  for(const manager of managers.reverse())await manager.close();
  const absolute=path.resolve(temp);assert.ok(path.basename(absolute).startsWith('dsh-topic-storage-test-'));
  assert.equal(path.dirname(absolute),await fs.realpath(os.tmpdir()));await fs.rm(absolute,{recursive:true,force:true});
 });
 const state=()=>structuredClone(controlTable.data.get(NOTE_STORAGE_CONTROL_KEY));
 const root=(pointer=state())=>path.join(pointer.directory,'dsh-notebook','generations',pointer.generation);
 const switchTo=async(manager,directory)=>manager.execute({action:'set',directory,revision:(await manager.execute({action:'status'})).revision});
 const assertCore=async(manager,{category=true}={})=>{
  assert.deepEqual(await manager.table('notes').get(note.id),note);
  assert.deepEqual(await manager.table('note_versions').get(version.versionId),version);
  assert.deepEqual(await manager.table('note_chats').get(note.id),binding);
  if(category)assert.deepEqual(await manager.table('note_categories').get('categories'),categories);
 };
 const seedAttachment=async manager=>{
  const bytes=Buffer.from('topic retained attachment\0原始字节🙂');
  const ref=await blobs.save({data:(async function*(){yield bytes;})(),name:'source.bin'});
  const row=attachmentSchema.parse({id:randomUUID(),ownerType:'note',ownerId:note.id,name:ref.name,
   mediaType:'application/octet-stream',size:bytes.length,sha256:digest(bytes),ref,revision:1,createdAt:now,removedAt:''});
  await manager.table('attachments').put(row.id,row);return {row,bytes};
 };
 return {temp,legacy,controlTable,make,checked,state,root,switchTo,assertCore,seedAttachment};
}

for(const {attachments,categories,label} of [
 {attachments:false,categories:false,label:'core three-table'},
 {attachments:true,categories:false,label:'attachment four-table'},
 {attachments:false,categories:true,label:'category four-table'},
 {attachments:true,categories:true,label:'full five-table'},
]){
 test(`old ${label} generation reads without writes; first topic write preserves historical data and restarts`,async t=>{
  const f=await fixture(t),old=await f.make({topics:false,attachments,categories}).start();
  const binary=attachments?await f.seedAttachment(old):null;
  await f.switchTo(old,path.join(f.temp,'old-library'));
  const pointer=f.state(),oldRoot=f.root(),before=await fileSnapshot(oldRoot);
  const controlPuts=f.controlTable.puts,nativeTopicPuts=f.legacy.note_topics.puts;
  await old.close();
  const storage=await f.make().start();
  assert.equal(storage.libraryId,pointer.libraryId);
  assert.deepEqual(await storage.table('note_topics').entries(),[]);
  assert.equal(await storage.table('note_topics').get(randomUUID()),undefined);assert.equal((await storage.execute({action:'status'})).counts.topics,0);
  assert.equal((await storage.execute({action:'check',directory:pointer.directory})).writable,true);
  assert.deepEqual(f.state(),pointer);assert.equal(f.controlTable.puts,controlPuts);
  assert.equal(f.legacy.note_topics.puts,nativeTopicPuts);assert.deepEqual(await fileSnapshot(oldRoot),before);
  await f.assertCore(storage,{category:categories});
  const row=topic();
  await storage.table('note_topics').put(row.id,row,{libraryId:pointer.libraryId});
  assert.notEqual(f.state().generation,pointer.generation);assert.equal(f.state().revision,pointer.revision+1);
  assert.equal(storage.libraryId,pointer.libraryId);assert.equal(f.state().directory,pointer.directory);
  assert.deepEqual(await storage.table('note_topics').get(row.id),row);
  assert.deepEqual(await fileSnapshot(oldRoot),before);await f.assertCore(storage,{category:categories});
  if(binary){assert.deepEqual(await storage.table('attachments').get(binary.row.id),binary.row);assert.deepEqual(await fs.readFile(path.join(f.root(),'blobs',binary.row.sha256)),binary.bytes);}
  const marker=JSON.parse(await fs.readFile(path.join(f.root(),'generation.json'),'utf8'));
  assert.ok(marker.tables.includes('note_topics'));
  const generation=f.state().generation,updated={...row,question:'更新后仍保持身份',revision:2};
  await storage.table('note_topics').put(updated.id,updated,{libraryId:storage.libraryId});
  assert.equal(f.state().generation,generation,'normal topic writes update their row without restaging');
  await storage.close();const restarted=await f.make().start();
  assert.deepEqual(await restarted.table('note_topics').get(row.id),updated);assert.equal((await restarted.execute({action:'status'})).counts.topics,1);
  assert.equal(restarted.libraryId,pointer.libraryId);await f.assertCore(restarted,{category:categories});
 });
}

test('failed first-topic pointer publication preserves original route, old generation bytes and every table',async t=>{
 const f=await fixture(t),old=await f.make({topics:false}).start(),binary=await f.seedAttachment(old);
 await f.switchTo(old,path.join(f.temp,'old-library'));
 const pointer=f.state(),oldRoot=f.root(),before=await fileSnapshot(oldRoot);await old.close();
 const storage=await f.make().start(),row=topic();
 f.controlTable.failPut=true;
 await assert.rejects(storage.table('note_topics').put(row.id,row,{libraryId:pointer.libraryId}),/fixture control put failed/);
 assert.deepEqual(f.state(),pointer);assert.equal(storage.libraryId,pointer.libraryId);
 assert.equal((await storage.execute({action:'status'})).directory,pointer.directory);
 assert.equal(storage._active.generation,pointer.generation);
 assert.deepEqual(await storage.table('note_topics').entries(),[]);
 assert.deepEqual(await fileSnapshot(oldRoot),before);await f.assertCore(storage);
 assert.deepEqual(await fs.readFile(path.join(oldRoot,'blobs',binary.row.sha256)),binary.bytes);
 f.controlTable.failPut=false;await storage.close();
 const retry=await f.make().start();assert.deepEqual(await retry.table('note_topics').entries(),[]);
 await retry.table('note_topics').put(row.id,row,{libraryId:retry.libraryId});
 assert.deepEqual(await retry.table('note_topics').get(row.id),row);assert.equal(retry.libraryId,pointer.libraryId);
});

test('topics, references, session bindings, categories and attachments survive A→B→native→restart',async t=>{
 const f=await fixture(t),storage=await f.make().start(),binary=await f.seedAttachment(storage),row=topic();
 const libraryId=storage.libraryId;
 await storage.table('note_topics').put(row.id,row,{libraryId});
 for(const directory of [path.join(f.temp,'A'),path.join(f.temp,'B'),'']){
  await f.switchTo(storage,directory);assert.equal(storage.libraryId,libraryId);
  assert.deepEqual(await storage.table('note_topics').get(row.id),row);await f.assertCore(storage);
  let bytes=Buffer.alloc(0);for await(const part of (await storage.readAttachment(binary.row)).data)bytes=Buffer.concat([bytes,part]);
  assert.deepEqual(bytes,binary.bytes);
 }
 assert.deepEqual(f.legacy.note_topics.data.get(row.id),row);
 await storage.close();const restarted=await f.make().start();
 assert.equal(restarted.libraryId,libraryId);assert.deepEqual(await restarted.table('note_topics').get(row.id),row);
});

test('return-to-native pointer failure rolls topic writes back and retains the directory route',async t=>{
 const f=await fixture(t),storage=await f.make().start(),row=topic();
 await storage.table('note_topics').put(row.id,row,{libraryId:storage.libraryId});
 await f.switchTo(storage,path.join(f.temp,'A'));
 const updated={...row,question:'directory-only question',revision:2};
 await storage.table('note_topics').put(row.id,updated,{libraryId:storage.libraryId});
 const pointer=f.state();f.controlTable.failPut=true;
 await assert.rejects(f.switchTo(storage,''),/fixture control put failed/);
 assert.deepEqual(f.state(),pointer);assert.deepEqual(f.legacy.note_topics.data.get(row.id),row);
 assert.deepEqual(await storage.table('note_topics').get(row.id),updated);await f.assertCore(storage);
 f.controlTable.failPut=false;await f.switchTo(storage,'');
 assert.deepEqual(f.legacy.note_topics.data.get(row.id),updated);
});

test('queued topic put/delete allow same-library directory migration and capture identity options at admission',async t=>{
 const f=await fixture(t),storage=await f.make().start(),old=topic('delete me'),added=topic('queued create');
 const libraryId=storage.libraryId;
 await storage.table('note_topics').put(old.id,old,{libraryId});
 const entered=deferred(),release=deferred(),stage=storage._stage.bind(storage);
 storage._stage=async(...args)=>{entered.resolve();await release.promise;return stage(...args);};
 const switching=f.switchTo(storage,path.join(f.temp,'queued-destination'));await entered.promise;
 const options={libraryId},put=storage.table('note_topics').put(added.id,added,options),remove=storage.table('note_topics').delete(old.id,options);
 options.libraryId=randomUUID();added.question='caller mutation after admission';release.resolve();
 await switching;await put;await remove;
 assert.equal(storage.libraryId,libraryId);assert.equal(await storage.table('note_topics').get(old.id),undefined);
 assert.equal((await storage.table('note_topics').get(added.id)).question,'queued create');
 assert.equal(f.legacy.note_topics.data.has(added.id),false);assert.equal(f.legacy.note_topics.data.has(old.id),true);
 const persisted=JSON.parse(await fs.readFile(path.join(f.root(),'note_topics',digest(added.id)+'.json'),'utf8'));
 assert.equal(persisted.value.question,'queued create');
 await storage.close();const restarted=await f.make().start();
 assert.equal(await restarted.table('note_topics').get(old.id),undefined);assert.equal((await restarted.table('note_topics').get(added.id)).question,'queued create');
});

test('queued put/delete reject a different library at execution without polluting either independent library',async t=>{
 const f=await fixture(t),a=await f.make().start();
 const nativeB=Object.fromEntries(Object.keys(schemas).map(name=>[name,new Table()])),controlB=new Table();
 const b=await f.make({native:nativeB,control:controlB}).start();
 await f.switchTo(a,path.join(f.temp,'library-A'));await f.switchTo(b,path.join(f.temp,'library-B'));
 const oldA=topic('A original'),oldB=topic('B original'),newA=topic('must never reach B');
 await a.table('note_topics').put(oldA.id,oldA,{libraryId:a.libraryId});
 await b.table('note_topics').put(oldB.id,oldB,{libraryId:b.libraryId});
 const rootA=f.root(),rootB=f.root(controlB.data.get(NOTE_STORAGE_CONTROL_KEY));
 const beforeA=await fileSnapshot(rootA),beforeB=await fileSnapshot(rootB),idA=a.libraryId,idB=b.libraryId;
 assert.notEqual(idA,idB);
 const entered=deferred(),release=deferred();
 const blocking=a._enqueue(async()=>{entered.resolve();await release.promise;});await entered.promise;
 const options={libraryId:idA};
 const put=a.table('note_topics').put(newA.id,newA,options),remove=a.table('note_topics').delete(oldB.id,options);
 const outcome=Promise.allSettled([put,remove]);options.libraryId=idB;
 // Storage switches normally keep library identity. This narrow fixture swaps
 // routes while queued to model a true library replacement at the write boundary.
 const saved={state:a._state,maps:a._maps,active:a._active};
 try{
  a._state=b._state;a._maps=b._maps;a._active=b._active;
  assert.deepEqual(await a.table('note_topics').get(oldB.id),oldB,'the queued writes would resolve to B without the guard');
  release.resolve();await blocking;
  const results=await outcome;
  assert.deepEqual(results.map(result=>result.status),['rejected','rejected']);
  for(const result of results)assert.equal(result.reason.code,'CONFLICT');
  assert.deepEqual(await b.table('note_topics').get(oldB.id),oldB);assert.equal(await b.table('note_topics').get(newA.id),undefined);
 }finally{release.resolve();await blocking;await outcome;a._state=saved.state;a._maps=saved.maps;a._active=saved.active;}
 assert.deepEqual(await a.table('note_topics').get(oldA.id),oldA);assert.equal(await a.table('note_topics').get(newA.id),undefined);
 assert.deepEqual(await fileSnapshot(rootA),beforeA);assert.deepEqual(await fileSnapshot(rootB),beforeB);
 assert.equal(a.libraryId,idA);assert.equal(b.libraryId,idB);
 // A rejected guard must not poison the global storage queue.
 await a.table('note_topics').put(newA.id,newA,{libraryId:idA});
 assert.deepEqual(await a.table('note_topics').get(newA.id),newA);assert.equal(await b.table('note_topics').get(newA.id),undefined);
});

test('declared topic directories are required; absent directories fail closed on migration and restart',async t=>{
 const f=await fixture(t),storage=await f.make().start(),row=topic();
 await storage.table('note_topics').put(row.id,row,{libraryId:storage.libraryId});await f.switchTo(storage,path.join(f.temp,'A'));
 const pointer=f.state(),directory=f.checked(path.join(f.root(),'note_topics'));
 await fs.rm(directory,{recursive:true});
 await assert.rejects(f.switchTo(storage,''),{code:'INVALID_DIRECTORY'});assert.deepEqual(f.state(),pointer);
 await storage.close();await assert.rejects(f.make().start(),{code:'INVALID_DIRECTORY'});assert.deepEqual(f.state(),pointer);
});

test('topic opt-in needs both table and schema, and keys must match topic identity',async t=>{
 const f=await fixture(t),withoutTable=await f.make({topics:false}).start(),withoutSchema=await f.make({topicSchema:false}).start();
 assert.throws(()=>withoutTable.table('note_topics'),/Unknown notebook table/);
 assert.throws(()=>withoutSchema.table('note_topics'),/Unknown notebook table/);
 const enabled=await f.make().start(),row=topic();
 await assert.rejects(enabled.table('note_topics').put(randomUUID(),row,{libraryId:enabled.libraryId}),{code:'INVALID_RECORD'});
 assert.deepEqual(await enabled.table('note_topics').entries(),[]);
});
