import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {assertModuleBoundaries} from '../../scripts/lib/module-boundaries.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const graph = inputs => ({inputs});
const leaf = {imports: []};

test('runtime boundaries reject cross-side, development and unresolved browser dependencies', () => {
  assert.throws(() => assertModuleBoundaries(graph({'src/client/index.js': leaf, 'src/host/notes/store.js': leaf}), 'client'), /Unexpected client input/);
  assert.throws(() => assertModuleBoundaries(graph({'src/host/index.js': leaf, 'tests/helper.js': leaf}), 'host'), /Unexpected host input/);
  assert.throws(() => assertModuleBoundaries(graph({'src/client/index.js': {imports: [{path: 'node:fs', external: true}]}}), 'client'), /external dependency/);
  assert.throws(() => assertModuleBoundaries(graph({'src/host/index.js': {imports: [{path: 'unexpected-package', external: true}]}}), 'host'), /external dependency/);
  assert.throws(() => assertModuleBoundaries(graph({'src/client/index.js': leaf, 'node_modules/react/index.js': leaf}), 'client'), /host React/);
  assert.doesNotThrow(() => assertModuleBoundaries(graph({'src/host/index.js': {imports: [{path: 'zod', external: true}, {path: 'node:fs', external: true}]}}), 'host'));
});

test('source cycles fail with their import chain, without rejecting shared dependencies', () => {
  const inputs = {
    'src/host/index.js': {imports: [{path: 'src/host/a.js'}, {path: 'src/host/b.js'}]},
    'src/host/a.js': {imports: [{path: 'src/host/b.js'}]},
    'src/host/b.js': leaf,
  };
  assert.doesNotThrow(() => assertModuleBoundaries(graph(inputs), 'host'));
  inputs['src/host/b.js'] = {imports: [{path: 'src/host/a.js'}]};
  assert.throws(() => assertModuleBoundaries(graph(inputs), 'host'), /Circular source dependency: .*a.js.*b.js.*a.js/);
});

test('domain registration loads data contracts without stores, adapters or filesystem code', async () => {
  const result = await build({
    absWorkingDir: root, entryPoints: ['src/host/domain-spec.js'],
    bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', packages: 'external',
  });
  const inputs = [...assertModuleBoundaries(result.metafile, 'host')];
  assert.deepEqual(inputs.filter(name => name.startsWith('src/host/') &&
    name !== 'src/host/domain-spec.js' && !name.endsWith('/schema.js') && !name.endsWith('/references.js')), []);
  const external = Object.values(result.metafile.inputs).flatMap(input =>
    input.imports.filter(dependency => dependency.external).map(dependency => dependency.path));
  assert.ok(external.every(name => name === 'zod'), 'Data contracts must not load runtime services or Node built-ins');
});

async function sourcesIn(directory) {
  const entries = await fs.readdir(path.join(root, directory), {withFileTypes: true});
  const groups = await Promise.all(entries.map(entry => {
    const name = directory + '/' + entry.name;
    return entry.isDirectory() ? sourcesIn(name) : [name];
  }));
  return groups.flat();
}

test('all production sources belong to an acyclic Host, Client or Worker graph', async () => {
  const base = {absWorkingDir: root, bundle: true, write: false, metafile: true};
  const [host, client, worker, draftWorker] = await Promise.all([
    build({...base, entryPoints: ['src/host/index.js'], platform: 'node', format: 'esm', packages: 'external', target: 'node22'}),
    build({...base, entryPoints: ['src/client/index.js'], platform: 'browser', format: 'iife', loader: {'.css': 'text'}}),
    build({...base, entryPoints: ['src/client/markdown/render-worker.js'], platform: 'browser', format: 'iife'}),
    build({...base, entryPoints: ['src/client/notes/draft-worker.js'], platform: 'browser', format: 'iife'}),
  ]);
  for (const name of ['draft-record', 'legacy-draft-cache', 'idb-draft-driver', 'browser-draft-cache']) {
    const input = client.metafile.inputs['src/client/notes/' + name + '.js'];
    assert.ok(input, 'Missing draft layer: ' + name);
    assert.ok(input.imports.every(dependency => !/\/(?:edit-session|services|ui|editor|history)\.js$/.test(dependency.path)),
      'Draft persistence must not depend on edit coordination or UI: ' + name);
  }
  const used = new Set([
    ...assertModuleBoundaries(host.metafile, 'host'),
    ...assertModuleBoundaries(client.metafile, 'client'),
    ...assertModuleBoundaries(worker.metafile, 'client'),
    ...assertModuleBoundaries(draftWorker.metafile, 'client'),
  ]);
  const orphaned = (await sourcesIn('src')).filter(name => !used.has(name));
  assert.deepEqual(orphaned, [], 'Remove unused production files or connect them to their entry point');
});
