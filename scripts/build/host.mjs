import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
await fs.mkdir(path.join(root, '.build'), {recursive: true});
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/host/index.js'],
  outfile: 'index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  minify: false,
  metafile: true,
  legalComments: 'eof',
});
const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(value => value.path));
if (imports.some(value => value !== 'zod' && !value.startsWith('node:'))) {
  throw new Error('Unexpected external Host dependency');
}
await fs.writeFile(path.join(root, '.build/host-meta.json'), JSON.stringify(result.metafile, null, 2));
console.log('PASS: prebuilt Host bundles note services and schemas; only zod and Node built-ins remain external.');
