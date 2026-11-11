import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const files = ['index.js', 'client.js', 'THIRD_PARTY_NOTICES.md'];
async function hashes() {
  return Promise.all(files.map(async file => createHash('sha256')
    .update(await fs.readFile(new URL('../' + file, import.meta.url))).digest('hex')));
}

const before = await hashes();
const result = spawnSync(process.execPath, ['scripts/build.mjs'], {cwd, stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const after = await hashes();
const changed = files.filter((file, index) => before[index] !== after[index]);
if (changed.length) throw new Error('Build outputs differ between identical builds: ' + changed.join(', '));
console.log('PASS: Host, Client and license notices are byte-for-byte reproducible.');
