import assert from 'node:assert/strict';
import test from 'node:test';
import {LiveRenderCache} from '../../src/client/editor/render-cache.js';
import {highlightCode} from '../../src/client/markdown/renderer.js';

test('live render cache bounds source and output retention, evicts least recently used entries and skips oversized results',()=>{
 const cache=new LiveRenderCache({maxEntries:2,maxUnits:12});let builds=0;
 const read=(key,value)=>cache.get(key,()=>{builds++;return value;});
 assert.equal(read('a','11'),'11');read('b','22');assert.equal(read('a','unused'),'11');assert.equal(builds,2);
 read('c','33');assert.deepEqual([...cache.entries.keys()],['a','c']);
 read('large','x'.repeat(20));assert.equal(cache.entries.has('large'),false);assert.equal(cache.units,6);
 read('b','12345678');assert.deepEqual([...cache.entries.keys()],['c','b']);assert.equal(cache.units,12);
 const separate=new LiveRenderCache();assert.equal(separate.entries.size,0);
});

test('live code highlighting keeps source literal, supports language aliases and rejects unknown languages',()=>{
 const source='const html = "<img src=x onerror=alert(1)>";\nconst fence = "```";';
 const html=highlightCode(source,'js linenums');
 assert.match(html,/hljs-keyword/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
 assert.equal(highlightCode(source,'unsupported'), '');assert.equal(highlightCode(source,''),'');
});
