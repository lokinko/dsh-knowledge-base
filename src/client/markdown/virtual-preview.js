import {renderDocument,setMarkdownTaskAt} from './renderer.js';
import {createRenderService,ASYNC_MARKDOWN_THRESHOLD} from './render-service.js';

export function previewOffsets(blocks,measurements=new Map()){
  const offsets=[0];
  for(let index=0;index<blocks.length;index++)offsets.push(offsets.at(-1)+Math.max(1,measurements.get(index)??blocks[index].heightEstimate??48));
  return offsets;
}
function blockAt(offsets,position){
  let low=0,high=Math.max(0,offsets.length-2);
  while(low<high){const middle=Math.floor((low+high)/2);if(offsets[middle+1]<=position)low=middle+1;else high=middle;}
  return low;
}
export function previewWindow(offsets,top,height,{overscan=800,maxBlocks=80,forcedIndex=null}={}){
  const count=offsets.length-1;
  if(!count)return {start:0,end:0,before:0,after:0};
  let start=blockAt(offsets,Math.max(0,top-overscan));
  let end=Math.min(count,blockAt(offsets,Math.max(0,top+height+overscan))+1);
  if(forcedIndex!==null){start=Math.max(0,Math.min(count-1,forcedIndex)-2);end=Math.min(count,start+12);}
  end=Math.min(end,start+maxBlocks);
  return {start,end,before:offsets[start],after:offsets[count]-offsets[end]};
}

