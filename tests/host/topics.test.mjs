import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TopicStore, topicSchema, referenceSchema, referenceKey } from '../../src/host/topics/store.js';
import { registerTopics } from '../../src/host/topics/host.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const note = (id = 'ctx1:example', label) => ({ kind: 'note', atomId: id, ...(label === undefined ? {} : { label }) });
const discussion = (sessionId = 'source-session', seq = 0) => ({ kind: 'discussion', sessionId, seq });
function fixture(options = {}) {
  const libraryA = randomUUID(), libraryB = randomUUID(), maps = new Map([[libraryA, new Map()], [libraryB, new Map()]]);
  let current = libraryA, tick = 0;
  const writes = [], validations = [], created = [];
  const table = {
    failPut: false, beforeGet: null, beforePut: null, beforeDelete: null,
    async get(id) { await table.beforeGet?.(id); return structuredClone(maps.get(current).get(id)); },
    async entries() { return structuredClone([...maps.get(current)]); },
    async put(id, value, boundary) {
      await table.beforePut?.(id, value, boundary);
      if (boundary?.libraryId !== current) throw Object.assign(new Error('storage route changed'), { code: 'CONFLICT' });
      if (table.failPut) throw new Error('fixture put failed');
      writes.push({ operation: 'put', id, boundary });
      maps.get(current).set(id, structuredClone(value));
    },
    async delete(id, boundary) {
      await table.beforeDelete?.(id, boundary);
      if (boundary?.libraryId !== current) throw Object.assign(new Error('storage route changed'), { code: 'CONFLICT' });
      writes.push({ operation: 'delete', id, boundary });
      maps.get(current).delete(id);
    },
  };
  const sessions = { async create(input) { created.push(input); return { sessionId: 'blank-' + created.length }; } };
  const store = new TopicStore({ table, getLibraryId: () => current, sessions,
    clock: () => new Date(Date.UTC(2026, 10, 11) + tick++).toISOString(),
    validateReference: async ref => { validations.push(ref); return true; }, ...options });
  const run = input => store.execute(input);
  const create = fields => run({ action: 'create', libraryId: current, question: 'What connects these notes?', ...fields });
  return { store, table, libraryA, libraryB, maps, writes, validations, created, run, create,
    library: () => current, switchTo: id => { current = id; } };
}

test('strict schemas, read admission identity, creation metadata and detached outputs', async () => {
  const f = fixture();
  assert.deepEqual(await f.run({ action: 'list' }), { ok: true, libraryId: f.libraryA, topics: [], total: 0 });
  const references = [note(), discussion()];
  const input = { action: 'create', libraryId: f.libraryA, revision: 0, question: '  A question  ', references };
  const pending = f.run(input);
  input.question = 'caller mutation';
  references.push(note('later'));
  const result = await pending;
  assert.equal(result.topic.question, 'A question');
  assert.equal(result.topic.revision, 1);
  assert.equal(result.binding, null);
  assert.equal(topicSchema.parse(result.topic).references.length, 2);
  result.topic.references[0].label = 'mutated result';
  const get = await f.run({ action: 'get', id: result.topic.id });
  assert.equal(get.topic.references[0].label, undefined);
  const list = await f.run({ action: 'list', libraryId: f.libraryA });
  assert.equal(list.topics[0].referenceCount, 2);
  assert.equal('references' in list.topics[0], false);
  assert.equal(list.libraryId, f.libraryA);
  assert.deepEqual(f.writes[0].boundary, { libraryId: f.libraryA });
  for (const value of [note(''), { ...discussion(), seq: -1 }, { ...discussion(), seq: 1.5 }, { kind: 'other' }]) {
    assert.equal(referenceSchema.safeParse(value).success, false);
  }
  await assert.rejects(f.create({ question: ' '.repeat(2) }));
  await assert.rejects(f.create({ question: 'q'.repeat(501) }));
  await assert.rejects(f.create({ references: [note('n'.repeat(4001))] }));
  await assert.rejects(f.create({ references: [note('ok', 'x'.repeat(301))] }));
  await assert.rejects(f.run({ action: 'create', question: 'missing identity' }));
  await assert.rejects(f.create({ sessionId: 'cannot inject a binding' }));
});

