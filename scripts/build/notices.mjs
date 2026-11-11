import fs from 'node:fs/promises';
import path from 'node:path';

// Follow only the packages present in the Client/Worker graphs, plus CSS vendors.
export async function collectNotices(root, inputs, vendors = []) {
  const packages = new Map(vendors.map(vendor => [
    vendor.manifest.name + '@' + vendor.manifest.version, vendor,
  ]));
  for (const input of new Set(inputs)) {
    if (!input.includes('node_modules')) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory !== path.dirname(directory)) {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) {
          packages.set(manifest.name + '@' + manifest.version, {directory, manifest});
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = path.dirname(directory);
    }
  }
  const notices = ['# Third-party notices', '\nThis browser artifact bundles the following libraries. Original license texts follow.\n'];
  for (const [name, {directory, manifest}] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const names = (await fs.readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name));
    if (!names.length) throw new Error('No license text found for ' + name);
    notices.push('\n## ' + name + '\nLicense: ' + JSON.stringify(manifest.license ?? 'See text below') + '\n');
    for (const name of names) notices.push('\n' + await fs.readFile(path.join(directory, name), 'utf8') + '\n');
  }
  return {
    text: notices.join('\n').replaceAll('\r\n', '\n').trimEnd() + '\n',
    packages: [...packages.keys()].sort(),
  };
}
