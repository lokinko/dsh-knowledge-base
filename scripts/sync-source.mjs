import fs from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const read=async name=>(await fs.readFile(new URL(name,root),'utf8')).replaceAll('\r\n','\n');
let source=await read('client.source.js');
function region(name,value){
 const start='// @generated-'+name+':start\n',end='// @generated-'+name+':end';
 const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
 if(a<0||b<0||source.indexOf(start,a+start.length)>=0)throw new Error('Missing or duplicate source region: '+name);
 source=source.slice(0,a+start.length)+value+'\n'+source.slice(b);
}
const labelStart=source.indexOf('const dictionaries=')+'const dictionaries='.length,labelEnd=source.indexOf(';\n// @generated-labels:end',labelStart);
if(labelStart<'const dictionaries='.length||labelEnd<0)throw new Error('Missing note dictionaries');
const dictionaries=JSON.parse(source.slice(labelStart,labelEnd));
for(const name of ['notes-labels.json','note-storage-labels.json','notebook-studio-labels.json','attachment-labels.json']){
 const catalog=JSON.parse(await read(name));for(const language of ['zh','en'])Object.assign(dictionaries[language],catalog[language]);
}
for(const language of ['zh','en'])for(const key of ['taskWorkspaceHint','contextTasks','contextProgress','contextAll','progressExpand','progressCollapse','attTaskLimit','attSaveTask'])delete dictionaries[language][key];
Object.assign(dictionaries.zh,{nbWorkspaceTitle:'笔记',coauthorHint:'使用 DSH 中的模型共同整理、续写和修改这篇笔记。模型可以按需检索笔记；修改完成后会同步到编辑区。',contextTitle:'检索笔记',contextHint:'从笔记标题和正文段落中查找内容，保留来源，再按需阅读。',fontHint:'即时预览，保存后应用于笔记阅读与编辑。',fontPreview:'把值得留下的内容，放在这里。',nbStoragePreserve:'应用会在所选目录的 dsh-notebook 文件夹中管理笔记、历史版本、对话关联及笔记附件。切换时保留笔记 ID、搜索内容和附件引用，并保留原位置的数据作为备份。需要 Markdown 文件时，可使用笔记导出。'});
Object.assign(dictionaries.en,{nbWorkspaceTitle:'Notes',coauthorHint:'Use your DSH model to organize, extend and revise this note. It can retrieve relevant note passages as needed. Completed edits appear in the editor.',contextTitle:'Search notes',contextHint:'Find note titles and passages with their sources, then read what is relevant.',fontHint:'Preview now; save to apply to note reading and editing.',fontPreview:'Keep the things worth remembering.',nbStoragePreserve:'The application manages notes, history, conversation links and note attachments in a dsh-notebook folder inside your chosen directory. Switching preserves note IDs, searchable content and attachment references, and keeps source copies. Use note export when you need Markdown files.'});
region('labels','const dictionaries='+JSON.stringify(dictionaries)+';');
const styles=(await Promise.all(['client-base.css','notes.css','coauthor.css','quiet-ui.css','notebook-studio.css','note-storage-ui.css','attachment-ui.css'].map(read))).join('\n');
region('styles',"const workspaceCss=__TODO_BOOTSTRAP_CSS__.replaceAll('.tm-bs',':is(.dn-workspace.tm-bs,.dn-workspace .tm-bs)')+__TODO_KATEX_CSS__.replaceAll('.em-markdown','.dn-workspace .em-markdown')+"+JSON.stringify(styles)+';');
region('controls',(await Promise.all(['auto-textarea.js','markdown-field.js'].map(read))).join('\n'));
region('components',(await Promise.all(['coauthor-ui.js','notes-ui.js','note-storage-ui.js','notebook-studio.js','attachment-ui.js'].map(read))).join('\n'));
if(/\b(?:DraftCache|normalizeDraft|orderedTasks|useCardDrag|Checklist|WorkspaceTabs)\b|\/api\/dsh-todo|dsh\.todo-manager\.workspace/.test(source))throw new Error('Cross-business code found in note client');
await fs.writeFile(new URL('client.source.js',root),source);
console.log('Synchronized note-only controls, notebook, native coauthoring, attachments, labels and dn-workspace styles.');
