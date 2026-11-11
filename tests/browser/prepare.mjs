import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

export default async function prepare() {
  await build({
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    entryPoints: ['tests/browser/fixture-client.js'],
    outfile: '.build/browser-host.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    define: {'process.env.NODE_ENV': JSON.stringify('production')},
  });
}
