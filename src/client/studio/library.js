import {createCardMarkdown} from './preview.js';

export function createStudio({R,h,t,Icon,noteCategoryKey,noteTime,renderService}){
  const {CardMarkdown}=createCardMarkdown({R,h,t,renderService});
  // Presentation only. Notes, revisions, drafts and operations stay in the existing stores.
  function NoteLibraryCard({note,active=false,busy=false,onOpen,categoryLabel}){
    const icon=note.category==='reading'?'book':note.category==='code'?'code':note.category==='journal'?'calendar':'note';
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
        h(CardMarkdown,{source:note.excerpt,title:note.title}),
        tags.length>0&&h('div',{className:'nb-note-row-tags'},
          ...tags.slice(0,5).map(tag=>h('span',{key:tag,className:'badge rounded-pill'},'#'+tag)))));
  }

  return {NoteLibraryCard};
}