test('reference keys deduplicate first occurrence, preserve caller order and enforce cap', async () => {
  const f = fixture();
  const refs = [note('a', 'first'), discussion('s', 2), note('a', 'duplicate'), discussion('s', 2), note('b')];
  const { topic } = await f.create({ references: refs });
  assert.deepEqual(topic.references, [refs[0], refs[1], refs[4]]);
  assert.deepEqual(f.validations, topic.references);
  assert.equal(referenceKey(discussion('s', 2)), 'discussion:s:2');
  const reordered = await f.run({ action: 'update', libraryId: f.libraryA, id: topic.id, revision: 1,
    references: [refs[4], refs[1], refs[0]] });
  assert.deepEqual(reordered.topic.references, [refs[4], refs[1], refs[0]]);
  assert.equal(f.validations.length, 3, 'Existing references are retained without revalidation');
  await f.create({ references: Array.from({ length: 100 }, (_, i) => note('atom-' + i)) });
  await assert.rejects(f.create({ references: Array.from({ length: 101 }, (_, i) => note('atom-' + i)) }));
});

test('only newly added references are validated; stale retained references can be relabeled or removed', async () => {
  const f = fixture(), { topic } = await f.create({ references: [note('stale')] });
  f.store.validateReference = () => false;
  const kept = await f.run({ action: 'update', libraryId: f.libraryA, id: topic.id, revision: 1,
    question: 'Revised question', references: [note('stale', 'retained label')] });
  assert.equal(kept.topic.revision, 2);
  await assert.rejects(f.run({ action: 'update', libraryId: f.libraryA, id: topic.id, revision: 2,
    references: [note('stale'), note('new missing')] }), { code: 'INVALID_REFERENCE' });
  const removed = await f.run({ action: 'update', libraryId: f.libraryA, id: topic.id, revision: 2, references: [] });
  assert.deepEqual(removed.topic.references, []);
  assert.equal(removed.topic.revision, 3);
});

test('revision CAS serializes competing updates, rejects stale deletes and preserves noops', async () => {
  const f = fixture(), { topic } = await f.create();
  const outcomes = await Promise.allSettled(['first', 'second'].map(question => f.run({
    action: 'update', libraryId: f.libraryA, id: topic.id, revision: 1, question,
  })));
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].reason.code, 'CONFLICT');
  const count = f.writes.length;
  const noop = await f.run({ action: 'update', libraryId: f.libraryA, id: topic.id, revision: 2, question: 'first' });
  assert.equal(noop.topic.revision, 2);
  assert.equal(f.writes.length, count);
  await assert.rejects(f.run({ action: 'delete', libraryId: f.libraryA, id: topic.id, revision: 1 }), { code: 'CONFLICT' });
  await f.run({ action: 'delete', libraryId: f.libraryA, id: topic.id, revision: 2 });
  await assert.rejects(f.run({ action: 'get', id: topic.id }), { code: 'NOT_FOUND' });
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }), { code: 'NOT_FOUND' });
  assert.deepEqual(f.writes.at(-1).boundary, { libraryId: f.libraryA });
});

test('concurrent starts create one blank native conversation and reuse its binding', async () => {
  const f = fixture(), { topic } = await f.create();
  const results = await Promise.all(Array.from({ length: 3 }, () => f.run({ action: 'start', libraryId: f.libraryA, id: topic.id })));
  assert.deepEqual(f.created, [{}]);
  for (const result of results) {
    assert.equal(result.topic.sessionId, 'blank-1');
    assert.equal(result.topic.revision, 2);
    assert.equal(result.binding.topicId, topic.id);
    assert.equal(result.binding.sessionId, 'blank-1');
  }
  const get = await f.run({ action: 'get', id: topic.id });
  assert.deepEqual(get.binding, results[0].binding);
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id, revision: 1 }), { code: 'CONFLICT' });
});

