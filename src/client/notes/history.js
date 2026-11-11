export function createNotesHistory({R,h,t,Button,MarkdownPreview,notesRequest,noteTime}){
function NotesHistory({note,session,onClose,onReplace}){
 const dialog=R.useRef(null),sequence=R.useRef(0);const [versions,setVersions]=R.useState([]),[selected,setSelected]=R.useState(null),[error,setError]=R.useState(''),[busy,setBusy]=R.useState(false),[confirm,setConfirm]=R.useState(false);
 R.useEffect(()=>{let active=true;dialog.current.showModal();notesRequest({action:'versions',id:note.id,limit:50}).then(data=>{if(active)setVersions(data.versions);}).catch(()=>{if(active)setError('nbError');});return()=>{active=false;sequence.current++;dialog.current?.close();};},[]);
 async function choose(version){const current=++sequence.current;setError('');setConfirm(false);setSelected(null);try{const result=await notesRequest({action:'version',id:note.id,versionId:version.versionId});if(current===sequence.current)setSelected(result.version);}catch{if(current===sequence.current)setError('nbError');}}
 async function restore(){if(!selected||busy)return;setBusy(true);setError('');try{if(!await session.flush())throw new Error();await notesRequest({action:'restore_version',id:note.id,revision:session.snapshot().baseRevision,versionId:selected.versionId});const latest=await notesRequest({action:'get',id:note.id});session.abandon();onReplace(latest.note);onClose();}catch{setError('nbRestoreFailed');}finally{setBusy(false);}}
 return h('dialog',{
    ref:dialog,className:'nb-history-dialog tm-bs','aria-label':t('nbHistory'),
    onCancel:e=>{e.preventDefault();if(!busy)onClose();}
  },
    h('header',{className:'nb-history-head'},
      h('div',null,h('h2',null,t('nbHistory')),h('span',null,t('nbHistoryHint'))),
      h(Button,{icon:'close',label:t('close'),disabled:busy,onClick:onClose})),
    h('div',{className:'nb-history-layout'},
      h('aside',{className:'nb-versions'},
        versions.length?versions.map(version=>h('button',{
          key:version.versionId,type:'button',
          className:'nb-version'+(selected?.versionId===version.versionId?' is-active':''),
          'aria-pressed':selected?.versionId===version.versionId,
          onClick:()=>choose(version),disabled:busy
        },
          h('strong',null,version.title||t('nbUntitled')),
          h('span',null,noteTime(version.savedAt)),
          h('small',null,'v'+version.revision+' · '+version.contentLength+' '+t('nbChars')))):
          h('p',{className:'nb-muted'},t('nbNoVersions'))),
      h('section',{className:'nb-version-preview'},
        error&&h('p',{className:'nb-warning',role:'alert'},t(error)),
        selected?h(MarkdownPreview,{value:selected.content,busy:true,onChange:()=>{},label:t('nbVersionPreview')}):
          h('p',{className:'nb-muted'},t('nbChooseVersion')))),
    h('footer',{className:'nb-history-foot'},
      confirm?h(R.Fragment,null,
        h('span',null,t('nbConfirmRestore')),
        h('button',{type:'button',className:'em-btn em-save btn btn-sm btn-primary',disabled:busy,onClick:restore},t('nbRestoreVersion')),
        h('button',{type:'button',className:'em-btn btn btn-sm',disabled:busy,onClick:()=>setConfirm(false)},t('cancel'))):
        h('button',{type:'button',className:'em-btn em-save btn btn-sm btn-primary',disabled:busy||!selected||!!note.trashedAt,onClick:()=>setConfirm(true)},t('nbRestoreVersion'))));
}
return {NotesHistory};
}
