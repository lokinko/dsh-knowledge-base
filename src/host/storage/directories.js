import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const PAGE_SIZE=100;
const absolute=value=>typeof value==='string'&&value.length<=32768&&!value.includes('\0')&&path.isAbsolute(value)&&
 (process.platform!=='win32'||/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(value));

/** Read directory names on the Host. This never creates or switches storage. */
export async function browseDirectories(input,{homeDirectory=os.homedir()}={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['directory','offset'].includes(key))||
  (input.directory!==undefined&&typeof input.directory!=='string')||
  (input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>1000000)))throw fail('INVALID_REQUEST','Invalid directory browsing request');
 const requested=input.directory||homeDirectory,offset=input.offset||0;
 if(!absolute(requested))throw fail('INVALID_DIRECTORY','Choose an absolute directory on the computer running DSH');
 try{
  const directory=await fs.realpath(requested),stat=await fs.stat(directory);
  if(!stat.isDirectory())throw fail('INVALID_DIRECTORY','The selected path is not a directory');
  const entries=(await fs.readdir(directory,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink())
   .sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));
  const roots=process.platform==='win32'?await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async letter=>{
   const root=letter+':\\';try{return (await fs.stat(root)).isDirectory()?root:null;}catch{return null;}
  })).then(values=>values.filter(Boolean)):[path.parse(directory).root];
  const parent=path.dirname(directory);
  return {ok:true,directory,parent:parent===directory?null:parent,home:homeDirectory,roots,
   entries:entries.slice(offset,offset+PAGE_SIZE).map(entry=>({name:entry.name,directory:path.join(directory,entry.name)})),
   offset,hasMore:offset+PAGE_SIZE<entries.length};
 }catch(error){
  if(['EACCES','EPERM'].includes(error.code))throw fail('DIRECTORY_ACCESS_DENIED','The DSH service cannot read this directory. Check its access permissions.');
  if(['ENOENT','ENOTDIR'].includes(error.code))throw fail('INVALID_DIRECTORY','This directory does not exist on the computer running DSH');
  throw error;
 }
}