test('unavailable sessions leave CRUD usable; creation failures recover; sessions can be injected later', async () => {
  const f = fixture({ sessions: undefined }), { topic } = await f.create();
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }), { code: 'UNAVAILABLE' });
  assert.equal((await f.run({ action: 'get', id: topic.id })).topic.revision, 1);
  f.store.setSessions({ create() { throw new Error('native unavailable'); } });
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }), { code: 'SESSION_CREATE_FAILED' });
  f.store.setSessions(() => ({ async create(input) { assert.deepEqual(input, {}); return { sessionId: 'late-session' }; } }));
  assert.equal((await f.run({ action: 'start', libraryId: f.libraryA, id: topic.id })).topic.sessionId, 'late-session');
});

test('failed session persistence retains one candidate across retries and topic edits', async () => {
  const f = fixture(), { topic } = await f.create();
  f.table.failPut = true;
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }), /fixture put failed/);
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }), /fixture put failed/);
  assert.equal(f.created.length, 1);
  f.table.failPut = false;
  await f.run({ action: 'update', libraryId: f.libraryA, id: topic.id, revision: 1, question: 'edited while pending' });
  const result = await f.run({ action: 'start', libraryId: f.libraryA, id: topic.id, revision: 2 });
  assert.equal(result.topic.sessionId, 'blank-1');
  assert.equal(result.topic.question, 'edited while pending');
  assert.equal(result.topic.revision, 3);
  assert.equal(f.created.length, 1);
  assert.equal(f.store.pending.size, 0);
});

test('deleting a pending topic prevents resurrection on start retry', async () => {
  const f = fixture(), { topic } = await f.create();
  f.table.failPut = true;
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }));
  f.table.failPut = false;
  await f.run({ action: 'delete', libraryId: f.libraryA, id: topic.id, revision: 1 });
  assert.equal(f.store.pending.size, 0);
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }), { code: 'NOT_FOUND' });
  assert.equal(f.created.length, 1);
});

test('external delete during session creation is rechecked before saving', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ sessions: { async create() { entered.resolve(); await release.promise; return { sessionId: 'orphan-blank' }; } } });
  const { topic } = await f.create();
  const pending = f.run({ action: 'start', libraryId: f.libraryA, id: topic.id });
  await entered.promise;
  f.maps.get(f.libraryA).delete(topic.id);
  release.resolve();
  await assert.rejects(pending, { code: 'NOT_FOUND' });
  assert.equal(f.maps.get(f.libraryA).has(topic.id), false);
  assert.equal(f.store.pending.size, 0);
});

test('library switch during reference validation rejects create and cannot write to the new route', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ validateReference: async () => { entered.resolve(); await release.promise; return true; } });
  const pending = f.create({ references: [note()] });
  await entered.promise;
  f.switchTo(f.libraryB);
  release.resolve();
  await assert.rejects(pending, { code: 'CONFLICT' });
  assert.equal(f.maps.get(f.libraryA).size, 0);
  assert.equal(f.maps.get(f.libraryB).size, 0);
});

test('library switch during native creation discards candidate and queued old-library reads', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ sessions: { async create() { entered.resolve(); await release.promise; return { sessionId: 'old-library-blank' }; } } });
  const { topic } = await f.create();
  const start = f.run({ action: 'start', libraryId: f.libraryA, id: topic.id });
  await entered.promise;
  const list = f.run({ action: 'list' });
  f.switchTo(f.libraryB);
  release.resolve();
  await assert.rejects(start, { code: 'CONFLICT' });
  await assert.rejects(list, { code: 'CONFLICT' });
  assert.equal(f.store.pending.size, 0);
  assert.equal(f.maps.get(f.libraryB).size, 0);
  assert.equal(f.maps.get(f.libraryA).get(topic.id).sessionId, undefined);
  assert.equal((await f.run({ action: 'list' })).libraryId, f.libraryB);
});

test('storage boundary validates library identity inside its write queue and read awaits reject route changes', async () => {
  const f = fixture();
  f.table.beforePut = () => f.switchTo(f.libraryB);
  await assert.rejects(f.create(), { code: 'CONFLICT' });
  assert.equal(f.maps.get(f.libraryB).size, 0);
  f.table.beforePut = null;
  const { topic } = await f.create();
  f.table.beforeGet = () => f.switchTo(f.libraryA);
  await assert.rejects(f.run({ action: 'get', id: topic.id, libraryId: f.libraryB }), { code: 'CONFLICT' });
  await assert.rejects(f.run({ action: 'list', libraryId: f.libraryB }), { code: 'CONFLICT' });
});

