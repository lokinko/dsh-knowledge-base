import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {browseDirectories} from '../../src/host/storage/directories.js';

async function fixture(t){
 const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'dsh-folder-picker-'));
 t.after(async()=>{const target=path.resolve(directory);assert.equal(path.dirname(target),await fs.realpath(os.tmpdir()));assert.ok(path.basename(target).startsWith('dsh-folder-picker-'));await fs.rm(target,{recursive:true,force:true});});
 return directory;
}
test('Host folder browsing lists only real directories, keeps Unicode names and never changes files',async t=>{
 const root=await fixture(t),child=path.join(root,'资料库 01');await fs.mkdir(child);await fs.mkdir(path.join(root,'empty'));
 await fs.writeFile(path.join(root,'private.txt'),'Private file contents must never appear in a directory response');
 await fs.symlink(child,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
 const before=await fs.readdir(root),result=await browseDirectories({},{homeDirectory:root});
 assert.equal(result.directory,await fs.realpath(root));assert.equal(result.parent,path.dirname(result.directory));
 assert.deepEqual(result.entries.map(entry=>entry.name).sort(),['empty','资料库 01']);assert.equal(result.hasMore,false);
 assert.ok(result.roots.includes(path.parse(result.directory).root));
 assert.equal(JSON.stringify(result).includes('Private file contents'),false);assert.deepEqual(await fs.readdir(root),before);
 const nested=await browseDirectories({directory:child});assert.equal(nested.parent,result.directory);assert.deepEqual(nested.entries,[]);
});
test('directory results page without dropping or repeating sorted children',async t=>{
 const root=await fixture(t);await Promise.all(Array.from({length:105},(_,i)=>fs.mkdir(path.join(root,'folder'+i))));
 const first=await browseDirectories({directory:root}),last=await browseDirectories({directory:root,offset:100});
 assert.equal(first.entries.length,100);assert.equal(first.hasMore,true);assert.equal(last.entries.length,5);assert.equal(last.hasMore,false);
 assert.deepEqual([...first.entries,...last.entries].map(entry=>entry.name),Array.from({length:105},(_,i)=>'folder'+i));
});
test('invalid browsing inputs and file paths fail without creating a requested directory',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'file'),'text');
 for(const input of [null,[],{unknown:true},{offset:-1},{offset:0.5},{directory:7},{directory:'relative'},{directory:'bad\0path'}])await assert.rejects(browseDirectories(input),error=>['INVALID_REQUEST','INVALID_DIRECTORY'].includes(error.code));
 if(process.platform==='win32')for(const directory of ['C:relative','\\no-drive','/no-drive'])await assert.rejects(browseDirectories({directory}),{code:'INVALID_DIRECTORY'});
 const missing=path.join(root,'missing');for(const directory of [missing,path.join(root,'file')])await assert.rejects(browseDirectories({directory}),{code:'INVALID_DIRECTORY'});
 await assert.rejects(fs.stat(missing),{code:'ENOENT'});
});
