import assert from 'node:assert/strict';
import {fittedTextareaHeight,caretScrollDelta} from '../../src/client/controls/textarea-metrics.js';
assert.equal(fittedTextareaHeight({scrollHeight:512,border:2,padding:12}),514);
assert.equal(fittedTextareaHeight({scrollHeight:512,boxSizing:'content-box',border:2,padding:12}),500);
assert.equal(fittedTextareaHeight({scrollHeight:24,minHeight:100}),100);
assert.equal(fittedTextareaHeight({scrollHeight:0,minHeight:40}),40);
assert.equal(fittedTextareaHeight({scrollHeight:101,border:1.5}),103);
assert.equal(caretScrollDelta({caretTop:500,caretBottom:528,viewportTop:100,viewportBottom:916}),0);
assert.equal(caretScrollDelta({caretTop:880,caretBottom:908,viewportTop:100,viewportBottom:916}),40);
assert.equal(caretScrollDelta({caretTop:90,caretBottom:118,viewportTop:100,viewportBottom:916}),-34);
assert.equal(caretScrollDelta({caretTop:700,caretBottom:728,viewportTop:100,viewportBottom:916}),0);
assert.equal(caretScrollDelta({caretTop:12,caretBottom:38,viewportTop:0,viewportBottom:40}),5);
assert.equal(caretScrollDelta({caretTop:100,caretBottom:126,viewportTop:200,viewportBottom:200}),0);
for(const height of [160,400,700])for(const caretTop of [-300,0,50,150,500,1200]){
 const bottom=height,delta=caretScrollDelta({caretTop,caretBottom:caretTop+28,viewportTop:0,viewportBottom:bottom});
 assert.ok(caretTop-delta>=24-.001);assert.ok(caretTop+28-delta<=bottom-48+.001);
}
console.log('PASS: border/content heights, minimum and fractional sizing, caret visibility, footer gutters and small viewports.');
