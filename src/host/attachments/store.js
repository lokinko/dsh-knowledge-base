import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {attachmentSchema} from './schema.js';
const OWNER='note';
const uuid=z.string().uuid(),owner={ownerType:z.literal(OWNER).default(OWNER),ownerId:uuid};
const actions=z.discriminatedUnion('action',[
 z.object({action:z.literal('list'),...owner,offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(20)}).strict(),
 z.object({action:z.literal('get'),id:uuid}).strict(),
 z.object({action:z.literal('add'),...owner,filePath:z.string().min(1),name:z.string().min(1).max(255).optional()}).strict(),
 z.object({action:z.literal('remove'),...owner,id:uuid,revision:z.number().int().positive()}).strict(),
]);
const fail=(code,message)=>Object.assign(new Error(message),{code});
export function attachmentName(input){
 let name=String(input||'file').toWellFormed().replaceAll('\\','/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g,'_').trim().slice(0,255).replace(/[\uD800-\uDBFF]$/,'');
 return name||'file';
}
function mediaType(bytes){
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return'image/jpeg';
 if(bytes.length>=6&&['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')))return'image/gif';
 if(bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return'image/webp';
 if(bytes.length>=5&&bytes.subarray(0,5).toString('ascii')==='%PDF-')return'application/pdf';
 return'application/octet-stream';
}
function markdown(row,url){const name=row.name.replace(/[\\`*_{}\[\]()<>#!|]/g,'\\$&');return(row.mediaType.startsWith('image/')?'!':'')+'['+name+']('+url+')';}
export class AttachmentStore{
 constructor({storage,blobs,resolveOwner,fixedOwnerType=OWNER,basePath='/api/dsh-note',clock=()=>new Date().toISOString()}){if(fixedOwnerType!==OWNER||basePath!=='/api/dsh-note')throw new TypeError('Invalid note attachment scope');this.fixedOwnerType=OWNER;this.basePath=basePath;this.storage=storage;this.table=storage.table('attachments');this.blobs=blobs;this.resolveOwner=resolveOwner;this.clock=clock;this.queue=Promise.resolve();this.pending=new Set();this.closed=false;}
 async owner(type,id,write=false){z.object(owner).parse({ownerType:type,ownerId:id});const entity=await this.resolveOwner(type,id);if(!entity)throw fail('NOT_FOUND','The note no longer exists');if(write&&entity.trashedAt)throw fail('READ_ONLY','Restore this note before changing attachments');return entity;}
 serialize(work){const operation=this.queue.then(work);this.queue=operation.catch(()=>{});return operation;}
 track(operation){this.pending.add(operation);operation.finally(()=>this.pending.delete(operation)).catch(()=>{});return operation;}
 execute(input,signal){if(this.closed)return Promise.reject(fail('CLOSED','Attachment storage is closing'));let request;try{request=actions.parse(structuredClone(input));}catch(error){return Promise.reject(fail('INVALID_REQUEST',error.message));}return this.track(this.perform(request,signal));}
 async perform(request,signal){
  signal?.throwIfAborted();
  if(request.action==='add'){
   if(!path.isAbsolute(request.filePath))throw fail('INVALID_PATH','Use an absolute file path on the DSH host');
   const resolved=await fs.realpath(request.filePath),handle=await fs.open(resolved,'r');
   try{const stat=await handle.stat();if(!stat.isFile())throw fail('INVALID_PATH','Expected a regular file');return await this.add({ownerType:request.ownerType,ownerId:request.ownerId,name:request.name||path.basename(resolved),signal,data:handle.createReadStream({autoClose:false,highWaterMark:65536})});}finally{await handle.close();}
  }
  if(request.action==='list'){
   await this.owner(request.ownerType,request.ownerId);
   const rows=(await this.table.entries()).map(([,value])=>value).filter(row=>row.ownerType===request.ownerType&&row.ownerId===request.ownerId&&!row.removedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
   return{ok:true,attachments:rows.slice(request.offset,request.offset+request.limit).map(row=>this.public(row)),total:rows.length,offset:request.offset,limit:request.limit};
  }
  if(request.action==='get'){const row=await this.getRow(request.id);const file=await this.storage.readAttachment(row,signal);return{ok:true,attachment:{...this.public(row),...(file.hostPath?{hostPath:file.hostPath}:{})}};}
  return this.serialize(async()=>{
   const row=await this.getRow(request.id);if(row.ownerType!==request.ownerType||row.ownerId!==request.ownerId)throw fail('NOT_FOUND','Attachment does not belong to this note');await this.owner(row.ownerType,row.ownerId,true);
   if(row.revision!==request.revision)throw fail('CONFLICT','Attachment changed elsewhere. Refresh and retry.');
   if(row.removedAt)return{ok:true,attachment:this.public(row)};
   const next=attachmentSchema.parse({...row,revision:row.revision+1,removedAt:this.clock()});await this.table.put(row.id,next);return{ok:true,attachment:this.public(next)};
  });
 }
 add(input){if(this.closed)return Promise.reject(fail('CLOSED','Attachment storage is closing'));return this.track(this.upload(input));}
 async upload({ownerType=OWNER,ownerId,name,data,signal}){
  await this.owner(ownerType,ownerId,true);name=attachmentName(name);const hash=createHash('sha256'),prefix=[];let bytes=0,headBytes=0;
  async function* chunks(){for await(const value of data){signal?.throwIfAborted();if(!(value instanceof Uint8Array))throw fail('INVALID_STREAM','Expected binary file chunks');bytes+=value.byteLength;if(!Number.isSafeInteger(bytes))throw fail('FILE_TOO_LARGE','File length exceeds supported integer range');hash.update(value);if(headBytes<512){const part=Buffer.from(value.subarray(0,512-headBytes));prefix.push(part);headBytes+=part.length;}yield value;}signal?.throwIfAborted();}
  const ref=await this.blobs.save({data:chunks(),name,signal});if(ref.bytes!==bytes)throw fail('INVALID_FILE','Stored file length does not match uploaded data');const sha256=hash.digest('hex'),type=mediaType(Buffer.concat(prefix));
  return this.serialize(async()=>{
   signal?.throwIfAborted();await this.owner(ownerType,ownerId,true);
   for(const[,row]of await this.table.entries())if(!row.removedAt&&row.ownerType===ownerType&&row.ownerId===ownerId&&row.name===name&&row.sha256===sha256&&row.size===bytes)return{ok:true,attachment:this.public(row)};
   const row=attachmentSchema.parse({id:randomUUID(),ownerType,ownerId,name,mediaType:type,size:bytes,sha256,ref,revision:1,createdAt:this.clock(),removedAt:''});await this.table.put(row.id,row);return{ok:true,attachment:this.public(row)};
  });
 }
 async getRow(id){uuid.parse(id);const row=await this.table.get(id);if(!row||row.ownerType!==OWNER)throw fail('NOT_FOUND','Attachment not found');return attachmentSchema.parse(structuredClone(row));}
 public(row){const url=this.basePath+'/attachment-file?id='+encodeURIComponent(row.id);return{id:row.id,ownerType:row.ownerType,ownerId:row.ownerId,name:row.name,mediaType:row.mediaType,size:row.size,sha256:row.sha256,revision:row.revision,createdAt:row.createdAt,removedAt:row.removedAt,url,downloadUrl:url+'&download=1',markdown:markdown(row,url)};}
 async close(){this.closed=true;await Promise.allSettled([...this.pending]);await this.queue;}
}
