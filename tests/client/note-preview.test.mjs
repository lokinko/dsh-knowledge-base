import test from 'node:test';
import assert from 'node:assert/strict';
import {renderCardMarkdown,renderMarkdown} from '../../src/client/markdown/renderer.js';

test('card Markdown renders formulas, formatting, highlighted code and tables without nested controls',()=>{
 const source='# Same title\r\n\r\n## Policy Gradient\n\n**策略** and `sample_name` with $x^2$.\n\n$$\n\\begin{aligned}\n\\pi_\\theta(a|s)\n\\end{aligned}\n\\tag{PG1}\n$$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n~~~js\nconst sample_name = 42;\n~~~\n\n[Reference](https://example.com)\n\n- [x] Done';
 const html=renderCardMarkdown(source,{title:'Same title'});
 assert.doesNotMatch(html,/<h1>/);assert.match(html,/<h2>Policy Gradient/);assert.match(html,/<strong>策略/);
 assert.equal((html.match(/class="katex"/g)||[]).length,2);assert.match(html,/<code>sample_name/);
 assert.match(html,/hljs-keyword/);assert.match(html,/<table>/);assert.match(html,/nb-card-link/);assert.match(html,/☑/);
 assert.doesNotMatch(html,/<(?:a|input|button)\b/);
 const normal=renderMarkdown('[Reference](https://example.com)\n\n- [x] Done');assert.match(normal,/<a /);assert.match(normal,/<input /);
});

test('card Markdown bounds excerpts, omits unfinished math, and keeps TeX inside fenced code literal',()=>{
 assert.doesNotMatch(renderCardMarkdown('Intro\r\n\r\n$$\r\n\\begin{aligned}\r\n'+ 'x'.repeat(2000)),/begin|\$\$/);
 const html=renderCardMarkdown('````text\n```\n$$\n\\begin{aligned}\n````');assert.match(html,/begin/);assert.doesNotMatch(html,/class="katex"/);
 assert.match(renderCardMarkdown('    $$\n    \\begin{aligned}'),/begin/);
 const bounded=renderCardMarkdown('a'.repeat(1600)+'SHOULD_NOT_RENDER');assert.doesNotMatch(bounded,/SHOULD_NOT_RENDER/);
 const unsafe=renderCardMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n$x\\href{javascript:alert(1)}{x}$');
 assert.doesNotMatch(unsafe,/<script|<a\b|onerror=/);assert.match(unsafe,/&lt;script&gt;/);
});
