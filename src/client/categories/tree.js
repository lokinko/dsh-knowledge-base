export const BUILTIN_CATEGORIES=['document','reading','code','journal'];
export function initialCategoryTree(){
 return {id:'categories',revision:0,items:BUILTIN_CATEGORIES.map((id,order)=>({id,name:'',parentId:null,order}))};
}
export function categoryChildren(tree,parentId=null){
 return tree.items.filter(item=>item.parentId===parentId).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
}
export function resolveCategoryId(tree,id){return tree.redirects?.find(item=>item.id===id)?.targetId||id;}
export function categoryDeleteTarget(tree,id){
 const item=tree.items.find(item=>item.id===id);if(!item||tree.items.length===1)return null;
 return item.parentId??categoryChildren(tree,null).flatMap(value=>value.id===id?categoryChildren(tree,id):[value])[0]?.id??null;
}
export function flattenCategories(tree,labelOf=item=>item.name||item.id){
 const result=[],seen=new Set(),children=new Map();
 for(const item of tree.items){if(!children.has(item.parentId))children.set(item.parentId,[]);children.get(item.parentId).push(item);}
 for(const siblings of children.values())siblings.sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
 function visit(parentId,depth,path){
  for(const item of children.get(parentId)||[]){
   if(seen.has(item.id))continue;
   seen.add(item.id);const label=labelOf(item),names=[...path,label];
   result.push({...item,depth,label,path:names.join(' / ')});
   visit(item.id,depth+1,names);
  }
 }
 visit(null,0,[]);return result;
}
export function isCategoryDescendant(tree,id,ancestorId){
 const byId=new Map(tree.items.map(item=>[item.id,item])),seen=new Set();
 let current=id;
 while(current!==null&&byId.has(current)&&!seen.has(current)){
  if(current===ancestorId)return true;
  seen.add(current);current=byId.get(current).parentId;
 }
 return false;
}
/** Translate a visible row position into the Host's insert-before operation. */
export function categoryDropMove(tree,sourceId,targetId,position){
 if(!tree.items.some(item=>item.id===sourceId))return null;
 if(targetId===null)return {id:sourceId,parentId:null,beforeId:null};
 const target=tree.items.find(item=>item.id===targetId);
 if(!target||isCategoryDescendant(tree,targetId,sourceId))return null;
 if(position==='inside')return {id:sourceId,parentId:targetId,beforeId:null};
 if(position==='before')return {id:sourceId,parentId:target.parentId,beforeId:target.id};
 if(position==='after'){
  const siblings=categoryChildren(tree,target.parentId).filter(item=>item.id!==sourceId);
  const next=siblings[siblings.findIndex(item=>item.id===targetId)+1];
  return {id:sourceId,parentId:target.parentId,beforeId:next?.id??null};
 }
 return null;
}
export function categoryRowPosition(clientY,rect){
 const fraction=(clientY-rect.top)/Math.max(1,rect.height);
 return fraction<.25?'before':fraction>.75?'after':'inside';
}
