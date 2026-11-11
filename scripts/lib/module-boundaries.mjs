import assert from 'node:assert/strict';

const normalize = name => name.replaceAll('\\', '/');

// Shared by release validation and source-level tests, including the inline Worker.
export function assertModuleBoundaries(metafile, side) {
  assert.ok(['host', 'client'].includes(side), 'Unknown runtime side: ' + side);
  const own = 'src/' + side + '/';
  const inputs = new Map(Object.entries(metafile.inputs).map(([name, input]) => [normalize(name), input]));
  assert.ok([...inputs.keys()].some(name => name.startsWith(own)), 'Missing ' + side + ' source entry');
  for (const [name, input] of inputs) {
    assert.ok(name.startsWith(own) || name.startsWith('node_modules/'), 'Unexpected ' + side + ' input: ' + name);
    if (side === 'client') {
      assert.doesNotMatch(name, /^node_modules\/(?:react|react-dom)\//, 'Client must use host React: ' + name);
    }
    for (const dependency of input.imports || []) {
      if (!dependency.external) continue;
      assert.ok(side === 'host' && (dependency.path === 'zod' || dependency.path.startsWith('node:')),
        'Unexpected ' + side + ' external dependency: ' + dependency.path);
    }
  }

  // Vendor internals may be cyclic; our own modules must have a clear direction.
  const visited = new Set(), active = [];
  function visit(name) {
    if (!name.startsWith(own)) return;
    assert.ok(!active.includes(name), 'Circular source dependency: ' + [...active, name].join(' -> '));
    if (visited.has(name)) return;
    active.push(name);
    for (const dependency of inputs.get(name)?.imports || []) {
      if (!dependency.external) visit(normalize(dependency.path));
    }
    active.pop();
    visited.add(name);
  }
  for (const name of inputs.keys()) visit(name);
  return new Set(inputs.keys());
}
