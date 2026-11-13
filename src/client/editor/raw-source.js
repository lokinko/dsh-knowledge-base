// Newline positions live in a lazy treap. Edits split/shift only affected
// branches, so a keystroke never scans the document or every following line.
let serial=0;
function priority(){let n=++serial;n=Math.imul(n^(n>>>16),0x45d9f3b);n=Math.imul(n^(n>>>16),0x45d9f3b);return (n^(n>>>16))>>>0;}
function extra(node){return node?.extra||0;}
function update(node){return node?{...node,extra:extra(node.left)+extra(node.right)+node.separator.length-1}:node;}
function shift(node,delta){return node?{...node,position:node.position+delta,lazy:node.lazy+delta}:node;}
function push(node){return node?.lazy?{...node,left:shift(node.left,node.lazy),right:shift(node.right,node.lazy),lazy:0}:node;}
function node(position,separator){return {position,separator,priority:priority(),left:null,right:null,lazy:0,extra:separator.length-1};}
function merge(left,right){
 if(!left)return right;if(!right)return left;
 if(left.priority<right.priority){left=push(left);return update({...left,right:merge(left.right,right)});}
 right=push(right);return update({...right,left:merge(left,right.left)});
}
function split(root,position){
 if(!root)return [null,null];root=push(root);
 if(root.position<position){const [left,right]=split(root.right,position);return [update({...root,right:left}),right];}
 const [left,right]=split(root.left,position);return [left,update({...root,left:right})];
}
function extraBefore(root,position){
 let total=0;
 while(root){root=push(root);if(root.position<position){total+=extra(root.left)+root.separator.length-1;root=root.right;}else root=root.left;}
 return total;
}
function nearbySeparator(root,position){
 let previous=null,first=null;
 while(root){root=push(root);if(root.position<=position){previous=root.separator;root=root.right;}else{first=root.separator;root=root.left;}}
 return previous||first||'\n';
}
function exactSeparator(root,position){
 while(root){root=push(root);if(root.position===position)return root.separator;root=position<root.position?root.left:root.right;}
 return '\n';
}
function indexInserted(text,offset,separator){
 let root=null;
 for(let at=text.indexOf('\n');at!==-1;at=text.indexOf('\n',at+1))root=merge(root,node(offset+at,separator));
 return root;
}
function indexRawInserted(text,offset){
 let root=null,removed=0;
 for(const match of text.matchAll(/\r\n?|\n/g)){
  root=merge(root,node(offset+match.index-removed,match[0]));removed+=match[0].length-1;
 }
 return root;
}

export class RawSourceMap{
 constructor(source=''){this.reset(source);}
 reset(source){
  this.raw=String(source??'');this.root=null;let removed=0;
  // Linear Cartesian-tree construction on initial load. Once published, all
  // tree changes are persistent so history can share untouched branches.
  const stack=[];
  this.normalized=this.raw.replace(/\r\n|\r|\n/g,(separator,position)=>{
   const next=node(position-removed,separator);let left=null;
   while(stack.length&&stack.at(-1).priority>next.priority)left=stack.pop();
   next.left=left;if(stack.length)stack.at(-1).right=next;stack.push(next);
   removed+=separator.length-1;return '\n';
  });
  this.root=stack[0]||null;
  function measure(root){if(!root)return 0;return root.extra=measure(root.left)+measure(root.right)+root.separator.length-1;}
  measure(this.root);
  this.length=this.normalized.length;
  return this.normalized;
 }
 normalizedToRaw(position){
  const at=Math.max(0,Math.min(this.length,Math.trunc(position)||0));
  return at+extraBefore(this.root,at);
 }
 rawToNormalized(position){
  const at=Math.max(0,Math.min(this.raw.length,Math.trunc(position)||0));let root=this.root,removed=0;
  while(root){
   root=push(root);const leftExtra=extra(root.left),rawStart=root.position+removed+leftExtra;
   if(rawStart<at){removed+=leftExtra+root.separator.length-1;root=root.right;}else root=root.left;
  }
  return at-removed;
 }
 fork(){const next=Object.create(RawSourceMap.prototype);next.raw=this.raw;next.root=this.root;next.length=this.length;next.normalized=null;return next;}
 get snapshot(){return {root:this.root,length:this.length};}
 applyChanges(changes,targetIndex=null){
  // Positions refer to the old normalized document, as in CM ChangeSet.
  // Only inserted text is inspected; untouched source is sliced verbatim.
  const edits=changes.map(change=>{
   const {from,to=from}=change;
   if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||to>this.length)throw new RangeError('Invalid source change');
   const exactRaw=typeof change.insertRaw==='string'?change.insertRaw:null;
   const text=String(exactRaw??change.insert??'').replace(/\r\n?|\n/g,'\n'),separator=nearbySeparator(this.root,from);
   const insert=exactRaw??(targetIndex?text.replace(/\n/g,(_,at)=>exactSeparator(targetIndex.root,(change.fromB??from)+at)):text.replace(/\n/g,separator));
   return {from,to,text,separator,exactRaw,rawFrom:this.normalizedToRaw(from),rawTo:this.normalizedToRaw(to),insert};
  }).sort((a,b)=>a.from-b.from);
  for(let i=1;i<edits.length;i++)if(edits[i].from<edits[i-1].to)throw new RangeError('Overlapping source changes');
  const pieces=[];let cursor=0;
  for(const edit of edits){pieces.push(this.raw.slice(cursor,edit.rawFrom),edit.insert);cursor=edit.rawTo;}
  pieces.push(this.raw.slice(cursor));
  if(targetIndex){this.root=targetIndex.root;this.length=targetIndex.length;}
  else for(let i=edits.length-1;i>=0;i--){
   const edit=edits[i],[left,tail]=split(this.root,edit.from),[,right]=split(tail,edit.to);
   const delta=edit.text.length-(edit.to-edit.from);
   const inserted=edit.exactRaw===null?indexInserted(edit.text,edit.from,edit.separator):indexRawInserted(edit.exactRaw,edit.from);
   this.root=merge(merge(left,inserted),shift(right,delta));
   this.length+=delta;
  }
  // Keep the common one-range edit as a string concatenation. Array.join forces
  // a flat copy of a large note on every key; the engine can share unchanged
  // string branches here until a consumer actually needs a flat representation.
  this.raw=edits.length===1?pieces[0]+pieces[1]+pieces[2]:pieces.join('');
  // Do not retain another complete text copy after initialization.
  this.normalized=null;
  return this.raw;
 }
}
