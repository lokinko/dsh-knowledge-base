import {renderDocument,getMarkdownHeadings,renderCardMarkdown} from './renderer.js';

export function handleRenderRequest(request){
  const {id,kind,source,options}=request||{};
  try{
    const value=kind==='headings'?getMarkdownHeadings(source):kind==='card'?renderCardMarkdown(source,options):renderDocument(source,options);
    return {id,value};
  }catch(error){
    return {id,error:String(error?.message||error)};
  }
}

// This module is bundled into a local Blob worker, never loaded from a URL.
if(typeof self!=='undefined'&&typeof self.postMessage==='function'&&typeof document==='undefined'){
  self.onmessage=event=>self.postMessage(handleRenderRequest(event.data));
}
