import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {ensureSyntaxTree} from '@codemirror/language';
import {mathSyntax,mathParts} from '../../src/client/editor/math-syntax.js';

function mathNodes(doc){
 const state=EditorState.create({doc,extensions:[markdown({base:markdownLanguage,extensions:[mathSyntax]})]});
 const nodes=[];ensureSyntaxTree(state,doc.length,1000).iterate({enter(node){if(/^(Inline|Block)Math$/.test(node.name))nodes.push({source:doc.slice(node.from,node.to),block:node.name==='BlockMath'});}});return nodes;
}
test('incremental Markdown grammar recognizes inline and display math outside code',()=>{
 const source='# Heading\n\n$x^2$ and \\(a+b\\)\n\n$$\n\\frac{a}{b}\n$$\n\n\\[c^2\\]\n\n`$code$`\n\n```py\n$not_math$\n```';
 assert.deepEqual(mathNodes(source),[{source:'$x^2$',block:false},{source:'\\(a+b\\)',block:false},{source:'$$\n\\frac{a}{b}\n$$',block:true},{source:'\\[c^2\\]',block:true}]);
});
test('math markers do not consume escaped dollars, currency or incomplete inline formulas',()=>{
 assert.deepEqual(mathNodes('Cost \\$5 and $10, now $20.\n\n$unfinished\n\n$ x $'),[]);
 assert.deepEqual(mathParts('$$\nx^2\n$$',true),{open:'$$',close:'$$',body:'\nx^2\n',closed:true});
 assert.equal(mathParts('$$\nx^2',true).closed,false);
 assert.equal(mathParts('\\(x\\)').body,'x');
 assert.deepEqual(mathParts('$$x$$  ',true),{open:'$$',close:'$$  ',body:'x',closed:true});
});
