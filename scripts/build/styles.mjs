import {transform} from 'esbuild';
import postcss from 'postcss';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

const resolve = createRequire(import.meta.url).resolve;
const isKeyframe = rule => rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name);

export async function buildKatexStyles() {
  const directory = path.join(path.dirname(resolve('katex/package.json')), 'dist');
  const ast = postcss.parse(await fs.readFile(path.join(directory, 'katex.css'), 'utf8'));
  let fonts = 0;
  for (const face of ast.nodes.filter(node => node.type === 'atrule' && node.name === 'font-face')) {
    for (const declaration of face.nodes) {
      if (declaration.prop === 'font-family') {
        declaration.value = declaration.value.replaceAll('KaTeX_', 'TodoKaTeX_');
      }
      if (declaration.prop === 'src') {
        const match = /url\(([^)]+\.woff2)\)/.exec(declaration.value);
        if (!match) throw new Error('Missing WOFF2 font');
        const bytes = await fs.readFile(path.resolve(directory, match[1].replace(/["']/g, '')));
        declaration.value = 'url("data:font/woff2;base64,' + bytes.toString('base64') + '") format("woff2")';
        fonts++;
      }
    }
  }
  ast.walkDecls(/^font(?:-family)?$/, declaration => {
    declaration.value = declaration.value.replace(/(?<!Todo)KaTeX_/g, 'TodoKaTeX_');
  });
  ast.walkRules(rule => {
    if (!isKeyframe(rule)) rule.selectors = rule.selectors.map(selector => '.em-markdown ' + selector);
  });
  ast.walkDecls(declaration => {
    if (/(?<!Todo)KaTeX_/.test(declaration.value)) {
      throw new Error('Unscoped KaTeX font reference in ' + declaration.prop);
    }
  });
  const {code: css} = await transform(ast.toString(), {loader: 'css', minify: true});
  return {css, fonts};
}

function scopeBootstrapSelector(selector) {
  selector = selector.trim();
  if (/^(?::root|html|body)$/.test(selector)) return ['.tm-bs'];
  if (/^\[data-bs-theme=(?:["']?)[\w-]+(?:["']?)\]$/.test(selector)) {
    return ['.tm-bs' + selector, selector + ' .tm-bs'];
  }
  return ['.tm-bs ' + selector, '.tm-bs:is(' + selector + ')'];
}

export async function buildBootstrapStyles() {
  const directory = path.dirname(resolve('bootstrap/package.json'));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const ast = postcss.parse(await fs.readFile(path.join(directory, 'dist/css/bootstrap.css'), 'utf8'));
  ast.walkComments(comment => {
    if (/sourceMappingURL=/.test(comment.text)) comment.remove();
  });
  const animations = new Map();
  ast.walkAtRules(/keyframes$/i, rule => {
    const original = rule.params.trim(), scoped = 'todo-bs-' + original;
    animations.set(original, scoped);
    rule.params = scoped;
  });
  ast.walkDecls(/^(?:-webkit-)?animation(?:-name)?$/, declaration => {
    for (const [original, scoped] of animations) {
      declaration.value = declaration.value.replace(new RegExp('(?<![\\w-])' + original + '(?![\\w-])', 'g'), scoped);
    }
  });
  ast.walkRules(rule => {
    if (!isKeyframe(rule)) rule.selectors = rule.selectors.flatMap(scopeBootstrapSelector);
  });
  const {code: css} = await transform(ast.toString(), {
    loader: 'css', minify: true, target: ['chrome110'], legalComments: 'inline',
  });
  const check = postcss.parse(css);
  let rules = 0, dataUrls = 0;
  check.walkRules(rule => {
    if (isKeyframe(rule)) return;
    for (const selector of rule.selectors) {
      if (!/(?:^|[\s])\.tm-bs(?:\b|[:.\[])/.test(selector)) {
        throw new Error('Unscoped Bootstrap selector: ' + selector);
      }
    }
    rules++;
  });
  check.walkDecls(declaration => {
    for (const match of declaration.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      const url = (match[1] ?? match[2] ?? match[3]).trim();
      if (!url.startsWith('data:')) throw new Error('External Bootstrap URL: ' + url);
      dataUrls++;
    }
  });
  return {
    css, directory, manifest,
    metadata: {version: manifest.version, bytes: Buffer.byteLength(css), rules, dataUrls, externalUrls: 0, scope: '.tm-bs'},
  };
}
