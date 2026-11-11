import {Transaction} from '@codemirror/state';

const blocks=[
 ['heading1','Heading 1','# ',2],
 ['heading2','Heading 2','## ',3],
 ['bullet','Bullet list','- ',2],
 ['numbered','Numbered list','1. ',3],
 ['task','Task list','- [ ] ',6],
 ['quote','Quote','> ',2],
 ['code','Code block','```\n\n```',4],
 ['divider','Divider','---\n',4]
];
export function markdownBlockCompletions(context){
 if(context.view?.composing||context.state.readOnly)return null;
 const line=context.state.doc.lineAt(context.pos),before=line.text.slice(0,context.pos-line.from);
 const match=/^(\s*)\/([\w-]*)$/.exec(before);
 if(!match)return null;
 const slash=line.from+match[1].length;
 return {from:slash+1,validFor:/^[\w-]*$/,options:blocks.map(([label,displayLabel,text,cursor])=>({
  label,displayLabel,type:'keyword',apply(view,_completion,from,to){
   if(view.composing||view.state.readOnly)return;
   const start=from-1;
   view.dispatch({changes:{from:start,to,insert:text},selection:{anchor:start+cursor},scrollIntoView:true,
    annotations:Transaction.userEvent.of('input.complete')});
  }
 }))};
}