export function createAsyncMarkdown({R,h,t,fieldScrollRoot,ctx,renderService=createRenderService()}){
  ctx?.effect?.(()=>()=>renderService.dispose());
  function MarkdownPreview({value,busy=false,onChange,label,headingPrefix,previewRef}){
    const source=String(value??''),consumer=R.useRef({});
    R.useEffect(()=>()=>renderService.cancel?.(consumer.current),[]);
    const [requested,setRequested]=R.useState(()=>({source,prefix:headingPrefix}));
    const large=requested.source.length>=ASYNC_MARKDOWN_THRESHOLD;
    R.useEffect(()=>{
      if(requested.source===source&&requested.prefix===headingPrefix)return;
      const timer=setTimeout(()=>setRequested({source,prefix:headingPrefix}),180);
      return()=>clearTimeout(timer);
    },[source,headingPrefix,requested]);
    const element=R.useRef(null),scrollRoot=R.useRef(null),frame=R.useRef(0),mounted=R.useRef(true);
    const measurements=R.useRef(new Map()),measuredData=R.useRef(null),current=R.useRef(null);
    const [asynchronous,setAsynchronous]=R.useState(null),[error,setError]=R.useState(false);
    const [viewport,setViewport]=R.useState({top:0,height:800}),[measurementVersion,setMeasurementVersion]=R.useState(0);
    const [forcedIndex,setForcedIndex]=R.useState(null);
    const synchronous=R.useMemo(()=>large?null:renderDocument(requested.source,{headingPrefix:requested.prefix}),[requested,large]);
    const data=large?asynchronous?.data:synchronous;
    const renderedSource=large?asynchronous?.source:requested.source;
    const renderedPrefix=large?asynchronous?.prefix:requested.prefix;
    const stale=renderedSource!==source||renderedPrefix!==headingPrefix;
    R.useEffect(()=>{
      let active=true;setError(false);
      if(large)renderService.render(requested.source,{headingPrefix:requested.prefix,consumer:consumer.current}).then(result=>{
        if(active)setAsynchronous({source:requested.source,prefix:requested.prefix,data:result});
      }).catch(problem=>{if(active&&problem.name!=='AbortError')setError(true);});
      return()=>{active=false;};
    },[requested,large]);
    R.useLayoutEffect(()=>{
      const retained=new Map(),previous=measuredData.current;
      // Live edits usually change one block. Keep measured heights for unchanged
      // blocks so an appended character cannot reset the entire scroll geometry.
      for(const [index,height] of measurements.current){
        if(previous?.blocks[index]?.html===data?.blocks[index]?.html)retained.set(index,height);
      }
      measurements.current=retained;measuredData.current=data;
      setMeasurementVersion(version=>version+1);setForcedIndex(null);
    },[data]);
    const offsets=R.useMemo(()=>previewOffsets(data?.blocks||[],measurements.current),[data,measurementVersion]);
    const window=large?previewWindow(offsets,viewport.top,viewport.height,{forcedIndex}):{start:0,end:data?.blocks.length||0,before:0,after:0};
    current.current={source,data:stale?null:data,offsets,headingPrefix,busy:busy||stale,onChange,large};
    function measureViewport(){
      const node=element.current,root=scrollRoot.current;
      if(!node||!root)return;
      const top=root.getBoundingClientRect().top+root.clientTop-node.getBoundingClientRect().top;
      const height=root.clientHeight||800;
      setViewport(previous=>Math.abs(previous.top-top)<1&&previous.height===height?previous:{top,height});
    }
    function scheduleViewport(){
      cancelAnimationFrame(frame.current);
      frame.current=requestAnimationFrame(measureViewport);
    }
    R.useLayoutEffect(()=>{
      mounted.current=true;
      const node=element.current,root=fieldScrollRoot?.(node)||node?.ownerDocument?.scrollingElement;
      scrollRoot.current=root;if(!node||!root)return;
      const view=node.ownerDocument.defaultView;
      root.addEventListener('scroll',scheduleViewport,{passive:true});view.addEventListener('resize',scheduleViewport);
      const resize=typeof ResizeObserver==='function'?new ResizeObserver(scheduleViewport):null;
      resize?.observe(root);measureViewport();
      return()=>{
        mounted.current=false;cancelAnimationFrame(frame.current);resize?.disconnect();
        root.removeEventListener('scroll',scheduleViewport);view.removeEventListener('resize',scheduleViewport);
      };
    },[]);
    R.useLayoutEffect(()=>{
      const node=element.current,root=scrollRoot.current;
      if(!node||!data)return;
      node.querySelectorAll('input.task-list-item-checkbox').forEach(input=>{
        input.disabled=busy||stale;
        if(!stale){
          const index=Number(input.getAttribute('data-md-task-index')),at=data.taskPositions[index];
          if(Number.isSafeInteger(at))input.checked=source[at]!==' ';
        }
      });
      if(!large)return;
      let stopped=false;
      function measure(){
        if(stopped||!mounted.current)return;
        const oldOffsets=current.current.offsets,anchor=blockAt(oldOffsets,Math.max(0,viewport.top));
        let changed=false,correction=0;
        for(const block of node.querySelectorAll('[data-md-block]')){
          const index=Number(block.dataset.mdBlock),height=block.getBoundingClientRect().height;
          if(height<=0||Math.abs((measurements.current.get(index)??data.blocks[index].heightEstimate)-height)<1)continue;
          if(index<anchor)correction+=height-(measurements.current.get(index)??data.blocks[index].heightEstimate);
          measurements.current.set(index,height);changed=true;
        }
        if(changed){
          // Disable native anchoring on this region and preserve the visible block
          // explicitly when estimates above it become actual measured heights.
          if(root&&correction)root.scrollTop+=correction;
          setMeasurementVersion(version=>version+1);scheduleViewport();
        }
      }
      measure();
      const observer=typeof ResizeObserver==='function'?new ResizeObserver(measure):null;
      node.querySelectorAll('[data-md-block]').forEach(block=>observer?.observe(block));
      return()=>{stopped=true;observer?.disconnect();};
    },[data,busy,stale,large,window.start,window.end]);
    R.useLayoutEffect(()=>{
      const handle={
        get element(){return element.current;},
        async revealHeading(index){
          const snapshot=current.current;
          let result=snapshot.data;
          if(!result){
            try{result=await renderService.render(snapshot.source,{headingPrefix:snapshot.headingPrefix,consumer:consumer.current});}catch{return false;}
            if(!mounted.current||current.current.source!==snapshot.source)return false;
            setRequested({source:snapshot.source,prefix:snapshot.headingPrefix});
            if(snapshot.source.length>=ASYNC_MARKDOWN_THRESHOLD)setAsynchronous({source:snapshot.source,prefix:snapshot.headingPrefix,data:result});
          }
          if(!mounted.current||current.current.source!==snapshot.source)return false;
          const blockIndex=result.blocks.findIndex(block=>block.headingIndices.includes(index));
          if(blockIndex<0)return false;
          if(snapshot.large){
            setForcedIndex(blockIndex);
            const root=scrollRoot.current,node=element.current;
            if(root&&node){
              const origin=node.getBoundingClientRect().top-root.getBoundingClientRect().top-root.clientTop+root.scrollTop;
              root.scrollTop=origin+(snapshot.offsets[blockIndex]??0);
            }
          }
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          if(!mounted.current||current.current.source!==snapshot.source)return false;
          const heading=element.current?.ownerDocument.getElementById(snapshot.headingPrefix+'-'+index);
          if(!heading||!element.current.contains(heading))return false;
          heading.scrollIntoView({block:'start',behavior:'auto'});
          heading.tabIndex=-1;heading.focus({preventScroll:true});
          if(snapshot.large){setForcedIndex(null);scheduleViewport();}
          return true;
        }
      };
      if(typeof previewRef==='function')previewRef(handle);else if(previewRef)previewRef.current=handle;
      return()=>{if(typeof previewRef==='function')previewRef(null);else if(previewRef&&previewRef.current===handle)previewRef.current=null;};
    },[previewRef]);
    function toggle(event){
      const input=event.target,snapshot=current.current;
      if(snapshot.busy||!snapshot.data||input.tagName!=='INPUT'||!input.classList.contains('task-list-item-checkbox'))return;
      const index=Number(input.getAttribute('data-md-task-index'));
      const updated=setMarkdownTaskAt(snapshot.source,snapshot.data.taskPositions,index,input.checked);
      if(updated===snapshot.source)return;
      const from=snapshot.data.taskPositions[index];
      const accepted=snapshot.onChange?.(updated,{from,to:from+1,insert:input.checked?'x':' '});
      if(accepted===false){input.checked=snapshot.source[from]!==' ';return;}
      // The stale preview disables its checkbox while the source transaction
      // renders. Keep focus inside the writing field so undo/redo still routes.
      const node=element.current;
      if(node){node.tabIndex=-1;node.focus({preventScroll:true});}
      requestAnimationFrame(()=>{
        if(!mounted.current||!node||element.current!==node||node.ownerDocument.activeElement!==node)return;
        const checkbox=node.querySelector('input[data-md-task-index="'+index+'"]');
        if(checkbox&&!checkbox.disabled)checkbox.focus({preventScroll:true});
      });
    }
    const props={ref:element,className:'em-markdown'+(large?' em-markdown-virtual':''),role:'region','aria-label':label,'aria-busy':stale&&!error,'data-md-preview-state':error?'error':stale?'rendering':'ready',onClick:toggle,style:large?{overflowAnchor:'none'}:undefined};
    if(!data)return h('div',props,h('p',{className:'em-md-empty',role:'status'},t(error?'nbError':'loading')));
    if(!large)return h('div',{...props,dangerouslySetInnerHTML:{__html:data.blocks.map(block=>block.html).join('')||'<p class="em-md-empty">'+t('mdEmpty')+'</p>'}});
    return h('div',props,
      h('div',{'aria-hidden':true,'data-md-spacer':'before',style:{height:window.before,overflowAnchor:'none'}}),
      ...data.blocks.slice(window.start,window.end).map((block,at)=>h('div',{
        key:window.start+at,'data-md-block':window.start+at,
        style:{display:'flow-root',overflowAnchor:'none'},dangerouslySetInnerHTML:{__html:block.html}
      })),
      h('div',{'aria-hidden':true,'data-md-spacer':'after',style:{height:window.after,overflowAnchor:'none'}}));
  }
  return {MarkdownPreview,renderService};
}
