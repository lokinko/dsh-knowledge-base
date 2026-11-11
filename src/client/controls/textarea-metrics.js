// Geometry helpers shared verbatim with the client. No DOM or browser emulation.
export function fittedTextareaHeight({scrollHeight,boxSizing='border-box',border=0,padding=0,minHeight=0}){
  const height=boxSizing==='border-box'?scrollHeight+border:scrollHeight-padding;
  return Math.ceil(Math.max(0,minHeight,height));
}
export function caretScrollDelta({caretTop,caretBottom,viewportTop,viewportBottom,gutterTop=24,gutterBottom=48}){
  const viewportHeight=viewportBottom-viewportTop,lineHeight=caretBottom-caretTop;
  if(viewportHeight<=0||lineHeight<=0)return 0;
  const spare=Math.max(0,(viewportHeight-lineHeight)/2);
  const top=viewportTop+Math.min(gutterTop,spare),bottom=viewportBottom-Math.min(gutterBottom,spare);
  if(caretTop<top)return caretTop-top;
  if(caretBottom>bottom)return caretBottom-bottom;
  return 0;
}