test('pending candidates are isolated by library even if two libraries contain the same topic ID', async () => {
  const f = fixture(), { topic } = await f.create();
  f.table.failPut = true;
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }));
  f.table.failPut = false;
  f.maps.get(f.libraryB).set(topic.id, structuredClone(topic));
  f.switchTo(f.libraryB);
  const result = await f.run({ action: 'start', libraryId: f.libraryB, id: topic.id });
  assert.equal(result.topic.sessionId, 'blank-2');
  assert.equal(f.maps.get(f.libraryA).get(topic.id).sessionId, undefined);
});

test('close gates new work and drains previously admitted native creation', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ sessions: { async create() { entered.resolve(); await release.promise; return { sessionId: 'admitted' }; } } });
  const { topic } = await f.create();
  const start = f.run({ action: 'start', libraryId: f.libraryA, id: topic.id });
  await entered.promise;
  const closing = f.store.close();
  await assert.rejects(f.run({ action: 'list' }), { code: 'CLOSED' });
  release.resolve();
  await start;
  await closing;
  assert.equal(f.maps.get(f.libraryA).get(topic.id).sessionId, 'admitted');
});

test('a library change between nested promise continuations is checked before returning a topic', async () => {
  const f = fixture(), { topic } = await f.create();
  const read = f.store.read.bind(f.store);
  f.store.read = async (...args) => {
    const value = await read(...args);
    queueMicrotask(() => f.switchTo(f.libraryB));
    return value;
  };
  await assert.rejects(f.run({ action: 'get', id: topic.id, libraryId: f.libraryA }), { code: 'CONFLICT' });
});

test('exhausted revisions reject start before creating any native session', async () => {
  const f = fixture(), { topic } = await f.create();
  f.maps.get(f.libraryA).set(topic.id, { ...topic, revision: Number.MAX_SAFE_INTEGER });
  await assert.rejects(f.run({ action: 'start', libraryId: f.libraryA, id: topic.id }), { code: 'CONFLICT' });
  assert.equal(f.created.length, 0);
});

test('async list enumeration and update validation cannot publish stale records or resurrect a deleted topic', async () => {
  const f = fixture(), { topic } = await f.create();
  const entered = deferred(), release = deferred();
  f.store.validateReference = async () => { entered.resolve(); await release.promise; return true; };
  const updating = f.run({ action: 'update', libraryId: f.libraryA, id: topic.id, revision: 1, references: [note('new')] });
  await entered.promise;
  f.maps.get(f.libraryA).delete(topic.id);
  release.resolve();
  await assert.rejects(updating, { code: 'NOT_FOUND' });
  assert.equal(f.maps.get(f.libraryA).has(topic.id), false);
  const scanEntered = deferred(), scanRelease = deferred();
  f.table.entries = async function* () {
    scanEntered.resolve();
    await scanRelease.promise;
    yield [topic.id, topic];
  };
  const listing = f.run({ action: 'list' });
  await scanEntered.promise;
  f.switchTo(f.libraryB);
  scanRelease.resolve();
  await assert.rejects(listing, { code: 'CONFLICT' });
});

test('HTTP caps streamed bytes at 1 MiB, cancels small-chunk overflow and never executes the store', async () => {
  let route, calls = 0, cancelled = false, pulls = 0;
  registerTopics({ connection: { fetch: { register(value) { route = value; return () => {}; } } },
    effect(fn) { fn(); } }, { execute() { calls++; assert.fail('Oversized metadata must not reach TopicStore'); } });
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024).fill(32)); },
    cancel() { cancelled = true; },
  });
  const response = await route.fetch(new Request('https://fixture.test/api/dsh-note/topics', {
    method: 'POST', body, duplex: 'half', headers: { 'Content-Length': '1' },
  }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'REQUEST_TOO_LARGE');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
  assert.ok(pulls <= 1026, 'The reader must cancel when the byte boundary is crossed, without draining the source');
});

