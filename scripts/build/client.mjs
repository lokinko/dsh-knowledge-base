import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildKatexStyles, buildBootstrapStyles} from './styles.mjs';
import {collectNotices} from './notices.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
await fs.mkdir(path.join(root, '.build'), {recursive: true});
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const outfile = path.resolve(root, process.argv[2] || 'client.js');
const moduleId = process.argv[3] || manifest.name;
const relative = path.relative(root, outfile);
if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
  throw new Error('Build output must stay in this repository');
}

const katex = await buildKatexStyles();
const bootstrap = await buildBootstrapStyles();
await fs.writeFile(path.join(root, '.build/bootstrap-scoped.css'), bootstrap.css, 'utf8');

// Inline a local parser Worker: no remote URL, import or dynamic code loader.
const workerOptions = {
  absWorkingDir: root,
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  legalComments: 'eof',
  metafile: true,
};
// Draft persistence: IndexedDB clone/read-back runs off the main thread.
const draftWorker = await build({...workerOptions, entryPoints: ['src/client/notes/draft-worker.js']});
if (Object.values(draftWorker.metafile.outputs).some(output => output.imports.length)) {
  throw new Error('Draft worker has unresolved imports');
}
const draftWorkerSource = draftWorker.outputFiles[0].text;
const renderWorker = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/markdown/render-worker.js'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  legalComments: 'eof',
  metafile: true,
});
if (Object.values(renderWorker.metafile.outputs).some(output => output.imports.length)) {
  throw new Error('Markdown worker has unresolved imports');
}
const workerSource = renderWorker.outputFiles[0].text;
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.js'],
  loader: {'.css': 'text'},
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  legalComments: 'eof',
  metafile: true,
  define: {
    __TODO_MODULE_ID__: JSON.stringify(moduleId),
    __TODO_KATEX_CSS__: JSON.stringify(katex.css),
    __TODO_BOOTSTRAP_CSS__: JSON.stringify(bootstrap.css),
    __NOTE_RENDER_WORKER_SOURCE__: JSON.stringify(workerSource),
    __NOTE_DRAFT_WORKER_SOURCE__: JSON.stringify(draftWorkerSource),
  },
});
if (Object.values(result.metafile.outputs).some(output => output.imports.length)) {
  throw new Error('Browser artifact has unresolved imports');
}
const notices = await collectNotices(root, [
  ...Object.keys(result.metafile.inputs),
  ...Object.keys(renderWorker.metafile.inputs),
  ...Object.keys(draftWorker.metafile.inputs),
], [bootstrap]);
await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices.text, 'utf8');
const bytes = (await fs.stat(outfile)).size;
await fs.writeFile(path.join(root, '.build/client-meta.json'), JSON.stringify({
  moduleId,
  fonts: katex.fonts,
  renderWorker: {bytes: Buffer.byteLength(workerSource), metafile: renderWorker.metafile},
  draftWorker: {bytes: Buffer.byteLength(draftWorkerSource), metafile: draftWorker.metafile},
  bootstrap: bootstrap.metadata,
  bytes,
  packages: notices.packages,
  metafile: result.metafile,
}, null, 2), 'utf8');
console.log(`PASS: bundled ${moduleId}; ${katex.fonts} local WOFF2 fonts; ${bytes} bytes; no external imports; Bootstrap ${bootstrap.manifest.version}: ${bootstrap.metadata.rules} scoped rules, no external CSS URLs; ${notices.packages.length} third-party licenses retained.`);
