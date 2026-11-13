export function createCardMarkdown({R,h,t,renderService}){
 // Keep only recent, bounded HTML results across list/editor navigation.
 const cache=new Map();let units=0;
 function cached(key){const entry=cache.get(key);if(!entry)return null;cache.delete(key);cache.set(key,entry);return entry.html;}
 function remember(key,html){
  const size=key.length+html.length;if(size>256000)return;
  const previous=cache.get(key);if(previous){units-=previous.size;cache.delete(key);}
  while(cache.size&&(cache.size>=48||units+size>256000)){const oldest=cache.keys().next().value;units-=cache.get(oldest).size;cache.delete(oldest);}
  cache.set(key,{html,size});units+=size;
 }
 function CardMarkdown({source='',title=''}){
  source=String(source||'').slice(0,1600);const key=JSON.stringify([source,title]);
  const node=R.useRef(null),consumer=R.useRef({});
  const [visible,setVisible]=R.useState(false),[result,setResult]=R.useState(()=>{const html=cached(key);return html===null?null:{key,html};}),[error,setError]=R.useState(null);
  const ready=result?.key===key;
  R.useEffect(()=>{
   const element=node.current,Observer=globalThis.IntersectionObserver;
   if(!element)return;if(!Observer){setVisible(true);return;}
   const observer=new Observer(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{root:element.closest('.nb-note-list'),rootMargin:'160px'});
   observer.observe(element);return()=>observer.disconnect();
  },[]);
  R.useEffect(()=>{
   if(ready||!visible)return;const html=cached(key);
   if(html!==null){setResult({key,html});return;}
   let active=true;const win=node.current.ownerDocument.defaultView;
   const render=()=>{renderService.card(source,{title,consumer:consumer.current}).then(html=>{
    if(active){remember(key,html);setResult({key,html});}
   }).catch(cause=>{if(active&&cause.name!=='AbortError')setError(key);});};
   const idle=typeof win.requestIdleCallback==='function',timer=idle?win.requestIdleCallback(render,{timeout:200}):win.setTimeout(render,0);
   return()=>{active=false;if(idle)win.cancelIdleCallback(timer);else win.clearTimeout(timer);renderService.cancel(consumer.current);};
  },[key,visible,ready]);
  const props={ref:node,className:'nb-note-excerpt em-markdown nb-card-markdown','aria-busy':!ready&&error!==key,'data-card-preview-state':ready?'ready':error===key?'error':'loading'};
  if(ready&&result.html)return h('div',{...props,dangerouslySetInnerHTML:{__html:result.html}});
  return h('div',props,ready?t('nbBlank'):error===key?t('nbError'):h('span',{className:'nb-card-placeholder','aria-hidden':true}));
 }
 return {CardMarkdown};
}
