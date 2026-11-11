import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertModuleBoundaries} from './lib/module-boundaries.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFile(path.join(root, name), 'utf8');
const manifest = JSON.parse(await read('package.json'));
assert.equal(manifest.name, '@lokinko/dsh-knowledge-base');
assert.notEqual(manifest.private, true);
assert.equal(manifest.publishConfig.access, 'public');
assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/');
assert.equal(manifest.exports['.'], './index.js');
assert.equal(manifest.exports['./client'], './client.js');

const patch = await read('cordis.patch.yml');
const client = await read('client.js');
const host = await read('index.js');
assert.ok(patch.includes('id: dsh-note'));
assert.ok(patch.includes("name: '" + manifest.name + "'"));
assert.ok(client.includes(manifest.name));
assert.ok(!client.includes('__TODO_MODULE_ID__'));
assert.ok((await read('icon.svg')).startsWith('<svg'));
assert.equal(typeof (await import(new URL('../index.js', import.meta.url))).apply, 'function');
assert.ok(!host.includes('manage_todos'));
assert.ok(!client.includes('dt-workspace'));

// Inspect the actual bundle graph, rather than matching ambiguous file basenames.
for (const [file, side] of [
  ['.build/client-meta.json', 'client'],
  ['.build/host-meta.json', 'host'],
]) {
  const meta = JSON.parse(await read(file));
  assertModuleBoundaries(meta.metafile || meta, side);
  if (side === 'client') assertModuleBoundaries(meta.renderWorker.metafile, side);
}
for (const lang of ['en', 'zh']) {
  const locale = JSON.parse(await read('locale/' + lang + '.json'));
  assert.ok(locale.meta.title);
  assert.ok(locale.meta.description);
}
for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/spec/README.md']) {
  assert.ok((await read(name)).trim());
}

const bad = [];
async function scan(directory) {
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    if (['node_modules', '.git', '.release', '.build'].includes(entry.name) || entry.name.endsWith('.tgz')) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { await scan(filename); continue; }
    if (!/\.(?:[cm]?js|json|ya?ml|md|svg|css|html|txt)$/.test(entry.name) && entry.name !== 'LICENSE') continue;
    const text = await fs.readFile(filename, 'utf8');
    for (const [category, pattern] of [
      ['private-user-path', /[A-Z]:[\\/](?:Users|Documents)[\\/]/i],
      ['credential', /\b(?:npm_[A-Za-z0-9]{36,}|gh[pousr]_[A-Za-z0-9]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ]) {
      if (pattern.test(text)) bad.push({file: path.relative(root, filename), category});
    }
  }
}
await scan(root);
assert.deepEqual(bad, [], 'Source scan found private paths or credentials; filenames only.');
console.log('PASS: package exports, plugin identity, module boundaries, assets, specifications and private-path/credential scan.');
