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
const md=new MarkdownIt({html:false,breaks:true,linkify:true,typographer:false,highlight(code,language){const lang=language.toLowerCase();if(lang&&hljs.getLanguage(lang)){try{return hljs.highlight(code,{language:lang,ignoreIllegals:true}).value;}catch{}}return '';}});
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
export function renderMarkdown(source){return md.render(String(source??''),{rawSource:String(source??'')});}
export function setMarkdownTask(source,index,checked){
 if(!Number.isSafeInteger(index)||index<0||typeof checked!=='boolean')return source;
 const env={rawSource:source};md.parse(source,env);const at=env.taskPositions?.[index];
 if(at===undefined)return source;const before=source[at];if((before!==' ')===checked)return source;
 return source.slice(0,at)+(checked?'x':' ')+source.slice(at+1);
}
