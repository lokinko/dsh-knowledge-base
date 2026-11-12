export function createNoteSettings({R,h,t,Icon,Button,NoteStorageSettings}){
const families={system:'fontSystem',sans:'fontSans',serif:'fontSerif',mono:'fontMono'};
const layouts=[['grid','nbGrid','matrix'],['list','nbList','list']];
const sections=[
 {id:'appearance',label:'nbSettingsAppearance',hint:'nbSettingsAppearanceHint',icon:'type'},
 {id:'storage',label:'nbStorageTitle',hint:'nbStorageSubtitle',icon:'folder'},
];
function AppearanceSettings({appearance,onAppearanceChange,layout,onLayoutChange}){
 const update=patch=>onAppearanceChange({fontFamily:appearance.fontFamily,fontSize:appearance.fontSize,...patch});
 return h('div',{className:'nb-settings-panel'},
  h('section',{className:'nb-settings-group'},
   h('div',{className:'nb-settings-group-head'},
    h('h4',null,t('typography')),
    h('button',{type:'button',className:'em-btn btn btn-sm',onClick:()=>update({fontFamily:'sans',fontSize:15})},t('fontDefault'))),
   h('div',{className:'em-font-controls'},
    h('label',{className:'em-font-field'},
     h('span',null,t('fontStyle')),
     h('select',{className:'em-font-select form-select form-select-sm',value:appearance.fontFamily,onChange:e=>update({fontFamily:e.target.value})},
      ...Object.entries(families).map(([id,label])=>h('option',{key:id,value:id},t(label))))),
    h('label',{className:'em-font-field'},
     h('span',{className:'em-font-label'},h('span',null,t('fontSize')),h('output',{className:'em-font-value'},appearance.fontSize+' px')),
     h('input',{type:'range',className:'em-font-range',min:13,max:20,step:1,value:appearance.fontSize,'aria-label':t('fontSize'),onChange:e=>update({fontSize:Number(e.target.value)})}))),
   h('p',{className:'em-font-preview'},t('fontPreview'))),
  h('section',{className:'nb-settings-group'},
   h('div',{className:'nb-settings-group-head'},h('h4',null,t('nbLayout'))),
   h('div',{className:'nb-settings-segment',role:'group','aria-label':t('nbLayout')},
    ...layouts.map(([id,label,icon])=>h('button',{key:id,type:'button','aria-pressed':layout===id,onClick:()=>onLayoutChange(id)},h(Icon,{name:icon,size:15}),h('span',null,t(label)))))));
}
function NoteSettings({section,onSectionChange,onClose,storage,...appearance}){
 const dialog=R.useRef(null),headingId=R.useId();
 const [applying,setApplying]=R.useState(false),applyingRef=R.useRef(false);applyingRef.current=applying;
 R.useEffect(()=>{
  const node=dialog.current,previous=node?.ownerDocument.activeElement;
  if(node&&!node.open)node.showModal();
  return()=>{if(node?.open)node.close();if(previous?.isConnected)previous.focus({preventScroll:true});};
 },[]);
 function close(){if(!applyingRef.current)onClose();}
 const current=sections.find(item=>item.id===section)||sections[0];
 return h('dialog',{ref:dialog,className:'nb-settings-dialog tm-bs','aria-labelledby':headingId,'aria-busy':applying,onCancel:event=>{event.preventDefault();close();}},
  h('header',{className:'nb-settings-header'},
   h('h2',{id:headingId},h(Icon,{name:'settings',size:18}),t('nbSettings')),
   h(Button,{icon:'close',label:t('close'),onClick:close,disabled:applying,className:'nb-settings-close'})),
  h('div',{className:'nb-settings-layout'},
   h('nav',{className:'nb-settings-nav','aria-label':t('nbSettings')},
    ...sections.map(item=>h('button',{key:item.id,type:'button',className:'nb-settings-tab','aria-current':current.id===item.id?'page':undefined,disabled:applying,onClick:()=>onSectionChange(item.id)},
     h(Icon,{name:item.icon,size:15}),h('span',null,t(item.label))))),
   h('div',{className:'nb-settings-content'},
    h('div',{className:'nb-settings-content-head'},h('h3',null,t(current.label)),h('p',null,t(current.hint))),
    current.id==='storage'?h(NoteStorageSettings,{...storage,onClose:close,onApplyingChange:setApplying}):h(AppearanceSettings,appearance))));
}
return {NoteSettings};
}
