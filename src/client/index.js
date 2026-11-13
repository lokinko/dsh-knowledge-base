import {dictionaries} from './labels/index.js';
import {workspaceCss} from './styles/index.js';
import {createCommonControls} from './controls/common.js';
import {createAutoTextarea} from './controls/auto-textarea.js';
import {createMarkdownField} from './markdown/field.js';
import {createNotesServices} from './notes/services.js';
import {createNotesUI} from './notes/ui.js';
import {createCoauthor} from './coauthor/ui.js';
import {createAttachments} from './attachments/ui.js';
import {createStorageSettings} from './storage/ui.js';
import {createNoteSettings} from './settings/ui.js';
import {createStudio} from './studio/library.js';
import {createCategoriesUI} from './categories/index.js';
import {createDirectoryNavigation} from './navigation/index.js';
import {createCommandMenus} from './controls/command-menu.js';
import {createTopicsUI} from './topics/ui.js';

window.__ModuleLoader__.load({
  id:__TODO_MODULE_ID__,
  factory(require){
    const R=require('react'),h=R.createElement;
    const defaultAppearance={fontFamily:'sans',fontSize:15,revision:0};
    const fontStacks={system:'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',sans:'Inter, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',serif:'"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, Georgia, serif',mono:'"Cascadia Code", "SFMono-Regular", Consolas, "Microsoft YaHei", monospace'};

    return {inject:['slots','locale','layout','sessions'],apply(ctx){
      for(const [id,dict] of Object.entries(dictionaries))ctx.effect(()=>ctx.locale.register('dshNote',id,dict));
      const t=ctx.locale.bind('dshNote');
      const subscribe=fn=>ctx.locale.subscribe(fn),snapshot=()=>ctx.locale.getSnapshot();
      const common=createCommonControls({R,h,t}),{Icon,Button}=common;
      const controls=createAutoTextarea({R,h}),{AutoTextarea}=controls;
      const markdown=createMarkdownField({R,h,t,ctx,...controls});
      const services=createNotesServices({ctx,t});
      const categoryUI=createCategoriesUI({R,h,t,...common,...services});
      const directoryUI=createDirectoryNavigation({R,h,t,...common});
      const commandUI=createCommandMenus({R,h,t,...common,...services});
      const coauthor=createCoauthor({R,h,t,ctx,...common,...services});
      const {NativeCoauthor,ContextSearchPage}=coauthor;
      const {TopicsPage}=createTopicsUI({R,h,t,...common,...services,...coauthor});
      const attachments=createAttachments({R,h,t,Icon});
      const storage=createStorageSettings({R,h,t,...common,...services});
      const settings=createNoteSettings({R,h,t,...common,...storage});
      const studio=createStudio({R,h,t,Icon,...services,renderService:markdown.renderService});
      const {NotesWorkspace}=createNotesUI({R,h,t,...common,...controls,...markdown,...services,...categoryUI,...directoryUI,...commandUI,...coauthor,...attachments,...settings,...studio});

      function Page(slotProps){
        R.useSyncExternalStore(subscribe,snapshot,snapshot);
        const [searchOpen,setSearchOpen]=R.useState(false),[topicsOpen,setTopicsOpen]=R.useState(false);
        const [createToken,setCreateToken]=R.useState(0),[topicsVisited,setTopicsVisited]=R.useState(false);
        const [requestedNoteId,setRequestedNoteId]=R.useState(null);
        const [appearance,setAppearance]=R.useState(()=>{
          try{
            const saved=JSON.parse(localStorage.getItem('dsh-note.appearance.v1')||'null');
            if(saved&&fontStacks[saved.fontFamily]&&Number.isInteger(saved.fontSize)&&saved.fontSize>=13&&saved.fontSize<=20)return saved;
          }catch{}
          return defaultAppearance;
        });
        function changeAppearance(next){
          setAppearance(next);
          try{localStorage.setItem('dsh-note.appearance.v1',JSON.stringify(next));}catch{}
        }
        function openSource(ref){
          if(ref?.kind==='note'&&ref.atomId?.startsWith('ctx1:')){try{ref=JSON.parse(decodeURIComponent(ref.atomId.slice(5)));}catch{return;}}
          if(ref?.source!=='note'||!ref.id)return;
          setTopicsOpen(false);
          setRequestedNoteId(ref.id);
          setSearchOpen(false);
        }
        return h('section',{
          className:'em-page nb-notes-page dn-workspace nb-glass',spellCheck:false,
          'aria-label':t('nbTitle'),
          style:{'--em-font-scale':appearance.fontSize/14,'--nb-content-font':fontStacks[appearance.fontFamily]||fontStacks.sans,fontFamily:fontStacks[appearance.fontFamily]||fontStacks.sans}
        },
          h('style',null,workspaceCss),
          h('header',{className:'nb-workspace-bar tm-bs'},
            h('div',{className:'nb-workspace-brand'},
              h('h1',{className:'nb-page-title'},h(Icon,{name:'book',size:19}),t('nbTitle')),
              h('span',{className:'nb-brand-caption'},'DSH')),
            h('div',{className:'nb-workspace-tabs',role:'group','aria-label':t('nbWorkspaceNavigation')},
              h('button',{type:'button',className:'nb-workspace-tab','aria-label':t('nbLibraryTab'),'aria-pressed':!searchOpen&&!topicsOpen,title:t('nbLibraryTab'),onClick:()=>{setSearchOpen(false);setTopicsOpen(false);}},
                h(Icon,{name:'book',size:16}),h('span',null,t('nbLibraryTab'))),
              h('button',{type:'button',className:'nb-workspace-tab','aria-label':t('contextTab'),'aria-pressed':searchOpen,title:t('contextTab'),onClick:()=>{setTopicsOpen(false);setSearchOpen(true);}},
                h(Icon,{name:'search',size:16}),h('span',null,t('contextTab'))),
              h('button',{type:'button',className:'nb-workspace-tab','aria-label':t('tpTitle'),'aria-pressed':topicsOpen,title:t('tpTitle'),onClick:()=>{setSearchOpen(false);setTopicsVisited(true);setTopicsOpen(true);}},h(Icon,{name:'list',size:16}),h('span',null,t('tpTitle')))),
            h('div',{className:'nb-page-actions'},
              h('button',{type:'button',className:'em-btn btn btn-sm nb-back-chat',title:t('back'),'aria-label':t('back'),onClick:()=>ctx.layout.selectPanel(null)},
                h(Icon,{name:'back',size:15}),h('span',null,t('backChat'))))),
          h('div',{className:'nb-page-library',hidden:searchOpen||topicsOpen,style:{display:searchOpen||topicsOpen?'none':'flex',flex:1,minHeight:0,minWidth:0}},
            h(NotesWorkspace,{appearance,onAppearanceChange:changeAppearance,slotProps,initialNoteId:requestedNoteId,onInitialConsumed:()=>setRequestedNoteId(null),initialCreateToken:createToken,onInitialCreateConsumed:()=>setCreateToken(0)})),
          searchOpen&&h(ContextSearchPage,{onOpenSource:openSource}),
          topicsVisited&&h('div',{hidden:!topicsOpen,style:{display:topicsOpen?'flex':'none',flex:1,minHeight:0,minWidth:0}},h(TopicsPage,{slotProps,onOpenSource:openSource,onCreateNote:()=>{setTopicsOpen(false);setSearchOpen(false);setCreateToken(value=>value+1);}})));
      }

      ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'dsh-note',order:5,label:()=>t('nbTitle')},()=>h(Icon,{name:'book'})));
      ctx.slots.inject('main',()=>{
        const page=ctx.slots.register({name:'main',key:'dsh-note',children:{'dsh-note.coauthor':{kind:'single',scope:'session'}}},Page);
        const chat=ctx.slots.register({name:'dsh-note.coauthor'},NativeCoauthor);
        return ()=>{chat();page();};
      });
    }};
  }
});
