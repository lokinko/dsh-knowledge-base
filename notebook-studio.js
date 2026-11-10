// Presentation only. Notes, revisions, drafts and operations stay in the existing stores.
function notebookTeaser(value){
 return String(value||'').replace(/!\[[^\]]*\]\([^)]*(?:\)|$)/g,'').replace(/\[([^\]]+)\]\([^)]*(?:\)|$)/g,'$1').replace(/```[^\n]*\n?|```/g,' ').replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s*)?)/gm,'').replace(/[`*_~]/g,'').replace(/\s+/g,' ').trim();
}
function NotebookHero({counts,loading,busy,onCreate,onImport,onCategory}){
 const metrics=[['document','nbDocument','note'],['reading','nbReading','book'],['code','nbCode','code'],['journal','nbJournal','calendar']];
 return h('section',{className:'nb-studio-hero','aria-label':t('nbStudioOverview')},
  h('div',{className:'nb-studio-intro'},
   h('span',{className:'nb-studio-eyebrow'},'DSH NOTEBOOK'),
   h('h1',null,t('nbStudioTitle')),h('p',null,t('nbStudioSubtitle')),
   h('div',{className:'nb-studio-actions'},h('button',{type:'button',className:'btn btn-primary',disabled:busy,onClick:onCreate},h(Icon,{name:'plus',size:16}),t('nbNew')),h('button',{type:'button',className:'btn',disabled:busy,onClick:onImport},h(Icon,{name:'upload',size:15}),t('nbImport'))),
   h('div',{className:'nb-studio-art','aria-hidden':true},h('span',null),h('span',null),h('span',null))),
  h('div',{className:'nb-studio-summary'},h('div',{className:'nb-studio-total'},h('strong',null,loading&&counts.all==null?'—':Number(counts.all||0).toLocaleString()),h('span',null,t('nbStudioTotal'))),
   h('div',{className:'nb-studio-metrics'},...metrics.map(([category,label,icon])=>h('button',{key:category,type:'button',className:'nb-studio-metric nb-tone-'+category,onClick:()=>onCategory(category),'aria-label':t(label)+' · '+(counts[category]||0)},h(Icon,{name:icon,size:15}),h('span',null,t(label)),h('strong',null,loading&&counts[category]==null?'—':Number(counts[category]||0).toLocaleString()))))));
}
function NoteLibraryCard({note,featured=false,active=false,busy=false,onOpen}){
 const icon=note.category==='reading'?'book':note.category==='code'?'code':note.category==='journal'?'calendar':'note';
 const teaser=notebookTeaser(note.excerpt),tags=Array.isArray(note.tags)?note.tags:[];
 return h('button',{type:'button',className:'nb-note-row card nb-note-'+note.category+(featured?' is-featured':'')+(active?' is-active':''),disabled:busy,onClick:onOpen,title:note.title||t('nbUntitled'),'aria-label':t('nbStudioOpen')+' · '+(note.title||t('nbUntitled'))},
  h('span',{className:'nb-note-row-icon','aria-hidden':true},h(Icon,{name:icon,size:21})),
  h('div',{className:'nb-note-row-main'},
   h('div',{className:'nb-card-eyebrow'},h('span',null,t(noteCategoryKey[note.category]||'nbDocument')),note.pinned?h('span',{className:'nb-card-flag'},h(Icon,{name:'pin',size:12}),t('nbPinned')):featured&&h('span',{className:'nb-card-flag'},t('nbStudioRecent'))),
   h('strong',{className:'nb-note-row-title'},note.title||t('nbUntitled')),
   h('p',{className:'nb-note-excerpt'},teaser||t('nbBlank')),
   tags.length>0&&h('div',{className:'nb-note-row-tags'},...tags.slice(0,3).map(tag=>h('span',{key:tag,className:'badge rounded-pill'},'#'+tag)))),
  h('div',{className:'nb-note-row-meta'},h('time',{dateTime:note.updatedAt},noteTime(note.updatedAt)),h('span',null,Number(note.contentLength||0).toLocaleString()+' '+t('nbChars'))),
  featured&&h('div',{className:'nb-card-art','aria-hidden':true},h(Icon,{name:icon,size:94})));
}
