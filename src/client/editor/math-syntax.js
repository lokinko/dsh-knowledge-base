// Keep math in the incremental Markdown tree, outside code and escaped text.
export const mathSyntax={
 defineNodes:['InlineMath','BlockMath'],
 parseInline:[{name:'NotebookMath',before:'Escape',parse(cx,next,pos){
  const bracket=next===92&&cx.char(pos+1)===40;
  if(!bracket&&next!==36)return -1;
  const size=bracket?2:1,close=bracket?'\\)':'$';
  if(!bracket&&(cx.char(pos+1)===36||/\s/.test(cx.slice(pos+1,pos+2))))return -1;
  for(let at=pos+size;at<cx.end;at++){
   if(cx.char(at)===10)return -1;
   if(cx.slice(at,at+close.length)===close){
    if(!bracket&&(/\s/.test(cx.slice(at-1,at))||/\d/.test(cx.slice(at+1,at+2))))continue;
    return cx.addElement(cx.elt('InlineMath',pos,at+close.length));
   }
   if(cx.char(at)===92)at++;
  }
  return -1;
 }}],
 parseBlock:[{name:'NotebookBlockMath',before:'FencedCode',parse(cx,line){
  const text=line.text.slice(line.pos),open=text.startsWith('$$')?'$$':text.startsWith('\\[')?'\\[':null;
  if(!open)return false;
  const close=open==='$$'?'$$':'\\]',from=cx.lineStart+line.pos;
  const inlineEnd=text.indexOf(close,2);
  if(inlineEnd>=2&&text.slice(inlineEnd+2).trim()===''){
   const end=cx.lineStart+line.text.length;cx.nextLine();cx.addElement(cx.elt('BlockMath',from,end));return true;
  }
  // An unclosed formula stays as editable source until its closing marker.
  let end=cx.lineStart+line.text.length;
  while(cx.nextLine()){
   const closing=line.text.trimEnd().endsWith(close);end=cx.lineStart+line.text.length;
   if(closing){cx.nextLine();break;}
  }
  cx.addElement(cx.elt('BlockMath',from,end));return true;
 }}],
};

export function mathParts(source,block=false){
 const open=source.startsWith('\\(')?'\\(':source.startsWith('\\[')?'\\[':block?'$$':'$';
 const close=open==='\\('? '\\)':open==='\\['?'\\]':open;
 const end=block?source.trimEnd().length:source.length;
 const closed=end>=open.length+close.length&&source.slice(0,end).endsWith(close);
 return {open,close:close+(closed?source.slice(end):''),body:source.slice(open.length,closed?end-close.length:undefined),closed};
}
