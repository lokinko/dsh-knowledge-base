import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const units=['test-note-storage.mjs','test-attachment-storage.mjs','test-note-edit-session.mjs','test-note-navigation.mjs','test-notes-store.mjs','test-note-edits.mjs','test-note-chats.mjs','test-independent-host.mjs'];
const integration=['test-textarea-metrics.mjs','test-unbounded-production.mjs','test-new-note-edit-flow.mjs','markdown-build/test-renderer.mjs'];
for(const args of [['--test','--test-reporter=spec',...units],...integration.map(name=>[name])]){const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
