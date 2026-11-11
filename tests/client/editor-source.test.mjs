import assert from 'node:assert/strict';
import test from 'node:test';
import {Compartment,EditorState,Transaction} from '@codemirror/state';
import {history,undo,redo,undoDepth,isolateHistory} from '@codemirror/commands';
import {RawSourceMap} from '../../src/client/editor/raw-source.js';
import {createRawSourceExtension,applySourceRawChange} from '../../src/client/editor/source-state.js';

function normalize(source){return source.replace(/\r\n?|\n/g,'\n');}
function rawOffset(source,position){let result=0,normalized=0;while(normalized<position&&result<source.length){if(source[result]==='\r'&&source[result+1]==='\n')result++;result++;normalized++;}return result;}
function nearestSeparator(source,position){let removed=0,previous,first;for(const match of source.matchAll(/\r\n?|\n/g)){const at=match.index-removed;if(at<=position)previous=match[0];else first??=match[0];removed+=match[0].length-1;}return previous||first||'\n';}
function stateHarness(source){
 const raw=createRawSourceExtension(source),historyCompartment=new Compartment();
 const view={state:EditorState.create({doc:raw.initial.normalized,extensions:[raw.extension,historyCompartment.of(history())]}),composing:false,
  dispatch(...specs){this.state=specs[0] instanceof Transaction?specs[0].state:this.state.update(...specs).state;}
 };
 view.dispatch=view.dispatch.bind(view);
 raw.initial.normalized=null;
 return {view,raw,historyCompartment,get source(){return raw.getMap(view.state).raw;}};
}

test('mixed line separators map exact UTF-16 offsets without modifying raw source',()=>{
 const source='😀 first\r\nsecond\nthird\rfourth\r\n# end',map=new RawSourceMap(source),normalized=normalize(source);
 assert.equal(map.normalized,normalized);assert.equal(map.raw,source);
 for(let index=0;index<=normalized.length;index++){
  const raw=rawOffset(source,index);assert.equal(map.normalizedToRaw(index),raw);assert.equal(map.rawToNormalized(raw),index);
 }
 assert.equal(map.rawToNormalized(source.indexOf('\r\n')+1),normalized.indexOf('\n'));
 assert.equal(map.normalizedToRaw(1e9),source.length);assert.equal(map.rawToNormalized(-10),0);
});

test('incremental multi-range edits preserve untouched separators and use nearby insertion style',()=>{
 const map=new RawSourceMap('a\r\nb\nc\rd');
 assert.equal(map.applyChanges([{from:0,to:1,insert:'A\nX'},{from:6,to:7,insert:'D'}]),'A\r\nX\r\nb\nc\rD');
 assert.equal(map.normalized,null);
 const branch=map.fork(),snapshot=map.snapshot;
 branch.applyChanges([{from:0,to:4,insert:'new\n'}]);
 assert.equal(map.raw,'A\r\nX\r\nb\nc\rD');
 assert.equal(map.snapshot.root,snapshot.root);
 assert.equal(map.normalizedToRaw(4),6);
 assert.throws(()=>map.applyChanges([{from:-1,insert:'x'}]),RangeError);
 assert.throws(()=>map.applyChanges([{from:0,to:2,insert:''},{from:1,to:3,insert:''}]),RangeError);
});

test('randomized indexed updates agree with a full independent mixed-newline model',()=>{
 let source='😀\r\nalpha\nbeta\rgamma\r\nend',seed=719;
 const map=new RawSourceMap(source),random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
 for(let iteration=0;iteration<500;iteration++){
  const normalized=normalize(source),from=random(normalized.length+1),to=from+random(normalized.length-from+1);
  const insert=['','X','\n','Z\nW','😀'][random(5)],separator=nearestSeparator(source,from);
  source=source.slice(0,rawOffset(source,from))+insert.replace(/\n/g,separator)+source.slice(rawOffset(source,to));
  assert.equal(map.applyChanges([{from,to,insert}]),source,`raw edit ${iteration}`);
  const next=normalize(source);assert.equal(map.length,next.length);
  for(let at=0;at<=next.length;at++){
   const expected=rawOffset(source,at);assert.equal(map.normalizedToRaw(at),expected,`to raw ${iteration}/${at}`);assert.equal(map.rawToNormalized(expected),at);
  }
 }
});

