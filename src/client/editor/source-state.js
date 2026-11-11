import {StateEffect,StateField,Transaction} from '@codemirror/state';
import {invertedEffects,isolateHistory} from '@codemirror/commands';
import {RawSourceMap} from './raw-source.js';

export function createRawSourceExtension(source){
 const initial=new RawSourceMap(source),replaceRaw=StateEffect.define(),localRaw=StateEffect.define(),restoreIndex=StateEffect.define();
 const field=StateField.define({
  create:()=>({map:initial,generation:0}),
  update(value,transaction){
   const replacement=transaction.effects.find(effect=>effect.is(replaceRaw));
   if(replacement)return {map:replacement.value,generation:value.generation+1};
   const local=transaction.effects.find(effect=>effect.is(localRaw));
   if(local)return {map:local.value,generation:value.generation};
   if(!transaction.docChanged)return value;
   // CM composes grouped history inverses newest first, so the final saved
   // index describes the earliest state. Persist only index branches in
   // history, not a full raw string snapshot for every keystroke.
   let target=null;
   for(const effect of transaction.effects)if(effect.is(restoreIndex)&&effect.value.generation===value.generation)target=effect.value.snapshot;
   if(target?.length!==transaction.newDoc.length)target=null;
   const changes=[];
   transaction.changes.iterChanges((from,to,fromB,_toB,insert)=>changes.push({from,to,fromB,insert:insert.toString()}));
   const map=value.map.fork();map.applyChanges(changes,target);
   return {map,generation:value.generation};
  }
 });
 const extension=[field,invertedEffects.of(transaction=>{
  if(!transaction.docChanged)return [];
  const before=transaction.startState.field(field);
  return [restoreIndex.of({snapshot:before.map.snapshot,generation:before.generation})];
 })];
 return {field,extension,replaceRaw,localRaw,initial,getMap:state=>state.field(field).map};
}

// Widget edits are local history events. Expand by one normalized character on
// either side so inserting/deleting half a CRLF or adjoining CR and LF stays
// exact without scanning the untouched document or replacing the whole CM doc.
export function applySourceRawChange(view,raw,change){
 if(!view||view.composing||view.state.readOnly||!change)return false;
 const current=raw.getMap(view.state),{from,to=from,insert}=change;
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||to>current.raw.length||typeof insert!=='string')return false;
 if(current.raw.slice(from,to)===insert)return true;
 const start=Math.max(0,current.rawToNormalized(from)-1),end=Math.min(current.length,current.rawToNormalized(to)+1);
 const rawStart=current.normalizedToRaw(start),rawEnd=current.normalizedToRaw(end);
 const exact=current.raw.slice(rawStart,from)+insert+current.raw.slice(to,rawEnd),normalized=exact.replace(/\r\n?|\n/g,'\n');
 const next=current.fork();next.applyChanges([{from:start,to:end,insertRaw:exact}]);
 view.dispatch({changes:{from:start,to:end,insert:normalized},effects:raw.localRaw.of(next),
  annotations:[isolateHistory.of('full'),Transaction.userEvent.of('input.widget')]});
 return raw.getMap(view.state)===next;
}
