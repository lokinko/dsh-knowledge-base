import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import cpp from 'highlight.js/lib/languages/cpp';
import markdown from 'highlight.js/lib/languages/markdown';
for(const [name,language] of Object.entries({javascript,typescript,python,json,bash,xml,css,yaml,sql,cpp,markdown}))hljs.registerLanguage(name,language);
export function highlightCode(code,language){const lang=language.trim().split(/\s+/,1)[0].toLowerCase();if(lang&&hljs.getLanguage(lang)){try{return hljs.highlight(code,{language:lang,ignoreIllegals:true}).value;}catch{}}return '';}
const md=new MarkdownIt({html:false,breaks:true,linkify:true,typographer:false,highlight:highlightCode});
md.use(texmath,{engine:katex,delimiters:['dollars','brackets'],katexOptions:{throwOnError:false,trust:false,strict:'ignore',maxExpand:1000,maxSize:20,output:'htmlAndMathml'}});
md.core.ruler.after('inline','todo-task-lists',state=>{
 const source=state.env.rawSource??state.src,lines=source.split(/\r\n|\r|\n/),offsets=[0];
 for(const match of source.matchAll(/\r\n|\r|\n/g))offsets.push(match.index+match[0].length);
 const positions=state.env.taskPositions=[];const lists=[],items=[];
 for(const token of state.tokens){
  if(token.type==='bullet_list_open'||token.type==='ordered_list_open'){lists.push(token);continue;}
  if(token.type==='bullet_list_close'||token.type==='ordered_list_close'){lists.pop();continue;}
  if(token.type==='list_item_open'){items.push({token,seen:false,list:lists.at(-1)});continue;}
  if(token.type==='list_item_close'){items.pop();continue;}
  if(token.type!=='inline'||!items.length)continue;
  const item=items.at(-1);if(item.seen)continue;item.seen=true;
  const match=/^\[([ xX])\](?:[ \t]+|$)/.exec(token.content);
  if(!match||!token.map||!token.children?.length||token.children[0].type!=='text')continue;
  const lineIndex=token.map[0],line=lines[lineIndex]??'',firstLine=token.content.split('\n')[0].trimEnd();let offset=-1;
  for(const marker of line.matchAll(/(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/g)){
   const bracket=marker.index+marker[0].lastIndexOf('[');
   if(line.slice(bracket).trimEnd()===firstLine){offset=offsets[lineIndex]+bracket+1;break;}
  }
  if(offset<0)continue;
  const index=positions.length;positions.push(offset);item.token.attrJoin('class','task-list-item');item.list?.attrJoin('class','contains-task-list');
  token.children[0].content=token.children[0].content.replace(/^\[[ xX]\](?:[ \t]+|$)/,'');
  const checkbox=new state.Token('html_inline','',0);checkbox.content=`<input type="checkbox" class="task-list-item-checkbox" data-md-task-index="${index}"${match[1]!==' '?' checked=""':''} aria-label="${md.utils.escapeHtml(token.content.slice(match[0].length,match[0].length+100)||'Task')}" /> `;
  token.children.unshift(checkbox);
 }
});
// Resolve historical references for this plugin without changing the stored Markdown.
function attachmentRenderUrl(value){const legacy='/api/local-todo-manager/attachment-file?';return typeof value==='string'&&value.startsWith(legacy)?'/api/dsh-note/attachment-file?'+value.slice(legacy.length):value;}
const linkOpen=md.renderer.rules.link_open||((tokens,index,options,env,self)=>self.renderToken(tokens,index,options));
md.renderer.rules.link_open=(tokens,index,options,env,self)=>{const token=tokens[index];token.attrSet('href',attachmentRenderUrl(token.attrGet('href')||''));if(/^(?:https?:\/\/|\/api\/dsh-note\/attachment-file\?)/i.test(token.attrGet('href')||'')){token.attrSet('target','_blank');token.attrSet('rel','noopener noreferrer');}return linkOpen(tokens,index,options,env,self);};
const image=md.renderer.rules.image;
md.renderer.rules.image=(tokens,index,options,env,self)=>{tokens[index].attrSet('src',attachmentRenderUrl(tokens[index].attrGet('src')||''));tokens[index].attrSet('loading','lazy');tokens[index].attrSet('decoding','async');return image(tokens,index,options,env,self);};
function headingText(tokens){
 return (tokens||[]).map(token=>{
  if(token.type==='softbreak'||token.type==='hardbreak')return ' ';
  if(token.children?.length)return headingText(token.children);
  return token.nesting===0?token.content:'';
 }).join('');
}
// Heading maps come from the same parser that renders the preview, including
// nested blockquotes, setext headings, and fence/code exclusions.
md.core.ruler.push('document-headings',state=>{
 const prefix=state.env.headingPrefix,collect=state.env.collectHeadings;
 if(!prefix&&!collect)return;
 const headings=state.env.headings=[],offsets=[0];
 if(collect)for(const match of state.env.rawSource.matchAll(/\r\n|\r|\n/g))offsets.push(match.index+match[0].length);
 let index=0;
 for(let at=0;at<state.tokens.length;at++){
  const token=state.tokens[at];if(token.type!=='heading_open')continue;
  if(prefix)token.attrSet('id',`${prefix}-${index}`);
  if(collect){
   const line=token.map?.[0]??0,inline=state.tokens[at+1];
   headings.push({index,level:Number(token.tag.slice(1)),title:headingText(inline?.children).replace(/\s+/g,' ').trim(),line,offset:offsets[line]??state.env.rawSource.length});
  }
  index++;
 }
});
// Render balanced top-level token groups from a single parse. Reference definitions
// and task/heading indices remain document-wide, even when only one group mounts.
export function renderDocument(source,{headingPrefix,listBatchSize=40}={}){
 const rawSource=String(source??''),env={rawSource,headingPrefix:typeof headingPrefix==='string'?headingPrefix:'',collectHeadings:true};
 const tokens=md.parse(rawSource,env),groups=[];
 let start=0,depth=0;
 for(let at=0;at<tokens.length;at++){
  depth+=tokens[at].nesting;
  if(depth===0){groups.push(tokens.slice(start,at+1));start=at+1;}
 }
 if(start<tokens.length)groups.push(tokens.slice(start));
 const batches=[];
 for(const group of groups){
  const open=group[0];
  if((open?.type==='bullet_list_open'||open?.type==='ordered_list_open')&&group.at(-1)?.nesting===-1){
   const items=[];let itemStart=1,itemDepth=0;
   for(let at=1;at<group.length-1;at++){
    itemDepth+=group[at].nesting;
    if(itemDepth===0){items.push(group.slice(itemStart,at+1));itemStart=at+1;}
   }
   if(items.length>50&&itemStart===group.length-1){
    const size=Math.max(1,Math.min(50,Number.isInteger(listBatchSize)?listBatchSize:40));
    for(let at=0;at<items.length;at+=size){
     const wrapper=Object.assign(Object.create(Object.getPrototypeOf(open)),open,{attrs:open.attrs?.map(attr=>[...attr])});
     if(open.type==='ordered_list_open')wrapper.attrSet('start',String(Number(open.attrGet('start')||1)+at));
     batches.push([wrapper,...items.slice(at,at+size).flat(),group.at(-1)]);
    }
    continue;
   }
  }
  batches.push(group);
 }
 let headingIndex=0;
 const offsets=[0];for(const match of rawSource.matchAll(/\r\n|\r|\n/g))offsets.push(match.index+match[0].length);
 const blocks=batches.map((group,index)=>{
  const headingIndices=[];let firstLine=Infinity,lastLine=0,rows=0;
  for(const token of group){
   if(token.type==='heading_open')headingIndices.push(headingIndex++);
   // List wrapper maps cover the whole list; use individual item maps instead.
   if(token.map&&!(group.length>2&&(token.type==='bullet_list_open'||token.type==='ordered_list_open'))){firstLine=Math.min(firstLine,token.map[0]);lastLine=Math.max(lastLine,token.map[1]);}
   if(token.type==='list_item_open'||token.type==='tr_open')rows++;
  }
  const sourceStart=Number.isFinite(firstLine)?offsets[firstLine]??rawSource.length:0;
  const sourceEnd=offsets[lastLine]??rawSource.length;
  const lineCount=Math.max(1,lastLine-(Number.isFinite(firstLine)?firstLine:0));
  const heightEstimate=Math.max(40,Math.min(200000,(rows?rows*30:lineCount*25)+16));
  return {index,html:md.renderer.render(group,md.options,env),headingIndices,sourceStart,sourceEnd,heightEstimate};
 });
 return {blocks,headings:env.headings||[],taskPositions:env.taskPositions||[]};
}
export function setMarkdownTaskAt(source,positions,index,checked){
 if(typeof source!=='string'||!Number.isSafeInteger(index)||index<0||typeof checked!=='boolean')return source;
 const at=positions?.[index];
 if(!Number.isSafeInteger(at)||at<1||at>=source.length-1||source[at-1]!=='['||source[at+1]!==']'||![' ','x','X'].includes(source[at]))return source;
 if((source[at]!==' ')===checked)return source;
 return source.slice(0,at)+(checked?'x':' ')+source.slice(at+1);
}
export function renderMarkdown(source,{headingPrefix}={}){
 const rawSource=String(source??'');
 return md.render(rawSource,{rawSource,headingPrefix:typeof headingPrefix==='string'?headingPrefix:''});
}
export function getMarkdownHeadings(source){
 const rawSource=String(source??''),env={rawSource,collectHeadings:true};
 md.parse(rawSource,env);return env.headings;
}
export function setMarkdownTask(source,index,checked){
 if(!Number.isSafeInteger(index)||index<0||typeof checked!=='boolean')return source;
 const env={rawSource:source};md.parse(source,env);const at=env.taskPositions?.[index];
 if(at===undefined)return source;const before=source[at];if((before!==' ')===checked)return source;
 return source.slice(0,at)+(checked?'x':' ')+source.slice(at+1);
}