test('CodeMirror grouped undo/redo restores deleted mixed CRLF/LF/CR exactly',()=>{
 const source='a\r\nb\nc\rd\r\ne',app=stateHarness(source);
 app.view.dispatch({changes:{from:1,to:2},annotations:Transaction.userEvent.of('delete.backward')});
 assert.equal(app.source,'ab\nc\rd\r\ne');
 app.view.dispatch({changes:{from:1,to:3},annotations:Transaction.userEvent.of('delete.backward')});
 assert.equal(app.source,'ac\rd\r\ne');
 assert.equal(undo(app.view),true);assert.equal(app.source,source);
 assert.equal(redo(app.view),true);assert.equal(app.source,'ac\rd\r\ne');
 assert.equal(undo(app.view),true);assert.equal(app.source,source);
 app.view.dispatch({changes:{from:1,to:6,insert:'X\nY\nZ'},annotations:[Transaction.userEvent.of('input.paste'),isolateHistory.of('full')]});
 const edited=app.source;
 assert.equal(undo(app.view),true);assert.equal(app.source,source);
 assert.equal(redo(app.view),true);assert.equal(app.source,edited);
});

test('independent history groups, Unicode edits and selection-only transactions stay lossless',()=>{
 const source='😀\r\nB\nC\rD',app=stateHarness(source);
 app.view.dispatch({selection:{anchor:2}});assert.equal(app.source,source);
 app.view.dispatch({changes:{from:2,to:3},annotations:isolateHistory.of('full')});
 const first=app.source;
 app.view.dispatch({changes:{from:3,to:4,insert:'\nnew\n'},annotations:isolateHistory.of('full')});
 const second=app.source;
 undo(app.view);assert.equal(app.source,first);undo(app.view);assert.equal(app.source,source);
 redo(app.view);assert.equal(app.source,first);redo(app.view);assert.equal(app.source,second);
});

test('random mixed-newline history steps restore exact raw sources through the entire undo stack',()=>{
 const app=stateHarness('😀\r\nalpha\nbeta\rgamma\r\nend'),snapshots=[app.source];let seed=73;
 const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
 for(let step=0;step<80;step++){
  const length=app.view.state.doc.length,from=random(length+1),to=from+random(length-from+1),insert=['X','\n','z\nz','😀'][random(4)];
  app.view.dispatch({changes:{from,to,insert},annotations:isolateHistory.of('full')});snapshots.push(app.source);
 }
 for(let step=snapshots.length-2;step>=0;step--){assert.equal(undo(app.view),true);assert.equal(app.source,snapshots[step],`undo ${step}`);}
 for(let step=1;step<snapshots.length;step++){assert.equal(redo(app.view),true);assert.equal(app.source,snapshots[step],`redo ${step}`);}
});

test('million-character source applies local changes without normalizing untouched text',()=>{
 const source=('alpha\r\nbeta\ngamma\r').repeat(55000)+'END',map=new RawSourceMap(source);
 const before=map.snapshot,position=map.length-3;
 map.applyChanges([{from:position,to:position+3,insert:'FINISH'}]);
 assert.equal(map.raw,source.slice(0,-3)+'FINISH');
 assert.equal(map.normalized,null);assert.equal(before.length+3,map.length);
 assert.equal(map.rawToNormalized(map.raw.length-6),position);
});

test('local checkbox changes are isolated and preserve earlier typing history and exact source',()=>{
 const source='# 😀\r\n- [ ] task\nlast\r',app=stateHarness(source);
 app.view.focus=()=>assert.fail('widget transactions must not focus the editor');
 app.view.dispatch({changes:{from:app.view.state.doc.length,insert:'LIVE'},annotations:Transaction.userEvent.of('input.type')});
 const typed=app.source,at=typed.indexOf('[ ]')+1,before=undoDepth(app.view.state),generation=app.view.state.field(app.raw.field).generation;
 assert.equal(applySourceRawChange(app.view,app.raw,{from:at,to:at+1,insert:'x'}),true);
 const checked=typed.replace('[ ]','[x]');assert.equal(app.source,checked);assert.equal(undoDepth(app.view.state),before+1);
 assert.equal(app.view.state.field(app.raw.field).generation,generation);
 undo(app.view);assert.equal(app.source,typed);redo(app.view);assert.equal(app.source,checked);
 undo(app.view);undo(app.view);assert.equal(app.source,source);redo(app.view);redo(app.view);assert.equal(app.source,checked);
});

test('explicit attachment-style insertion preserves every inserted CRLF/LF/CR through undo and redo',()=>{
 const source='😀\r\nbody\nend\r',app=stateHarness(source),insert='\r\n[file](https://example.com/file)\nLF\rCR\r\n';
 const position=source.length;
 assert.equal(applySourceRawChange(app.view,app.raw,{from:position,to:position,insert}),true);
 assert.equal(app.source,source+insert);assert.equal(app.view.state.doc.toString(),normalize(source+insert));
 undo(app.view);assert.equal(app.source,source);redo(app.view);assert.equal(app.source,source+insert);
});

