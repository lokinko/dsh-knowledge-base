import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
async function testsIn(directory) {
  const entries = await fs.readdir(path.join(cwd, directory), {withFileTypes: true});
  const groups = await Promise.all(entries.map(entry => {
    const name = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? testsIn(name) : name.endsWith('.test.mjs') ? [name] : [];
  }));
  return groups.flat().sort();
}
const tests = await testsIn('tests');
if (!tests.length) throw new Error('No tests discovered');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...tests], {cwd, stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
