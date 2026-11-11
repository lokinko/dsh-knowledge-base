import assert from 'node:assert/strict';
import test from 'node:test';
import * as protocol from '../../src/client/notes/draft-record.js';
import * as compatibility from '../../src/client/notes/edit-session.js';
import {NoteDraftCache} from '../../src/client/notes/legacy-draft-cache.js';

const fields=()=>({title:'Title',content:'原文🙂\r\nA\rB\n\u0000',category:'document',tags:['one','two'],pinned:false,journalDate:''});

test('field equality compares all editable fields without normalizing raw text or tag order',()=>{
 const original=fields();
 assert.equal(protocol.noteFieldsEqual(original,{...fields(),revision:999}),true);
 for(const patch of [{title:'Other'},{content:original.content.replace(/\r\n?/g,'\n')},{category:'reading'},{tags:['two','one']},{tags:['one']},{pinned:true},{journalDate:'2024-02-29'}]){
  assert.equal(protocol.noteFieldsEqual(original,{...original,...patch}),false,JSON.stringify(patch));
 }
 const normalized=protocol.normalizeNoteFields(original);
 assert.equal(normalized.content,original.content);
 normalized.tags.push('three');assert.deepEqual(original.tags,['one','two']);
});

test('legacy exports preserve function identity and the exact existing storage format',()=>{
 for(const key of ['normalizeNoteFields','validateDraftIdentity','noteDraftKey','decodeLegacyDraft','cloneDraftRecord'])assert.equal(compatibility[key],protocol[key]);
 assert.equal(compatibility.NoteDraftCache,NoteDraftCache);
 const data=new Map();
 const storage={get length(){return data.size;},key:index=>[...data.keys()][index]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
 const cache=new NoteDraftCache({storageGetter:()=>storage});
 const record=cache.write({noteId:'note:中文',writerId:'writer/a',baseRevision:3,fields:fields()});
 const expectedKey='dsh.todo-manager.note-draft.v1:note%3A%E4%B8%AD%E6%96%87:writer%2Fa';
 assert.equal(protocol.NOTE_DRAFT_PREFIX,'dsh.todo-manager.note-draft.v1:');
 assert.equal(record.key,expectedKey);
 assert.equal(data.get(expectedKey),JSON.stringify({version:1,noteId:'note:中文',writerId:'writer/a',baseRevision:3,fields:fields(),updatedAt:record.updatedAt}));
 assert.deepEqual(protocol.decodeLegacyDraft(record.key,record.raw),record);
 assert.deepEqual(new NoteDraftCache({storageGetter:()=>storage}).latest('note:中文'),record);
 assert.equal(protocol.decodeLegacyDraft(record.key+'wrong',record.raw),null);
 assert.equal(protocol.decodeLegacyDraft(record.key,'{bad'),null);
});
