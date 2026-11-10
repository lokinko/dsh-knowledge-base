import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url),cwd=fileURLToPath(root),manifest=JSON.parse(await fs.readFile(new URL('package.json',root),'utf8'));
await import('./sync-source.mjs');
for(const args of [['markdown-build/build-host.mjs'],['markdown-build/build.mjs','client.js',manifest.name]]){const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