test('local raw ranges handle half CRLF, separator-only changes, and adjoining CR/LF without normalizing untouched text',()=>{
 for(const [source,from,to,insert] of [
  ['a\r\nb',2,2,'X'],['a\r\nb',2,3,''],['a\r\nb',1,2,''],
  ['a\rb',2,2,'\n'],['a\nb',1,1,'\r'],['a\rX\nb',2,3,''],['😀\r\nend',0,2,'🙂']
 ]){
  const app=stateHarness(source),expected=source.slice(0,from)+insert+source.slice(to);
  assert.equal(applySourceRawChange(app.view,app.raw,{from,to,insert}),true);
  assert.equal(app.source,expected);assert.equal(app.view.state.doc.toString(),normalize(expected));
  const map=app.raw.getMap(app.view.state);
  for(let at=0;at<=map.length;at++)assert.equal(map.normalizedToRaw(at),rawOffset(expected,at));
  undo(app.view);assert.equal(app.source,source);redo(app.view);assert.equal(app.source,expected);
 }
});

test('random local raw changes and full undo/redo agree with literal UTF-16 splicing across mixed separators',()=>{
 const app=stateHarness('😀\r\nA\nB\rC'),snapshots=[app.source];let seed=971;
 const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
 for(let step=0;step<80;step++){
  const previous=app.source,from=random(previous.length+1),to=from+random(previous.length-from+1),insert=['','X','\r','\n','\r\n','A\rB\nC\r\nD','🙂'][random(7)];
  const expected=previous.slice(0,from)+insert+previous.slice(to);
  assert.equal(applySourceRawChange(app.view,app.raw,{from,to,insert}),true);
  assert.equal(app.source,expected);assert.equal(app.view.state.doc.toString(),normalize(expected));
  if(expected!==previous)snapshots.push(expected);
 }
 for(let at=snapshots.length-2;at>=0;at--){assert.equal(undo(app.view),true);assert.equal(app.source,snapshots[at],`raw undo ${at}`);}
 for(let at=1;at<snapshots.length;at++){assert.equal(redo(app.view),true);assert.equal(app.source,snapshots[at],`raw redo ${at}`);}
});

test('local widget edits reject composition, read-only and invalid ranges and never rebuild the full source map',()=>{
 const app=stateHarness('a\r\nb'),change={from:0,to:1,insert:'A'};
 app.view.composing=true;assert.equal(applySourceRawChange(app.view,app.raw,change),false);app.view.composing=false;
 assert.equal(applySourceRawChange(app.view,app.raw,{from:-1,to:0,insert:'x'}),false);
 assert.equal(applySourceRawChange(app.view,app.raw,{from:0,to:100,insert:'x'}),false);
 const locked={...app.view,state:EditorState.create({doc:normalize(app.source),extensions:[app.raw.extension,EditorState.readOnly.of(true)]})};
 assert.equal(applySourceRawChange(locked,app.raw,change),false);
 const reset=RawSourceMap.prototype.reset;
 RawSourceMap.prototype.reset=()=>assert.fail('local edits must not scan/rebuild the document');
 try{assert.equal(applySourceRawChange(app.view,app.raw,change),true);}finally{RawSourceMap.prototype.reset=reset;}
 assert.equal(app.source,'A\r\nb');
});

test('genuine external replacements still reset history while later local widget undo targets the new document',()=>{
 const app=stateHarness('old\r\nbody');
 app.view.dispatch({changes:{from:0,insert:'typed '}});assert.equal(undoDepth(app.view.state),1);
 const remote=new RawSourceMap('remote\nA\rB\r\nC'),generation=app.view.state.field(app.raw.field).generation;
 app.view.dispatch({effects:app.historyCompartment.reconfigure([]),annotations:Transaction.addToHistory.of(false)});
 app.view.dispatch({changes:{from:0,to:app.view.state.doc.length,insert:remote.normalized},effects:app.raw.replaceRaw.of(remote),annotations:Transaction.addToHistory.of(false)});
 app.view.dispatch({effects:app.historyCompartment.reconfigure(history()),annotations:Transaction.addToHistory.of(false)});
 assert.equal(undoDepth(app.view.state),0);assert.equal(undo(app.view),false);assert.equal(app.source,remote.raw);
 assert.equal(app.view.state.field(app.raw.field).generation,generation+1);
 applySourceRawChange(app.view,app.raw,{from:0,to:6,insert:'local'});undo(app.view);assert.equal(app.source,remote.raw);
});

