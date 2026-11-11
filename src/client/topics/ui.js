import {TopicsController,topicReferenceKey} from './model.js';

export function createTopicsUI({R,h,t,Icon,Button,notebookRequest,CoauthorPanel}){
 function TopicsPage({slotProps,onOpenSource,onCreateNote}){
  const [controller]=R.useState(()=>new TopicsController(notebookRequest));
  const [state,setState]=R.useState(()=>controller.snapshot()),[chatOpen,setChatOpen]=R.useState(false),[confirmDelete,setConfirmDelete]=R.useState(false);
  const chatRef=R.useRef(null),revealChat=R.useRef(false),chatId=R.useId();
  R.useEffect(()=>{const unsubscribe=controller.subscribe(setState);controller.start();setState(controller.snapshot());return()=>{unsubscribe();controller.stop();};},[controller]);
  R.useEffect(()=>{revealChat.current=false;setChatOpen(false);setConfirmDelete(false);},[state.selectedId,state.libraryId]);
  R.useEffect(()=>{if(chatOpen&&revealChat.current){revealChat.current=false;chatRef.current?.scrollIntoView({block:'nearest'});}},[chatOpen]);
  function toggleChat(){revealChat.current=!chatOpen;setChatOpen(!chatOpen);}
  function closeChat(){revealChat.current=false;setChatOpen(false);}
  const topic=state.current,locked=state.busy||state.coauthorBusy,source=state.selectedSource,read=state.read;
  const sourceKey=source?topicReferenceKey(source.reference):null;
  const included=!!topic?.references.some(reference=>topicReferenceKey(reference)===sourceKey);
  const label=reference=>reference.label||t(reference.kind==='note'?'tpNoteSource':'tpDiscussionSource');
  const kind=reference=>t(reference.kind==='note'?'tpNoteSource':'tpDiscussionSource');
  const time=value=>{if(!value)return '';try{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString():String(value);}catch{return String(value);}};
  function submit(event,action){event.preventDefault();if(event.nativeEvent?.isComposing)return;void action();}
  function topicBusy(value,id,libraryId){if(controller.snapshot().current?.id===id&&controller.snapshot().libraryId===libraryId)controller.coauthorBusy(value);}
  const button=(text,onClick,disabled=false,className='')=>h('button',{type:'button',className:'em-btn btn btn-sm '+className,onClick,disabled},text);
  const error=state.error?h('div',{className:'tp-error',role:'alert'},h('p',null,t(state.error)),button(t('refresh'),()=>controller.refresh(),locked)):null;
  function referenceRow(reference,index){
   const key=topicReferenceKey(reference),active=sourceKey===key;
   return h('li',{key,className:'tp-reference'+(active?' is-selected':'')},
    h('button',{type:'button',className:'tp-reference-open','aria-pressed':active,onClick:()=>controller.readSource({reference,title:label(reference)})},h('small',null,kind(reference)),h('span',null,label(reference))),
    h('div',{className:'tp-reference-actions'},button(t('tpMoveUp'),()=>controller.references({kind:'move',reference,direction:-1}),locked||index===0,'tp-order'),button(t('tpMoveDown'),()=>controller.references({kind:'move',reference,direction:1}),locked||index===topic.references.length-1,'tp-order'),h('button',{type:'button',className:'tp-remove',disabled:locked,onClick:()=>controller.references({kind:'remove',reference}),'aria-label':t('tpRemoveSource')+' '+label(reference)},t('tpRemoveSource'))));
  }
  return h('section',{className:'tp-page','aria-label':t('tpTitle')},
   h('aside',{className:'tp-sidebar tm-bs'},h('header',{className:'tp-sidebar-heading'},h('h2',null,t('tpTitle')),h(Button,{icon:'refresh',label:t('refresh'),disabled:locked||state.loading,onClick:()=>controller.refresh()})),h('p',{className:'tp-intro'},t('tpIntro')),
    h('form',{className:'tp-new-form',onSubmit:event=>submit(event,()=>controller.create())},h('label',null,t('tpNewQuestion'),h('textarea',{rows:2,value:state.newQuestion,maxLength:500,required:true,disabled:locked||!state.libraryId,onChange:event=>controller.input('newQuestion',event.target.value),placeholder:t('tpQuestionPlaceholder')})),h('button',{type:'submit',className:'em-btn btn btn-primary',disabled:locked||!state.libraryId||!state.newQuestion.trim()},t('tpCreate'))),
    h('nav',{'aria-label':t('tpQuestions')},h('ul',{className:'tp-topic-list'},...state.topics.map(item=>h('li',{key:item.id},h('button',{type:'button',disabled:locked,'aria-current':state.selectedId===item.id?'page':undefined,className:'tp-topic-button'+(state.selectedId===item.id?' is-selected':''),onClick:()=>controller.open(item.id)},h('span',null,item.question),h('small',null,(item.referenceCount??item.references?.length??0)+' '+t('tpSourcesShort'))))))),
    !state.topics.length&&!state.loading&&h('p',{className:'tp-empty'},t('tpNoQuestions'))),
   h('div',{className:'tp-workspace'},error,state.notice&&h('p',{className:'tp-notice',role:'status'},t(state.notice)),state.loading&&h('p',{className:'tp-loading',role:'status'},t('loading')),
    topic?h(R.Fragment,null,
     h('header',{className:'tp-workspace-header tm-bs'},h('div',null,h('span',{className:'tp-eyebrow'},t('tpQuestion')),h('h1',null,topic.question)),h('div',{className:'tp-workspace-actions'},h('button',{type:'button',className:'em-btn btn btn-sm',disabled:state.busy,onClick:toggleChat,'aria-expanded':chatOpen,'aria-controls':chatId},t('tpCoauthor')),button(t('tpCreateBlankNote'),()=>onCreateNote?.(),locked),button(t('tpDelete'),()=>setConfirmDelete(value=>!value),locked))),
     confirmDelete&&h('div',{className:'tp-confirm tm-bs'},h('p',null,t('tpDeleteHint')),button(t('tpConfirmDelete'),()=>controller.delete(),locked),button(t('cancel'),()=>setConfirmDelete(false),locked)),
     h('form',{className:'tp-rename-form tm-bs',onSubmit:event=>submit(event,()=>controller.rename())},h('label',null,t('tpRename'),h('textarea',{rows:2,value:state.questionInput,maxLength:500,required:true,disabled:locked,onChange:event=>controller.input('questionInput',event.target.value)})),h('button',{type:'submit',className:'em-btn btn btn-sm',disabled:locked||!state.questionInput.trim()||state.questionInput.trim()===topic.question},t('save'))),
     h('div',{className:'tp-content'},h('div',{className:'tp-sources-column'},
      h('section',{className:'tp-saved-sources','aria-label':t('tpSelectedSources')},h('header',{className:'tp-section-heading'},h('h2',null,t('tpSelectedSources')),h('span',null,topic.references.length)),
       topic.references.length?h('ol',{className:'tp-reference-list'},...topic.references.map(referenceRow)):h('p',{className:'tp-empty'},t('tpNoSources')),
       state.candidate&&h('div',{className:'tp-candidate tm-bs'},h('p',null,t('tpPendingReference')),h('small',null,label(state.candidate.operation.reference)),button(t('tpRetryReference'),()=>controller.retryReferences(),locked))),
      h('section',{className:'tp-source-search','aria-label':t('tpFindSources')},h('h2',null,t('tpFindSources')),h('p',{className:'tp-help'},t('tpSearchHint')),
       h('form',{className:'tp-search-form tm-bs',onSubmit:event=>submit(event,()=>controller.search())},h('input',{type:'search',value:state.query,maxLength:1000,'aria-label':t('tpFindSources'),placeholder:t('tpSearchPlaceholder'),onChange:event=>controller.input('query',event.target.value)}),h('button',{type:'submit',className:'em-btn btn btn-sm',disabled:state.searching||!state.query.trim()},t('tpSearch'))),
       state.searching&&h('p',{role:'status'},t('loading')),!state.discussionAvailable&&h('p',{className:'tp-help'},t('tpDiscussionUnavailable')),
       h('ul',{className:'tp-result-list'},...state.results.map((result,index)=>h('li',{key:topicReferenceKey(result.reference)+':'+index},h('button',{type:'button',className:'tp-result'+(sourceKey===topicReferenceKey(result.reference)?' is-selected':''),onClick:()=>controller.readSource(result)},h('small',null,kind(result.reference),result.speaker?' · '+result.speaker:''),h('strong',null,result.title||label(result.reference)),result.heading&&h('span',{className:'tp-result-heading'},result.heading),h('p',null,result.snippet||''))))))),
     h('section',{className:'tp-source-reader','aria-label':t('tpOriginal')},source?h(R.Fragment,null,h('header',{className:'tp-reader-heading'},h('small',null,kind(source.reference)),h('h2',null,read?.title||source.title||label(source.reference)),h('div',{className:'tp-source-meta'},(read?.speaker||source.speaker)&&h('span',null,t('tpSpeaker')+': '+(read?.speaker||source.speaker)),(read?.time||source.time)&&h('time',null,time(read?.time||source.time)),h('span',null,source.reference.kind==='discussion'?source.reference.sessionId+' · #'+source.reference.seq:source.heading||t('tpNotePassage')))),
      state.reading&&h('p',{role:'status'},t('loading')),state.readError&&h('div',{className:'tp-error',role:'alert'},h('p',null,t(state.readError)),button(t('refresh'),()=>controller.readSource(source),state.reading)),
      read&&h(R.Fragment,null,h('pre',{className:'tp-original'},read.content),read.nextStart!=null&&button(t('tpReadMore'),()=>controller.readSource(source,true),state.reading),h('div',{className:'tp-reader-actions tm-bs'},button(t(included?'tpSourceAdded':'tpAddSource'),()=>controller.addSelected(),locked||included||state.reading||!!state.readError,'btn-primary'),source.reference.kind==='note'&&onOpenSource&&button(t('tpOpenNote'),()=>onOpenSource(source.reference),false)))):h('div',{className:'tp-reader-empty'},h(Icon,{name:'search',size:26}),h('h2',null,t('tpChooseSource')),h('p',null,t('tpReadBeforeAdd'))))),
     chatOpen&&h('div',{className:'tp-chat',id:chatId,ref:chatRef},h(CoauthorPanel,{key:state.libraryId+':'+topic.id,note:{id:topic.id,title:topic.question,trashedAt:null},scope:'topic',libraryId:state.libraryId,slotProps,disabled:state.busy,onBusyChange:value=>topicBusy(value,topic.id,state.libraryId),onTopicChange:updated=>controller.receiveTopic(updated,state.libraryId),onToggle:closeChat})))
    :!state.loading&&h('div',{className:'tp-workspace-empty'},h(Icon,{name:'book',size:32}),h('h1',null,t('tpStartTitle')),h('p',null,t('tpStartHint')),onCreateNote&&button(t('tpCreateBlankNote'),()=>onCreateNote(),false))));
 }
 return {TopicsPage};
}
