export function createStudio({h,t,Icon,noteCategoryKey,noteTime}){
  // Presentation only. Notes, revisions, drafts and operations stay in the existing stores.
  function notebookTeaser(value){
    return String(value||'').replace(/!\[[^\]]*\]\([^)]*(?:\)|$)/g,'').replace(/\[([^\]]+)\]\([^)]*(?:\)|$)/g,'$1').replace(/```[^\n]*\n?|```/g,' ').replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s*)?)/gm,'').replace(/[`*_~]/g,'').replace(/\s+/g,' ').trim();
  }

  function NotebookHero({counts={},total,loading}){
    return h('p',{className:'nb-library-summary',role:'status'},
      loading&&counts.all==null?t('loading'):
        Number(total??counts.all??0).toLocaleString()+' '+t('nbStudioTotal')+' · '+t('nbCollectionHint'));
  }

  function NoteLibraryCard({note,active=false,busy=false,onOpen,categoryLabel}){
    const icon=note.category==='reading'?'book':note.category==='code'?'code':note.category==='journal'?'calendar':'note';
    const teaser=notebookTeaser(note.excerpt);
    const tags=Array.isArray(note.tags)?note.tags:[];
    return h('button',{
      type:'button',
      className:'nb-note-row card nb-note-'+note.category+(active?' is-active':''),
      disabled:busy,onClick:onOpen,
      title:note.title||t('nbUntitled'),
      'aria-label':t('nbStudioOpen')+' · '+(note.title||t('nbUntitled')),
      'aria-pressed':active
    },
      h('span',{className:'nb-note-row-icon','aria-hidden':true},h(Icon,{name:icon,size:18})),
      h('div',{className:'nb-note-row-main'},
        h('div',{className:'nb-note-row-topline'},
          h('div',{className:'nb-card-eyebrow'},
            h('span',null,categoryLabel?categoryLabel(note.category):t(noteCategoryKey[note.category]||'nbDocument')),
            note.pinned&&h('span',{className:'nb-card-flag'},h(Icon,{name:'pin',size:12}),t('nbPinned'))),
          h('div',{className:'nb-note-row-meta'},
            h('time',{dateTime:note.updatedAt},noteTime(note.updatedAt)),
            h('span',null,Number(note.contentLength||0).toLocaleString()+' '+t('nbChars')))),
        h('strong',{className:'nb-note-row-title'},note.title||t('nbUntitled')),
        h('p',{className:'nb-note-excerpt'},teaser||t('nbBlank')),
        tags.length>0&&h('div',{className:'nb-note-row-tags'},
          ...tags.slice(0,5).map(tag=>h('span',{key:tag,className:'badge rounded-pill'},'#'+tag)))));
  }

  return {NotebookHero,NoteLibraryCard};
}
