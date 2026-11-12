export function createCommonControls({R,h,t}){
  function Icon({name='matrix',size=18}){
   if(name==='type')return h('span',{className:'em-type-icon','aria-hidden':true},'Aa');
   const paths={focus:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',unfocus:'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',chat:'M4 4h16v11H9l-5 5z',search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',chevron:'m9 5 7 7-7 7',list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',folder:'M3 7V5h6l2 2h10v13H3z',book:'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4zM20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h3z',pin:'m9 3 6 0-1 6 4 4v2h-5v6h-2v-6H6v-2l4-4z',history:'M3 4v5h5M3 9a9 9 0 1 1 1 9M12 7v5l3 2',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',upload:'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',code:'m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',grip:'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',calendar:'M8 3v4m8-4v4M4 10h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1z',clock:'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',matrix:'M3 3h18v18H3zM12 3v18M3 12h18',plus:'M12 5v14M5 12h14',refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',back:'m14 6-6 6 6 6',check:'m5 12 4 4L19 6',trash:'M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7m4-7v7',close:'m6 6 12 12M6 18 18 6',settings:'M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1M15 4v4M9 10v4M17 16v4',note:'M5 3h14v18H5zM8 8h8m-8 4h8m-8 4h5'};
   return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[name]||paths.matrix}));
  }
  function Button({icon,label,onClick,disabled=false,pressed,expanded,controls,className=''}){
    return h('button',{
      type:'button',className:'em-icon btn btn-sm '+className,
      title:label,'aria-label':label,'aria-pressed':pressed,'aria-expanded':expanded,'aria-controls':controls,onClick,disabled
    },h(Icon,{name:icon}));
  }
return {Icon,Button};
}
