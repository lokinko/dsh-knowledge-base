export function createDirectoryPicker({R,h,t,Icon,notebookRequest}){
 function DirectoryPicker({initialDirectory,onSelect,onClose}){
  const [listing,setListing]=R.useState(null),[address,setAddress]=R.useState(initialDirectory||''),[loading,setLoading]=R.useState(true),[error,setError]=R.useState('');
  const active=R.useRef(false),generation=R.useRef(0),addressInput=R.useRef(null),titleId=R.useId();
  async function load(directory,offset=0){
   const token=++generation.current;setLoading(true);setError('');
   try{
    const next=await notebookRequest('/api/dsh-note/note-storage-directories',{directory,offset});
    if(!active.current||token!==generation.current)return;
    setListing(previous=>offset&&previous?.directory===next.directory?{...next,entries:[...previous.entries,...next.entries]}:next);
    setAddress(next.directory);
   }catch(problem){if(active.current&&token===generation.current)setError(problem.message||t('nbStorageBrowseError'));}
   finally{if(active.current&&token===generation.current)setLoading(false);}
  }
  R.useEffect(()=>{active.current=true;void load(initialDirectory||'');addressInput.current?.focus({preventScroll:true});return()=>{active.current=false;generation.current++;};},[]);
  R.useEffect(()=>{if(!loading)addressInput.current?.focus({preventScroll:true});},[loading]);
  const canChoose=!loading&&!error&&listing&&address.trim()===listing.directory;
  function go(){if(!loading)void load(address.trim());}
  return h('section',{className:'nb-folder-picker',role:'group','aria-labelledby':titleId,'aria-busy':loading,onKeyDown:event=>{
   if(event.nativeEvent?.isComposing||event.keyCode===229)return;
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}
  }},
   h('div',{className:'nb-storage-section-heading'},h('h3',{id:titleId},t('nbStorageChooseFolder')),h('button',{type:'button',className:'btn btn-sm',onClick:onClose,'aria-label':t('close')},h(Icon,{name:'close',size:13}))),
   h('p',{className:'nb-storage-hint'},t('nbStorageBrowseHint')),
   h('div',{className:'nb-folder-address-row'},h('input',{ref:addressInput,type:'text',className:'form-control nb-folder-address',value:address,disabled:loading,'aria-label':t('nbStorageBrowseAddress'),spellCheck:false,onChange:event=>setAddress(event.target.value),onKeyDown:event=>{
    if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if(!event.nativeEvent?.isComposing&&event.keyCode!==229)go();}
   }}),h('button',{type:'button',className:'btn btn-sm',disabled:loading||!address.trim(),onClick:go},t('nbStorageBrowseGo'))),
   h('div',{className:'nb-folder-navigation'},h('button',{type:'button',className:'btn btn-sm',disabled:loading||!listing?.parent,onClick:()=>load(listing.parent)},h(Icon,{name:'back',size:12}),t('nbStorageBrowseParent')),
    listing&&h('select',{className:'form-select form-select-sm','aria-label':t('nbStorageBrowseLocations'),value:'',disabled:loading,onChange:event=>{if(event.target.value)void load(event.target.value);}},h('option',{value:''},t('nbStorageBrowseLocations')),h('option',{value:listing.home},t('nbStorageBrowseHome')),...listing.roots.map(root=>h('option',{key:root,value:root},root)))),
   error&&h('div',{className:'nb-storage-message is-error',role:'alert'},h('p',null,t('nbStorageBrowseError')),h('pre',null,error)),
   h('div',{className:'nb-folder-list','aria-label':t('nbStorageBrowseFolders')},loading&&!listing?h('p',{role:'status'},t('loading')):
    listing?.entries.length?listing.entries.map(entry=>h('button',{key:entry.directory,type:'button',className:'nb-folder-entry',disabled:loading,onClick:()=>load(entry.directory)},h(Icon,{name:'folder',size:15}),h('span',null,entry.name))):!loading&&!error&&h('p',null,t('nbStorageBrowseEmpty'))),
   listing?.hasMore&&h('button',{type:'button',className:'btn btn-sm',disabled:loading,onClick:()=>load(listing.directory,listing.entries.length)},t('nbStorageBrowseMore')),
   h('div',{className:'nb-folder-footer'},h('code',null,listing?.directory||''),h('button',{type:'button',className:'btn btn-sm',onClick:onClose},t('nbStorageBrowseCancel')),h('button',{type:'button',className:'btn btn-sm btn-primary',disabled:!canChoose,onClick:()=>onSelect(listing.directory)},t('nbStorageBrowseSelect'))));
 }
 return {DirectoryPicker};
}