test('HTTP accepts exact-boundary metadata with 100 references and UTF-8 characters split across chunks', async () => {
  const f = fixture();
  let route, calls = 0;
  registerTopics({ connection: { fetch: { register(value) { route = value; return () => {}; } } },
    effect(fn) { fn(); } }, { execute(input) { calls++; return f.store.execute(input); } });
  const input = { action: 'create', libraryId: f.libraryA, question: '跨块问题🙂：保留原始 UTF-8',
    references: Array.from({ length: 100 }, (_, i) => note('ctx1:' + String(i).padStart(3, '0') + ':' + 'a'.repeat(3991), '引用🙂'.repeat(50))) };
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  assert.ok(encoded.byteLength < 1024 * 1024);
  const bytes = new Uint8Array(1024 * 1024).fill(32);
  bytes.set(encoded);
  let offset = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      // One-byte chunks through the question force real multibyte splits;
      // later 1023-byte chunks exercise streaming without a giant input chunk.
      const end = Math.min(bytes.length, offset + (offset < 400 ? 1 : 1023));
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    },
    cancel() { cancelled = true; },
  });
  const response = await route.fetch(new Request('https://fixture.test/api/dsh-note/topics', {
    method: 'POST', body, duplex: 'half', headers: { 'Content-Length': String(100 * 1024 * 1024) },
  }));
  assert.equal(response.status, 200, 'Count actual streamed bytes rather than trusting Content-Length');
  const result = await response.json();
  assert.equal(calls, 1);
  assert.equal(cancelled, false);
  assert.equal(result.topic.question, input.question);
  assert.deepEqual(result.topic.references, input.references);
  assert.deepEqual(f.maps.get(f.libraryA).get(result.topic.id).references, input.references);
});

test('HTTP rejects malformed or incomplete UTF-8 and malformed JSON before store execution', async () => {
  let route, calls = 0;
  registerTopics({ connection: { fetch: { register(value) { route = value; return () => {}; } } },
    effect(fn) { fn(); } }, { execute() { calls++; assert.fail('Malformed metadata must not reach TopicStore'); } });
  for (const bytes of [new Uint8Array([0xff, 0xfe]), new Uint8Array([0xe4, 0xb8]), new TextEncoder().encode('{invalid'), new Uint8Array()]) {
    let offset = 0;
    const body = new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, ++offset));
    } });
    const response = await route.fetch(new Request('https://fixture.test/api/dsh-note/topics', { method: 'POST', body, duplex: 'half' }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
  }
  assert.equal(calls, 0);
});

test('HTTP exposes only authenticated POST route with consistent errors and no mutating AI tools', async () => {
  const f = fixture({ sessions: undefined });
  let route, dispose, cleaned = false;
  registerTopics({ connection: { fetch: { register(value) { route = value; return () => { cleaned = true; }; } } },
    tools: { register() { assert.fail('Topic mutations must not be registered as AI tools'); } },
    effect(fn) { dispose = fn(); } }, f.store);
  assert.equal(route.path, '/api/dsh-note/topics');
  assert.deepEqual(route.methods, ['POST']);
  const request = (input, method = 'POST') => route.fetch(new Request('https://fixture.test/api/dsh-note/topics', {
    method, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
  }));
  assert.equal((await request({}, 'GET')).status, 405);
  assert.equal((await request({ action: 'create', question: 'missing library' })).status, 400);
  const created = await request({ action: 'create', libraryId: f.libraryA, question: 'HTTP question' });
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('Cache-Control'), 'no-store');
  const { topic } = await created.json();
  assert.equal((await request({ action: 'start', libraryId: f.libraryA, id: topic.id })).status, 503);
  assert.equal((await request({ action: 'update', libraryId: f.libraryA, id: topic.id, revision: 9, question: 'stale' })).status, 409);
  assert.equal((await request({ action: 'get', id: randomUUID() })).status, 404);
  assert.equal(cleaned, false);
  dispose();
  assert.equal(cleaned, true);
});
