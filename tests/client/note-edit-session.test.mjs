import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteDraftCache, NoteEditSession } from '../../src/client/notes/edit-session.js';

// These tests use plain key/value storage, timers and API promises. They do not
// load the Harness runtime, browser emulation, UI components or user data.
const PREFIX = 'dsh.todo-manager.note-draft.v1:';
const fields = (patch = {}) => ({ title: 'Title', content: 'Original\n', category: 'document',
  tags: ['one'], pinned: false, journalDate: '', ...patch });
const note = (patch = {}) => ({ id: 'note-1', revision: 3, ...fields(),
  updatedAt: '2026-01-01T00:00:00.000Z', trashedAt: '', ...patch });
const metadata = (payload, revision = payload.revision + 1) => ({ ok: true,
  note: { id: payload.id, revision, updatedAt: '2026-01-02T00:00:00.000Z' } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turns = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const multiMegabyteBody = () => '  # pasted\r\n中文🙂 \\literal "quoted"\t\u0000\n'.repeat(100000);

class MemoryStorage {
  data = new Map();
  failRead = false;
  failWrite = false;
  failRemove = false;
  get length() { if (this.failRead) throw new Error('read blocked'); return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { if (this.failRead) throw new Error('read blocked'); return this.data.get(key) ?? null; }
  setItem(key, raw) { if (this.failWrite) throw new Error('quota'); this.data.set(key, String(raw)); }
  removeItem(key) { if (this.failRemove) throw new Error('remove blocked'); this.data.delete(key); }
}
class Timers {
  time = 0;
  next = 0;
  jobs = new Map();
  set = (callback, delay) => {
    const id = ++this.next;
    this.jobs.set(id, { callback, at: this.time + delay });
    return id;
  };
  clear = id => this.jobs.delete(id);
  tick(delta) {
    this.time += delta;
    for (const [id, job] of [...this.jobs]) {
      if (job.at <= this.time) { this.jobs.delete(id); job.callback(); }
    }
  }
}
// Regular injected functions exercise the receiver contract of host callbacks.
// No globals are patched and no browser or DOM object is emulated.
function receiverSensitiveTimers() {
  const timers = new Timers();
  const scheduled = [];
  const cleared = [];
  let nextHandle = 0;
  function setTimer(callback, delay) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    const id = nextHandle++;
    timers.jobs.set(id, { callback, at: timers.time + delay });
    scheduled.push({ id, delay });
    return id;
  }
  function clearTimer(id) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    cleared.push(id);
    timers.jobs.delete(id);
  }
  return { timers, scheduled, cleared, setTimer, clearTimer };
}

function setup(options = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const cache = options.cache ?? new NoteDraftCache({ storageGetter: () => storage });
  const timers = new Timers();
  const calls = [];
  const save = options.save ?? (async payload => { calls.push(payload); return metadata(payload); });
  const session = new NoteEditSession({ note: note(), cache, save, writerId: 'writer-a',
    setTimer: timers.set, clearTimer: timers.clear, ...options.session });
  return { storage, cache, timers, calls, session };
}

test('receiver-sensitive host timers allow first short title, cache notification and debounce reset', async () => {
  const host = receiverSensitiveTimers();
  const { session, cache, calls } = setup({ session: { paused: true,
    note: note({ revision: 1, title: 'Untitled', content: '', tags: [] }),
    setTimer: host.setTimer, clearTimer: host.clearTimer } });
  session.start();
  let notifications = 0;
  session.subscribe(snapshot => {
    notifications += 1;
    if (snapshot.dirty) assert.equal(cache.latest('note-1').fields.title, snapshot.fields.title);
  });
  assert.doesNotThrow(() => session.change({ title: 'Short title' }));
  assert.equal(notifications, 1);
  assert.equal(session.snapshot().status, 'pending');
  assert.equal(cache.latest('note-1').fields.title, 'Short title');
  assert.deepEqual(host.scheduled, [{ id: 0, delay: 900 }]);
  host.timers.tick(400);
  assert.doesNotThrow(() => session.change({ title: 'Second short title' }));
  assert.deepEqual(host.cleared, [0]);
  assert.equal(host.timers.jobs.size, 1);
  host.timers.tick(899);
  await turns();
  assert.equal(calls.length, 0);
  host.timers.tick(1);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Second short title');
  assert.equal(calls[0].revision, 1);
  assert.equal(session.snapshot().baseRevision, 2);
  assert.equal(session.snapshot().status, 'saved');
  assert.deepEqual(cache.records(), []);
});

test('receiver-sensitive clear callbacks work with bound scheduling and explicit flush', async () => {
  const host = receiverSensitiveTimers();
  const { session, calls, cache } = setup({ session: {
    setTimer: host.setTimer.bind(globalThis), clearTimer: host.clearTimer } });
  session.change({ title: 'first' });
  assert.doesNotThrow(() => session.change({ title: 'second' }));
  assert.deepEqual(host.cleared, [0]);
  const work = session.flush();
  assert.deepEqual(host.cleared, [0, 1]);
  assert.equal(host.timers.jobs.size, 0);
  assert.equal(await work, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'second');
  assert.deepEqual(cache.records(), []);
});

test('receiver-sensitive timer cleanup preserves pause, stop, zero handles and in-flight serialization', async () => {
  const host = receiverSensitiveTimers();
  const first = deferred();
  const second = deferred();
  const calls = [];
  const { session, cache } = setup({ session: { setTimer: host.setTimer, clearTimer: host.clearTimer },
    save: payload => { calls.push(payload); return calls.length === 1 ? first.promise : calls.length === 2 ? second.promise : Promise.resolve(metadata(payload)); } });
  session.change({ title: 'before pause' });
  const work = session.pause();
  assert.deepEqual(host.cleared, [0]);
  await turns();
  session.start();
  session.change({ title: 'newer resumed title' });
  assert.equal(calls.length, 1);
  assert.equal(host.timers.jobs.size, 0);
  first.resolve(metadata(calls[0], 4));
  await turns();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, 'newer resumed title');
  assert.equal(calls[1].revision, 4);
  second.resolve(metadata(calls[1], 5));
  assert.equal(await work, true);
  session.change({ title: 'accepted before terminal stop' });
  const stopped = session.stop();
  assert.deepEqual(host.cleared, [0, 1]);
  assert.equal(host.timers.jobs.size, 0);
  assert.equal(await stopped, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].revision, 5);
  assert.equal(calls[2].title, 'accepted before terminal stop');
  assert.equal(session.snapshot().baseRevision, 6);
  assert.deepEqual(cache.records(), []);
});

test('storage getter is lazy and each writer has a separate key', () => {
  let gets = 0;
  const storage = new MemoryStorage();
  const cache = new NoteDraftCache({ storageGetter: () => { gets += 1; return storage; } });
  assert.equal(gets, 0);
  const a = cache.write({ noteId: 'a:note', writerId: 'writer-a', baseRevision: 1, fields: fields() });
  const b = cache.write({ noteId: 'a:note', writerId: 'writer-b', baseRevision: 1, fields: fields({ content: 'second' }) });
  assert.ok(a.key.startsWith(PREFIX));
  assert.notEqual(a.key, b.key);
  assert.equal(storage.length, 2);
  assert.equal(a.volatile, false);
  assert.equal(cache.latest('a:note').fields.content, 'second');
  assert.equal(cache.pending('a:note', 'writer-a'), null);
  const copy = cache.records();
  copy[0].fields.tags.push('mutated');
  assert.deepEqual(cache.records()[0].fields.tags, ['one']);
});

test('corrupt and unrelated entries are skipped individually and drafts never expire', () => {
  const { storage, cache } = setup();
  const record = cache.write({ noteId: 'note-1', writerId: 'writer-a', baseRevision: 1, fields: fields() });
  const old = JSON.parse(record.raw);
  old.updatedAt = '2000-01-01T00:00:00.000Z';
  storage.setItem(record.key, JSON.stringify(old));
  storage.setItem(`${PREFIX}broken`, '{bad json');
  storage.setItem(`${PREFIX}wrong-version`, JSON.stringify({ version: 2 }));
  storage.setItem('unrelated', 'anything');
  assert.equal(cache.records().length, 1);
  assert.equal(cache.latest('note-1').updatedAt, old.updatedAt);
});

test('cache rejects invalid fields atomically and preserves exact raw text at limits', () => {
  const { cache, storage } = setup();
  const good = fields({ title: ' '.repeat(200), content: '\n'.repeat(200000),
    tags: Array.from({ length: 20 }, (_, index) => String(index).padEnd(40, 'x')), journalDate: '2024-02-29' });
  const record = cache.write({ noteId: 'note-1', writerId: 'writer-a', baseRevision: 1, fields: good });
  assert.deepEqual(record.fields, good);
  for (const patch of [{ content: null }, { content: 123 }, { content: undefined }, { title: 'x'.repeat(201) },
    { category: 'other' }, { tags: Array.from({ length: 21 }, (_, index) => String(index)) },
    { tags: ['x'.repeat(41)] }, { tags: [''] }, { tags: ['same', 'same'] },
    { pinned: 1 }, { journalDate: '2023-02-29' }, { journalDate: '2024-04-31' },
    { journalDate: '0000-01-01' }, { journalDate: '2024-1-01' }]) {
    assert.throws(() => cache.write({ noteId: 'note-1', writerId: 'writer-a',
      baseRevision: 1, fields: fields(patch) }), TypeError);
  }
  assert.equal(storage.getItem(record.key), record.raw);
});

test('multi-megabyte raw bodies survive change, durable cache, independent recovery and flush exactly', async () => {
  const content = multiMegabyteBody();
  assert.ok(content.length > 2 * 1024 * 1024);
  const first = setup({ session: { paused: true } });
  first.session.change({ content });
  assert.equal(first.session.snapshot().fields.content, content);
  assert.equal(first.session.snapshot().cacheDurable, true);
  const source = first.cache.latest('note-1');
  assert.equal(source.fields.content, content);
  assert.equal(JSON.parse(first.storage.getItem(source.key)).fields.content, content);
  const cache = new NoteDraftCache({ storageGetter: () => first.storage });
  const recovered = setup({ storage: first.storage, cache,
    session: { draft: cache.latest('note-1'), paused: true, writerId: 'writer-b' } });
  assert.equal(recovered.session.snapshot().fields.content, content);
  assert.equal(first.storage.length, 1);
  recovered.session.start();
  assert.equal(first.storage.length, 2);
  const owned = cache.records().find(record => record.writerId === 'writer-b');
  assert.equal(owned.fields.content, content);
  assert.equal(first.cache.remove(source), true);
  const reload = new NoteDraftCache({ storageGetter: () => first.storage });
  assert.equal(reload.latest('note-1').fields.content, content);
  assert.equal(await recovered.session.flush(), true);
  assert.equal(recovered.calls.length, 1);
  assert.equal(recovered.calls[0].content, content);
  assert.equal(recovered.session.snapshot().fields.content, content);
  assert.equal(recovered.session.snapshot().dirty, false);
  assert.deepEqual(reload.records(), []);
});

test('multi-megabyte quota fallback remains exact through recovery, ownership and remote save', async () => {
  const content = multiMegabyteBody();
  const storage = new MemoryStorage();
  storage.failWrite = true;
  const first = setup({ storage, session: { paused: true } });
  first.session.change({ content });
  assert.equal(first.session.snapshot().cacheDurable, false);
  assert.equal(first.session.snapshot().status, 'cache-error');
  const source = first.cache.pending('note-1', 'writer-a');
  assert.equal(source.fields.content, content);
  assert.equal(JSON.parse(source.raw).fields.content, content);
  assert.equal(storage.length, 0);
  const recovered = setup({ storage, cache: first.cache,
    session: { draft: source, paused: true, writerId: 'writer-b' } });
  recovered.session.start();
  const own = first.cache.pending('note-1', 'writer-b');
  assert.equal(own.volatile, true);
  assert.notEqual(own.key, source.key);
  assert.equal(own.fields.content, content);
  assert.equal(recovered.session.snapshot().cacheDurable, false);
  assert.equal(recovered.session.snapshot().status, 'cache-error');
  assert.equal(first.cache.remove(source), true);
  assert.equal(first.cache.latest('note-1').writerId, 'writer-b');
  assert.equal(first.cache.latest('note-1').fields.content, content);
  recovered.session.start();
  assert.equal(first.cache.pending('note-1', 'writer-b').raw, own.raw);
  assert.equal(await recovered.session.flush(), true);
  assert.equal(recovered.calls[0].content, content);
  assert.equal(recovered.session.snapshot().fields.content, content);
  assert.deepEqual(first.cache.records(), []);
});

test('unchanged large bodies and equivalent tag arrays preserve cached raw and debounce deadline', async () => {
  const content = multiMegabyteBody();
  const { session, cache, timers, calls } = setup();
  let notifications = 0;
  session.subscribe(() => notifications += 1);
  session.change({ content, tags: ['first', 'second'] });
  const before = cache.latest('note-1');
  const [timerId] = timers.jobs.keys();
  timers.tick(400);
  session.change({ content, tags: ['first', 'second'] });
  assert.equal(notifications, 1);
  assert.equal(cache.latest('note-1').raw, before.raw);
  assert.deepEqual([...timers.jobs.keys()], [timerId]);
  // Tag order is data: equal strings with a reordered array are a real edit.
  session.change({ tags: ['second', 'first'] });
  assert.equal(notifications, 2);
  assert.deepEqual(cache.latest('note-1').fields.tags, ['second', 'first']);
  assert.equal(session.snapshot().fields.content, content);
  assert.equal(await session.flush(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, content);
  assert.deepEqual(calls[0].tags, ['second', 'first']);
});

test('tag validation matches backend without trimming, changing case, or mutating invalid edits', () => {
  const { session, cache } = setup();
  for (const tags of [[''], ['one', 'one']]) {
    assert.throws(() => session.change({ tags }), TypeError);
    assert.deepEqual(session.snapshot().fields.tags, ['one']);
    assert.equal(session.snapshot().dirty, false);
    assert.deepEqual(cache.records(), []);
  }
  session.change({ tags: ['One', 'one', ' one ', ' '] });
  assert.deepEqual(cache.latest('note-1').fields.tags, ['One', 'one', ' one ', ' ']);
});

test('failed durable writes remain visible and pending across session remounts', async () => {
  const storage = new MemoryStorage();
  storage.failWrite = true;
  const { cache, session, timers } = setup({ storage });
  session.change({ content: 'memory only' });
  assert.equal(session.snapshot().status, 'cache-error');
  assert.equal(session.snapshot().cacheDurable, false);
  const draft = cache.pending('note-1', 'writer-a');
  assert.equal(draft.fields.content, 'memory only');
  assert.equal(cache.latest('note-1').volatile, true);
  // Explicit abandon is not used on unmount; the cache outlives the editor.
  timers.jobs.clear();
  const next = setup({ storage, cache, session: { draft, writerId: 'writer-b' } });
  assert.equal(next.session.snapshot().fields.content, 'memory only');
  assert.equal(await next.session.flush(), true);
  assert.equal(cache.pending('note-1', 'writer-a'), null);
  assert.equal(cache.records().length, 0);
});

test('blocked storage reads throw without fallback and retain failed local writes', () => {
  let blocked = true;
  const storage = new MemoryStorage();
  const cache = new NoteDraftCache({ storageGetter: () => {
    if (blocked) throw new Error('storage denied');
    return storage;
  } });
  assert.throws(() => cache.records(), /storage denied/);
  const draft = cache.write({ noteId: 'note-1', writerId: 'writer-a', baseRevision: 3, fields: fields() });
  assert.equal(draft.volatile, true);
  assert.equal(cache.records().length, 1);
  blocked = false;
  const durable = cache.write({ ...draft, fields: fields({ content: 'durable again' }) });
  assert.equal(durable.volatile, false);
  assert.equal(cache.pending('note-1', 'writer-a'), null);
  blocked = true;
  assert.equal(cache.latest('note-1').fields.content, 'durable again');
  assert.equal(cache.latest('note-1').volatile, true);
});

test('inaccessible individual entries preserve fallback and do not hide readable drafts', () => {
  const storage = new MemoryStorage();
  const cache = new NoteDraftCache({ storageGetter: () => storage });
  const a = cache.write({ noteId: 'note-1', writerId: 'a', baseRevision: 3, fields: fields() });
  const b = cache.write({ noteId: 'note-2', writerId: 'b', baseRevision: 3, fields: fields() });
  const getItem = storage.getItem.bind(storage);
  storage.getItem = key => { if (key === a.key) throw new Error('entry denied'); return getItem(key); };
  assert.equal(cache.latest('note-1').volatile, true);
  assert.equal(cache.latest('note-2').volatile, false);
  const fresh = new NoteDraftCache({ storageGetter: () => storage });
  assert.deepEqual(fresh.records().map(record => record.key), [b.key]);
  storage.data.delete(b.key);
  assert.throws(() => fresh.records(), /entry denied/);
});

test('cache reads do not resurrect externally deleted durable drafts', () => {
  const { storage, cache } = setup();
  const record = cache.write({ noteId: 'note-1', writerId: 'writer-a', baseRevision: 3, fields: fields() });
  storage.removeItem(record.key);
  assert.deepEqual(cache.records(), []);
  storage.failRead = true;
  assert.throws(() => cache.records(), /read blocked/);
});

test('remove guards raw values against another tab updating the same key', () => {
  const storage = new MemoryStorage();
  const a = new NoteDraftCache({ storageGetter: () => storage });
  const b = new NoteDraftCache({ storageGetter: () => storage });
  const old = a.write({ noteId: 'note-1', writerId: 'shared-writer', baseRevision: 3, fields: fields() });
  const newer = b.write({ ...old, fields: fields({ content: 'other tab changed the raw value' }) });
  assert.equal(a.remove(old), false);
  assert.equal(storage.getItem(newer.key), newer.raw);
  assert.equal(a.latest('note-1').fields.content, newer.fields.content);
});

test('temporarily blocked cleanup cannot resurrect a saved record in the cache instance', () => {
  const { storage, cache } = setup();
  const record = cache.write({ noteId: 'note-1', writerId: 'writer-a', baseRevision: 3, fields: fields() });
  storage.failRemove = true;
  assert.equal(cache.remove(record), false);
  assert.deepEqual(cache.records(), []);
  storage.failRemove = false;
  assert.deepEqual(cache.records(), []);
  assert.equal(storage.getItem(record.key), null);
});

test('saved old raw cannot resurrect after a later quota failure and successful remote save', async () => {
  const { storage, cache, session } = setup();
  session.change({ content: 'first durable draft' });
  storage.failRemove = true;
  assert.equal(await session.flush(), true);
  storage.failWrite = true;
  session.change({ content: 'second draft only in memory' });
  assert.equal(await session.flush(), true);
  assert.deepEqual(cache.records(), []);
  storage.failRemove = false;
  assert.deepEqual(cache.records(), []);
  assert.equal(storage.length, 0);
});

test('every change is cached synchronously before subscribers, then debounced', async () => {
  const { cache, session, timers, calls } = setup();
  const seen = [];
  const unsubscribe = session.subscribe(snapshot => {
    seen.push(snapshot.status);
    if (snapshot.dirty) assert.equal(cache.latest('note-1').fields.content, snapshot.fields.content);
  });
  session.change({ content: ' first\n' });
  assert.equal(cache.latest('note-1').fields.content, ' first\n');
  timers.tick(800);
  session.change({ content: ' second\n\n' });
  timers.tick(899);
  await turns();
  assert.equal(calls.length, 0);
  timers.tick(1);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, ' second\n\n');
  assert.deepEqual(Object.keys(calls[0]).sort(),
    ['action', 'id', 'revision', 'title', 'content', 'category', 'tags', 'pinned', 'journalDate'].sort());
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(session.snapshot().updatedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(cache.records().length, 0);
  unsubscribe();
  assert.ok(seen.includes('pending') && seen.includes('saving') && seen.includes('saved'));
});

test('flush bypasses debounce, shares in-flight promise, and does not overlap writes', async () => {
  const response = deferred();
  const calls = [];
  const { session, timers } = setup({ save: payload => { calls.push(payload); return response.promise; } });
  session.change({ title: 'Changed' });
  const first = session.flush();
  assert.equal(session.flush(), first);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(timers.jobs.size, 0);
  response.resolve(metadata(calls[0]));
  assert.equal(await first, true);
  assert.equal(await session.flush(), true);
  assert.equal(calls.length, 1);
});

test('subscriber-triggered flush shares the existing request instead of overlapping', async () => {
  const response = deferred();
  const calls = [];
  const { session } = setup({ save: payload => { calls.push(payload); return response.promise; } });
  let fromListener;
  session.subscribe(snapshot => { if (snapshot.status === 'saving') fromListener = session.flush(); });
  session.change({ content: 'reentrant' });
  const work = session.flush();
  await turns();
  assert.equal(fromListener, work);
  assert.equal(calls.length, 1);
  response.resolve(metadata(calls[0]));
  assert.equal(await work, true);
});

test('snapshots are isolated, omitted server fields normalize, and invalid patches do not mutate', () => {
  const { session, cache } = setup({ session: { note: { id: 'note-1', revision: 1 } } });
  assert.deepEqual(session.snapshot().fields, fields({ title: '', content: '', tags: [] }));
  const snapshot = session.snapshot();
  snapshot.fields.tags.push('external');
  assert.deepEqual(session.snapshot().fields.tags, []);
  assert.throws(() => session.change({ title: 'x'.repeat(201) }), TypeError);
  assert.equal(session.snapshot().dirty, false);
  assert.deepEqual(cache.records(), []);
  assert.equal(session.noteId, 'note-1');
});

test('matching recovered draft schedules save and removes recovered and own records', async () => {
  const { cache } = setup();
  const draft = cache.write({ noteId: 'note-1', writerId: 'old-writer', baseRevision: 3,
    fields: fields({ content: 'recovered' }) });
  const { session, timers, calls } = setup({ cache, session: { draft } });
  assert.equal(session.snapshot().dirty, true);
  assert.equal(timers.jobs.size, 1);
  session.change({ content: 'recovered plus edit' });
  assert.equal(cache.records().length, 2);
  assert.equal(await session.flush(), true);
  assert.equal(calls[0].content, 'recovered plus edit');
  assert.deepEqual(cache.records(), []);
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 1);
});

test('activated recovery remains durable when its source tab removes the original before debounce', async () => {
  const storage = new MemoryStorage();
  const sourceCache = new NoteDraftCache({ storageGetter: () => storage });
  const draft = sourceCache.write({ noteId: 'note-1', writerId: 'source-tab', baseRevision: 3,
    fields: fields({ content: 'must survive source-tab discard\n' }) });
  const cache = new NoteDraftCache({ storageGetter: () => storage });
  const { session, timers, calls } = setup({ storage, cache, session: { draft } });
  assert.equal(session.snapshot().cacheDurable, true);
  assert.equal(storage.length, 2);
  assert.equal(sourceCache.remove(draft), true);
  const reloadedCache = new NoteDraftCache({ storageGetter: () => storage });
  const recovered = reloadedCache.latest('note-1');
  assert.equal(recovered.writerId, 'writer-a');
  assert.equal(recovered.fields.content, draft.fields.content);
  assert.equal(recovered.baseRevision, 3);
  assert.equal(recovered.volatile, false);
  assert.equal(calls.length, 0);
  assert.equal(timers.jobs.size, 1);
  assert.equal(await session.flush(), true);
  assert.deepEqual(reloadedCache.records(), []);
});

test('paused recovery has no storage access until start writes exactly one independent copy', () => {
  const storage = new MemoryStorage();
  const sourceCache = new NoteDraftCache({ storageGetter: () => storage });
  const draft = sourceCache.write({ noteId: 'note-1', writerId: 'source-tab', baseRevision: 3,
    fields: fields({ content: 'activate once' }) });
  let accesses = 0;
  let writes = 0;
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, raw) => { writes += 1; setItem(key, raw); };
  const cache = new NoteDraftCache({ storageGetter: () => { accesses += 1; return storage; } });
  const { session, timers } = setup({ storage, cache, session: { draft, paused: true } });
  assert.equal(accesses, 0);
  assert.equal(writes, 0);
  assert.equal(storage.length, 1);
  assert.equal(timers.jobs.size, 0);
  session.start();
  assert.equal(writes, 1);
  const own = cache.records().find(record => record.writerId === 'writer-a');
  const [timerId] = timers.jobs.keys();
  timers.tick(400);
  session.start();
  session.start();
  assert.equal(writes, 1);
  assert.equal(storage.getItem(own.key), own.raw);
  assert.deepEqual([...timers.jobs.keys()], [timerId]);
  assert.equal(storage.getItem(draft.key), draft.raw);
});

test('clean constructors and start never access storage', () => {
  for (const paused of [false, true]) {
    const cache = new NoteDraftCache({ storageGetter: () => { throw new Error('must stay lazy'); } });
    const { session, timers } = setup({ cache, session: { paused } });
    assert.equal(session.start().dirty, false);
    assert.equal(timers.jobs.size, 0);
  }
});

test('recovery activation reports quota failure for its own copy and keeps conflict safety', async () => {
  for (const baseRevision of [2, 3]) {
    const storage = new MemoryStorage();
    const sourceCache = new NoteDraftCache({ storageGetter: () => storage });
    const draft = sourceCache.write({ noteId: 'note-1', writerId: 'source-tab', baseRevision,
      fields: fields({ content: 'owned copy hits quota' }) });
    storage.failWrite = true;
    const cache = new NoteDraftCache({ storageGetter: () => storage });
    const { session, timers, calls } = setup({ storage, cache, session: { draft, paused: true } });
    const notifications = [];
    session.subscribe(snapshot => notifications.push(snapshot));
    const started = session.start();
    assert.equal(started.cacheDurable, false);
    assert.equal(started.status, baseRevision === 2 ? 'conflict' : 'cache-error');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].cacheDurable, false);
    const pending = cache.pending('note-1', 'writer-a');
    assert.equal(pending.volatile, true);
    assert.equal(pending.baseRevision, baseRevision);
    assert.equal(sourceCache.remove(draft), true);
    assert.equal(cache.latest('note-1').fields.content, draft.fields.content);
    session.start();
    assert.equal(cache.pending('note-1', 'writer-a').raw, pending.raw);
    assert.equal(notifications.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(timers.jobs.size, baseRevision === 2 ? 0 : 1);
    assert.equal(await session.flush(), baseRevision === 3);
    assert.equal(calls.length, baseRevision === 2 ? 0 : 1);
  }
});

test('stale activated recovery has an independent durable copy without an API save', async () => {
  const storage = new MemoryStorage();
  const sourceCache = new NoteDraftCache({ storageGetter: () => storage });
  const draft = sourceCache.write({ noteId: 'note-1', writerId: 'source-tab', baseRevision: 2,
    fields: fields({ content: 'stale but locally protected' }) });
  const { session, timers, calls } = setup({ storage, session: { draft } });
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(session.snapshot().cacheDurable, true);
  sourceCache.remove(draft);
  const reload = new NoteDraftCache({ storageGetter: () => storage });
  const owned = reload.latest('note-1');
  assert.equal(owned.writerId, 'writer-a');
  assert.equal(owned.baseRevision, 2);
  assert.equal(owned.fields.content, draft.fields.content);
  session.start();
  timers.tick(10000);
  assert.equal(await session.flush(), false);
  assert.equal(calls.length, 0);
  assert.equal(timers.jobs.size, 0);
});

test('successful recovered save clears owned copy while guarding newer source raw', async () => {
  const storage = new MemoryStorage();
  const sourceCache = new NoteDraftCache({ storageGetter: () => storage });
  const draft = sourceCache.write({ noteId: 'note-1', writerId: 'source-tab', baseRevision: 3,
    fields: fields({ content: 'recovered snapshot' }) });
  const response = deferred();
  let submitted;
  const { cache, session } = setup({ storage, session: { draft },
    save: payload => { submitted = payload; return response.promise; } });
  const owned = cache.records().find(record => record.writerId === 'writer-a');
  assert.ok(owned);
  const work = session.flush();
  await turns();
  const newerSource = sourceCache.write({ ...draft,
    fields: fields({ content: 'source tab changed while recovered save is in flight' }) });
  response.resolve(metadata(submitted));
  assert.equal(await work, true);
  assert.equal(storage.getItem(owned.key), null);
  assert.equal(storage.getItem(newerSource.key), newerSource.raw);
  const reload = new NoteDraftCache({ storageGetter: () => storage });
  assert.deepEqual(reload.records().map(record => record.raw), [newerSource.raw]);
});

test('paused matching recovery creates no timer until idempotent start activates autosave', async () => {
  const { cache } = setup();
  const draft = cache.write({ noteId: 'note-1', writerId: 'old-writer', baseRevision: 3,
    fields: fields({ content: 'activate after mounting' }) });
  const { session, timers, calls } = setup({ cache, session: { draft, paused: true } });
  assert.equal(session.snapshot().dirty, true);
  assert.equal(timers.jobs.size, 0);
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 0);
  const started = session.start();
  assert.deepEqual(started, session.snapshot());
  assert.equal(timers.jobs.size, 1);
  const [timerId] = timers.jobs.keys();
  timers.tick(400);
  session.start();
  assert.deepEqual([...timers.jobs.keys()], [timerId]);
  timers.tick(499);
  await turns();
  assert.equal(calls.length, 0);
  timers.tick(1);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, 'activate after mounting');
  assert.equal(session.snapshot().status, 'saved');
  session.start();
  assert.equal(timers.jobs.size, 0);
});

test('changes while paused cache immediately but never create autosave timers before start', async () => {
  const { cache, session, timers, calls } = setup({ session: { paused: true } });
  session.change({ content: 'first paused edit' });
  session.change({ content: 'latest paused edit' });
  assert.equal(cache.latest('note-1').fields.content, 'latest paused edit');
  assert.equal(timers.jobs.size, 0);
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 0);
  session.start();
  session.start();
  assert.equal(timers.jobs.size, 1);
  timers.tick(900);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, 'latest paused edit');
  assert.deepEqual(cache.records(), []);
});

test('paused mode preserves explicit flush and stop behavior without allowing restart', async () => {
  const explicit = setup({ session: { paused: true } });
  explicit.session.change({ content: 'explicit save while paused' });
  assert.equal(await explicit.session.flush(), true);
  assert.equal(explicit.calls.length, 1);
  assert.equal(explicit.timers.jobs.size, 0);
  for (const action of ['stop', 'abandon']) {
    const { session, timers, calls } = setup({ session: { paused: true } });
    session.change({ content: 'before editor teardown' });
    await session[action]();
    const count = calls.length;
    assert.equal(count, action === 'stop' ? 1 : 0);
    session.start();
    session.start();
    assert.equal(timers.jobs.size, 0);
    timers.tick(10000);
    await turns();
    assert.equal(calls.length, count);
    assert.throws(() => session.change({ content: 'cannot restart' }), /stopped/);
  }
});

test('start never schedules remote writes for paused stale recovery', async () => {
  const { cache } = setup();
  const draft = cache.write({ noteId: 'note-1', writerId: 'old-writer', baseRevision: 2,
    fields: fields({ content: 'stale before mount' }) });
  const { session, timers, calls } = setup({ cache, session: { draft, paused: true } });
  assert.equal(session.start().status, 'conflict');
  assert.equal(timers.jobs.size, 0);
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 0);
});

test('stale recovered draft stays conflict without remote writes, even on flush or change', async () => {
  const { cache } = setup();
  const draft = cache.write({ noteId: 'note-1', writerId: 'old-writer', baseRevision: 2,
    fields: fields({ content: 'stale recovery' }) });
  const { session, timers, calls } = setup({ cache, session: { draft } });
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(session.snapshot().baseRevision, 2);
  assert.equal(session.snapshot().conflict.serverRevision, 3);
  session.change({ content: 'still protected' });
  timers.tick(10000);
  assert.equal(await session.flush(), false);
  assert.equal(calls.length, 0);
  assert.equal(cache.latest('note-1').fields.content, 'still protected');
});

test('offline saves retain edits and cache; explicit flush retries latest state', async () => {
  const calls = [];
  let online = false;
  const { session, cache, timers } = setup({ save: async payload => {
    calls.push(payload);
    if (!online) throw new Error('network unavailable');
    return metadata(payload);
  } });
  session.change({ content: 'offline text' });
  assert.equal(await session.flush(), false);
  assert.equal(session.snapshot().status, 'offline');
  assert.equal(session.snapshot().dirty, true);
  assert.equal(cache.latest('note-1').fields.content, 'offline text');
  assert.equal(timers.jobs.size, 0);
  session.change({ content: 'latest offline text' });
  online = true;
  assert.equal(await session.flush(), true);
  assert.equal(calls[1].revision, 3);
  assert.equal(calls[1].content, 'latest offline text');
  assert.deepEqual(cache.records(), []);
});

test('reverting to server fields accepts a successful same-revision no-op and clears drafts', async () => {
  const calls = [];
  const original = note();
  const { session, cache, timers } = setup({ save: async payload => {
    calls.push(payload);
    return { ok: true, note: { id: original.id, revision: original.revision, updatedAt: original.updatedAt } };
  } });
  session.change({ content: 'temporary edit' });
  session.change({ content: original.content });
  assert.equal(session.snapshot().dirty, true);
  assert.equal(await session.flush(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, original.content);
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(session.snapshot().dirty, false);
  assert.equal(session.snapshot().baseRevision, original.revision);
  assert.equal(session.snapshot().updatedAt, original.updatedAt);
  assert.equal(session.snapshot().error, null);
  assert.deepEqual(cache.records(), []);
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 1);
});

test('new edits during a successful no-op acknowledgment save next using the unchanged revision', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const { session, cache } = setup({ save: payload => {
    calls.push(payload);
    return calls.length === 1 ? first.promise : second.promise;
  } });
  session.change({ content: 'temporary edit' });
  session.change({ content: note().content });
  const work = session.flush();
  await turns();
  assert.equal(calls[0].revision, 3);
  session.change({ content: 'new raw text while no-op is pending\n' });
  first.resolve(metadata(calls[0], 3));
  await turns();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].revision, 3);
  assert.equal(calls[1].content, 'new raw text while no-op is pending\n');
  assert.equal(cache.latest('note-1').baseRevision, 3);
  assert.equal(cache.latest('note-1').fields.content, calls[1].content);
  second.resolve(metadata(calls[1], 4));
  assert.equal(await work, true);
  assert.equal(session.snapshot().baseRevision, 4);
  assert.equal(session.snapshot().fields.content, calls[1].content);
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(session.snapshot().dirty, false);
  assert.deepEqual(cache.records(), []);
});

test('editing during save keeps latest raw text and serializes against returned revision', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const { session, cache } = setup({ save: payload => {
    calls.push(payload);
    return calls.length === 1 ? first.promise : second.promise;
  } });
  session.change({ content: 'sent snapshot' });
  const work = session.flush();
  await turns();
  session.change({ content: '  newer raw text\n\n', tags: ['two'] });
  assert.equal(calls.length, 1);
  first.resolve(metadata(calls[0], 4));
  await turns();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].revision, 4);
  assert.equal(calls[1].content, '  newer raw text\n\n');
  assert.equal(cache.latest('note-1').baseRevision, 4);
  assert.equal(cache.latest('note-1').fields.content, '  newer raw text\n\n');
  second.resolve(metadata(calls[1], 5));
  assert.equal(await work, true);
  assert.equal(session.snapshot().baseRevision, 5);
  assert.equal(session.snapshot().fields.content, '  newer raw text\n\n');
  assert.deepEqual(session.snapshot().fields.tags, ['two']);
  assert.deepEqual(cache.records(), []);
});

test('failure during an in-flight edit retains newest fields and original revision', async () => {
  const response = deferred();
  const { session, cache } = setup({ save: () => response.promise });
  session.change({ content: 'submitted' });
  const work = session.flush();
  await turns();
  session.change({ content: 'never lose this newer edit' });
  response.reject(new Error('connection lost'));
  assert.equal(await work, false);
  assert.equal(session.snapshot().baseRevision, 3);
  assert.equal(cache.latest('note-1').fields.content, 'never lose this newer edit');
  assert.equal(session.snapshot().fields.content, 'never lose this newer edit');
});

test('version conflict stops all autosave and cannot force overwrite', async () => {
  const calls = [];
  const { session, timers, cache } = setup({ save: async payload => {
    calls.push(payload);
    throw Object.assign(new Error('server changed'), { code: 'CONFLICT', revision: 4 });
  } });
  session.change({ content: 'conflicting edit' });
  assert.equal(await session.flush(), false);
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(session.snapshot().conflict.serverRevision, 4);
  const snapshot = session.snapshot();
  snapshot.conflict.serverRevision = 100;
  assert.equal(session.snapshot().conflict.serverRevision, 4);
  session.change({ content: 'copyable conflicting edit' });
  timers.tick(10000);
  assert.equal(await session.flush(), false);
  assert.equal(calls.length, 1);
  assert.equal(cache.latest('note-1').fields.content, 'copyable conflicting edit');
});

test('remote save succeeds despite quota failures and clears volatile fallback', async () => {
  const storage = new MemoryStorage();
  storage.failWrite = true;
  const { session, cache } = setup({ storage });
  session.change({ content: 'send despite quota' });
  assert.equal(session.snapshot().cacheDurable, false);
  assert.equal(await session.flush(), true);
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(session.snapshot().cacheDurable, true);
  assert.equal(cache.pending('note-1', 'writer-a'), null);
  assert.deepEqual(cache.records(), []);
});

test('delayed cleanup pause then start keeps a new empty note editable for its first short title', async () => {
  const { session, cache, timers, calls } = setup({ session: { paused: true,
    note: note({ revision: 1, content: '', title: 'Untitled', tags: [] }) } });
  let mounted = false;
  let unsubscribe = () => {};
  let notifications = 0;
  const setupEffect = () => {
    mounted = true;
    session.start();
    unsubscribe = session.subscribe(() => notifications += 1);
  };
  const cleanupEffect = () => {
    unsubscribe();
    mounted = false;
    queueMicrotask(() => { if (!mounted) void session.pause(); });
  };
  setupEffect();
  cleanupEffect();
  await turns(); // cleanup really runs before the same instance is set up again
  setupEffect();
  assert.doesNotThrow(() => session.change({ title: 'Short title' }));
  assert.equal(notifications, 1);
  assert.equal(cache.latest('note-1').fields.title, 'Short title');
  assert.equal(timers.jobs.size, 1);
  assert.equal(await session.flush(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].revision, 1);
  assert.equal(session.snapshot().baseRevision, 2);
  assert.equal(session.snapshot().fields.title, 'Short title');
  assert.deepEqual(cache.records(), []);
});

test('pause drains accepted fields once, preserves revision and resumes with guarded cleanup', async () => {
  const { session, cache, storage, timers, calls } = setup();
  const other = cache.write({ noteId: 'note-1', writerId: 'other-tab', baseRevision: 3,
    fields: fields({ content: 'other draft stays recoverable' }) });
  session.change({ title: 'before pause' });
  const work = session.pause();
  assert.equal(session.pause(), work);
  assert.equal(timers.jobs.size, 0);
  assert.equal(await work, true);
  assert.equal(session.pause(), work);
  assert.equal(calls.length, 1);
  assert.equal(session.snapshot().baseRevision, 4);
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(session.snapshot().dirty, false);
  assert.equal(storage.getItem(other.key), other.raw);
  session.start();
  session.change({ title: 'after resume' });
  assert.equal(timers.jobs.size, 1);
  assert.equal(await session.flush(), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].revision, 4);
  assert.equal(calls[1].title, 'after resume');
  assert.equal(session.snapshot().baseRevision, 5);
  assert.deepEqual(cache.records().map(record => record.raw), [other.raw]);
});

test('new edits while paused cache immediately without timers until start', async () => {
  const { session, cache, timers, calls } = setup();
  assert.equal(await session.pause(), true);
  session.change({ title: 'held while paused', content: 'raw paused text\n' });
  const record = cache.latest('note-1');
  assert.equal(record.fields.title, 'held while paused');
  assert.equal(record.fields.content, 'raw paused text\n');
  assert.equal(timers.jobs.size, 0);
  assert.equal(await session.pause(), true); // same already-completed pause drain
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 0);
  session.start();
  session.start();
  assert.equal(timers.jobs.size, 1);
  timers.tick(900);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, 'raw paused text\n');
  assert.deepEqual(cache.records(), []);
});

test('pause failure retains latest cache and repeated cleanup does not retry until resumed', async () => {
  let online = false;
  const calls = [];
  const { session, cache, timers } = setup({ save: async payload => {
    calls.push(payload);
    if (!online) throw new Error('offline during pause');
    return metadata(payload);
  } });
  session.change({ title: 'offline accepted title' });
  const work = session.pause();
  assert.equal(await work, false);
  assert.equal(session.pause(), work);
  session.change({ title: 'newer paused title' });
  assert.equal(session.pause(), work);
  assert.equal(cache.latest('note-1').fields.title, 'newer paused title');
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(timers.jobs.size, 0);
  online = true;
  session.start();
  assert.equal(timers.jobs.size, 1);
  assert.equal(await session.flush(), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, 'newer paused title');
  assert.equal(calls[1].revision, 3);
  assert.deepEqual(cache.records(), []);
});

test('pause during an active save then resume serializes newer fields without duplicate writes', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const { session, cache, timers } = setup({ save: payload => {
    calls.push(payload);
    return calls.length === 1 ? first.promise : second.promise;
  } });
  session.change({ title: 'submitted title' });
  const work = session.flush();
  await turns();
  session.change({ title: 'accepted before pause' });
  assert.equal(session.pause(), work);
  assert.equal(session.pause(), work);
  assert.equal(timers.jobs.size, 0);
  session.start();
  session.change({ title: 'latest resumed title', content: 'resumed raw content\n' });
  assert.equal(calls.length, 1);
  assert.equal(timers.jobs.size, 0);
  first.resolve(metadata(calls[0], 4));
  await turns();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, 'latest resumed title');
  assert.equal(calls[1].content, 'resumed raw content\n');
  assert.equal(calls[1].revision, 4);
  assert.equal(cache.latest('note-1').baseRevision, 4);
  second.resolve(metadata(calls[1], 5));
  assert.equal(await work, true);
  assert.equal(session.snapshot().baseRevision, 5);
  assert.equal(session.snapshot().fields.title, 'latest resumed title');
  assert.deepEqual(cache.records(), []);
});

test('pause can be reentered from save notification without overlapping work', async () => {
  const response = deferred();
  let payload;
  let requests = 0;
  const { session, timers } = setup({ save: input => { requests += 1; payload = input; return response.promise; } });
  let reentered;
  session.subscribe(snapshot => { if (snapshot.status === 'saving') reentered = session.pause(); });
  session.change({ title: 'reentrant pause title' });
  const work = session.pause();
  await turns();
  assert.equal(reentered, work);
  assert.equal(requests, 1);
  assert.equal(timers.jobs.size, 0);
  response.resolve(metadata(payload));
  assert.equal(await work, true);
  session.start();
  assert.doesNotThrow(() => session.change({ title: 'editable after pause' }));
});

test('pause never revives stopped or abandoned sessions or retries terminal failed saves', async () => {
  for (const action of ['stop', 'abandon']) {
    const calls = [];
    const { session, timers, cache } = setup({ save: async payload => {
      calls.push(payload);
      throw new Error('offline terminal request');
    } });
    session.change({ title: 'terminal local edit' });
    await session[action]();
    const before = session.snapshot();
    const count = calls.length;
    assert.equal(await session.pause(), false);
    session.start();
    assert.equal(await session.pause(), false);
    assert.deepEqual(session.snapshot(), before);
    assert.throws(() => session.change({ title: 'must stay stopped' }), /stopped/);
    timers.tick(10000);
    await turns();
    assert.equal(calls.length, count);
    assert.equal(timers.jobs.size, 0);
    if (action === 'stop') assert.equal(cache.latest('note-1').fields.title, 'terminal local edit');
    else assert.deepEqual(cache.records(), []);
  }
});

test('stop cancels debounce, detaches listeners, and attempts one latest flush', async () => {
  const { session, timers, calls, cache } = setup();
  let notifications = 0;
  session.subscribe(() => notifications += 1);
  session.change({ content: 'unmount text' });
  assert.equal(notifications, 1);
  assert.equal(await session.stop(), true);
  assert.equal(notifications, 1);
  assert.equal(calls.length, 1);
  assert.equal(timers.jobs.size, 0);
  assert.deepEqual(cache.records(), []);
  assert.throws(() => session.change({ content: 'after stop' }), /stopped/);
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 1);
});

test('stop during an in-flight save drains newer accepted edits without timers', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const { session, timers, cache } = setup({ save: payload => {
    calls.push(payload);
    return calls.length === 1 ? first.promise : second.promise;
  } });
  session.change({ content: 'first' });
  const work = session.flush();
  await turns();
  session.change({ content: 'newer before unmount' });
  const stopped = session.stop();
  assert.equal(stopped, work);
  first.resolve(metadata(calls[0]));
  await turns();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].content, 'newer before unmount');
  assert.equal(timers.jobs.size, 0);
  second.resolve(metadata(calls[1]));
  assert.equal(await stopped, true);
  assert.deepEqual(cache.records(), []);
});

test('failed stop retains fallback without retry loops', async () => {
  const calls = [];
  const { session, timers, cache } = setup({ save: async payload => {
    calls.push(payload);
    throw new Error('offline on unmount');
  } });
  session.change({ content: 'recover after unmount' });
  assert.equal(await session.stop(), false);
  timers.tick(100000);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(timers.jobs.size, 0);
  assert.equal(cache.latest('note-1').fields.content, 'recover after unmount');
});

test('successful cleanup and abandon preserve unrelated tabs and guard updated raw', async () => {
  const { session, cache, storage } = setup();
  const another = cache.write({ noteId: 'note-1', writerId: 'other-tab', baseRevision: 3,
    fields: fields({ content: 'another tab unsaved' }) });
  session.change({ content: 'my saved text' });
  assert.equal(await session.flush(), true);
  assert.equal(cache.records().length, 1);
  assert.equal(storage.getItem(another.key), another.raw);
  const draft = cache.write({ noteId: 'note-1', writerId: 'recovering-tab', baseRevision: 2,
    fields: fields({ content: 'old conflict' }) });
  const next = setup({ cache, storage, session: { draft, writerId: 'new-session' } });
  next.session.change({ content: 'copy this' });
  assert.equal(next.session.abandon(), true);
  assert.deepEqual(cache.records().map(record => record.writerId), ['other-tab']);
  assert.equal(await next.session.flush(), false);
});

test('successful session save never removes a newer raw value written by another cache', async () => {
  const response = deferred();
  let payload;
  const { session, storage, cache } = setup({ save: input => { payload = input; return response.promise; } });
  session.change({ content: 'submitted snapshot' });
  const submitted = cache.latest('note-1');
  const work = session.flush();
  await turns();
  const otherTab = new NoteDraftCache({ storageGetter: () => storage });
  const newer = otherTab.write({ ...submitted, fields: fields({ content: 'another tab newer raw' }) });
  response.resolve(metadata(payload));
  assert.equal(await work, true);
  assert.equal(storage.getItem(newer.key), newer.raw);
  assert.equal(cache.latest('note-1').fields.content, 'another tab newer raw');
});

test('stop after abandon cancels pending edits without submitting old fields', async () => {
  const { session, calls, timers, cache } = setup();
  session.change({ content: 'discard after explicit reload choice' });
  assert.equal(session.abandon(), true);
  assert.equal(await session.stop(), false);
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 0);
  assert.equal(timers.jobs.size, 0);
  assert.deepEqual(cache.records(), []);
});

test('stop after in-flight abandon never submits newer old-session fields or recreates cache', async () => {
  const response = deferred();
  const calls = [];
  const { session, cache, timers } = setup({ save: input => { calls.push(input); return response.promise; } });
  session.change({ content: 'sent' });
  const work = session.flush();
  await turns();
  session.change({ content: 'copy completed elsewhere' });
  session.abandon();
  const stopped = session.stop();
  assert.equal(stopped, work);
  response.resolve(metadata(calls[0]));
  assert.equal(await stopped, false);
  timers.tick(10000);
  await turns();
  assert.equal(calls.length, 1);
  assert.equal(timers.jobs.size, 0);
  assert.deepEqual(cache.records(), []);
});

test('clean remote updates preserve the session and subscriptions with exact large-body fields', () => {
  const cache = new NoteDraftCache({ storageGetter: () => { throw new Error('clean receive must not use storage'); } });
  const { session, calls, timers } = setup({ cache });
  const seen = [];
  const unsubscribe = session.subscribe(snapshot => seen.push(snapshot));
  const remote = note({ revision: 4, content: multiMegabyteBody(), title: 'Remote title',
    category: 'journal', pinned: true, tags: ['remote', 'exact'], journalDate: '2028-02-29',
    updatedAt: '2026-02-01T00:00:00.000Z', trashedAt: '' });
  assert.equal(session.receiveRemote(remote), true);
  assert.deepEqual(session.snapshot().fields, fields({ content: remote.content, title: remote.title,
    category: remote.category, pinned: true, tags: ['remote', 'exact'], journalDate: remote.journalDate }));
  assert.equal(session.snapshot().baseRevision, 4);
  assert.equal(session.snapshot().updatedAt, remote.updatedAt);
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(session.snapshot().dirty, false);
  assert.equal(session.snapshot().error, null);
  assert.equal(seen.length, 1);
  remote.tags.push('caller mutation');
  seen[0].fields.tags.push('subscriber mutation');
  assert.deepEqual(session.snapshot().fields.tags, ['remote', 'exact']);
  assert.equal(session.receiveRemote(note({ revision: 5, title: 'Next title', category: 'code', pinned: false })), true);
  assert.equal(seen.length, 2);
  assert.equal(session.snapshot().fields.title, 'Next title');
  assert.equal(session.snapshot().fields.category, 'code');
  assert.equal(session.snapshot().fields.pinned, false);
  assert.equal(timers.jobs.size, 0);
  assert.equal(calls.length, 0);
  unsubscribe();
});

test('remote validation is atomic, including invalid stale notes and unrelated IDs', () => {
  const { session, storage, cache, timers } = setup();
  session.change({ content: 'local text stays intact' });
  const before = session.snapshot();
  const raw = cache.latest('note-1');
  const timerIds = [...timers.jobs.keys()];
  let notifications = 0;
  session.subscribe(() => notifications += 1);
  for (const remote of [null, note({ id: 'other-note', revision: 4 }),
    note({ revision: -1 }), note({ revision: 3.5 }), note({ revision: Number.MAX_SAFE_INTEGER + 1 }),
    note({ revision: 4, content: null }), note({ revision: 4, content: undefined }),
    note({ revision: 4, title: 'x'.repeat(201) }), note({ revision: 4, category: 'invalid' }),
    note({ revision: 4, tags: ['same', 'same'] }), note({ revision: 4, pinned: 'true' }),
    note({ revision: 4, journalDate: '2027-02-29' }), note({ revision: 4, updatedAt: {} }),
    note({ revision: 4, updatedAt: 'not a timestamp' }), note({ revision: 2, content: 123 })]) {
    assert.throws(() => session.receiveRemote(remote), TypeError);
    assert.deepEqual(session.snapshot(), before);
    assert.equal(storage.getItem(raw.key), raw.raw);
    assert.deepEqual([...timers.jobs.keys()], timerIds);
  }
  assert.equal(notifications, 0);
});

test('stale references and trashed notes never replace clean or dirty session state', () => {
  for (const dirty of [false, true]) {
    const { session, cache, timers } = setup();
    if (dirty) session.change({ content: 'unsaved local' });
    const before = session.snapshot();
    const records = cache.records();
    const timerIds = [...timers.jobs.keys()];
    for (const remote of [note({ revision: 2, title: 'old' }), note({ revision: 3, content: 'same revision' }),
      note({ revision: 4, trashedAt: '2026-02-01T00:00:00.000Z' }), note({ revision: 4, trashed: true })]) {
      assert.equal(session.receiveRemote(remote), false);
      assert.deepEqual(session.snapshot(), before);
      assert.deepEqual(cache.records(), records);
      assert.deepEqual([...timers.jobs.keys()], timerIds);
    }
  }
});

test('differing remote edits create a conflict without touching local text or durable raw', async () => {
  const { session, cache, storage, timers, calls } = setup();
  session.change({ content: 'local content\n', title: 'Local title', tags: ['local'] });
  const local = session.snapshot();
  const record = cache.latest('note-1');
  assert.equal(session.receiveRemote(note({ revision: 8, content: 'model content', title: 'Model title' })), false);
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(session.snapshot().error.code, 'CONFLICT');
  assert.equal(session.snapshot().conflict.serverRevision, 8);
  assert.equal(session.snapshot().baseRevision, 3);
  assert.equal(session.snapshot().updatedAt, local.updatedAt);
  assert.deepEqual(session.snapshot().fields, local.fields);
  assert.equal(session.snapshot().dirty, true);
  assert.equal(session.snapshot().cacheDurable, true);
  assert.equal(storage.getItem(record.key), record.raw);
  assert.equal(timers.jobs.size, 0);
  const conflicted = session.snapshot();
  assert.equal(session.receiveRemote(note({ revision: 6, ...local.fields })), false);
  assert.deepEqual(session.snapshot(), conflicted);
  session.change({ content: 'local content still editable for copy\n' });
  timers.tick(10000);
  assert.equal(await session.flush(), false);
  assert.equal(calls.length, 0);
  assert.equal(cache.latest('note-1').fields.content, 'local content still editable for copy\n');
});

test('remote conflict preserves quota fallback and truthful durability until matching acknowledgment', () => {
  const storage = new MemoryStorage();
  storage.failWrite = true;
  const { session, cache } = setup({ storage });
  session.change({ content: 'volatile local text' });
  const draft = cache.pending('note-1', 'writer-a');
  assert.equal(session.receiveRemote(note({ revision: 4, content: 'different remote text' })), false);
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(session.snapshot().cacheDurable, false);
  assert.equal(cache.pending('note-1', 'writer-a').raw, draft.raw);
  assert.equal(session.receiveRemote(note({ revision: 4, ...session.snapshot().fields })), true);
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(cache.pending('note-1', 'writer-a'), null);
  assert.deepEqual(cache.records(), []);
});

test('equal remote acknowledgment cleans only captured raw records and preserves newer source drafts', async () => {
  const storage = new MemoryStorage();
  const sourceCache = new NoteDraftCache({ storageGetter: () => storage });
  const draft = sourceCache.write({ noteId: 'note-1', writerId: 'source-tab', baseRevision: 3,
    fields: fields({ content: 'already saved by the coauthor', tags: ['shared'] }) });
  const { session, cache, calls, timers } = setup({ storage, session: { draft } });
  const own = cache.records().find(record => record.writerId === 'writer-a');
  const newerSource = sourceCache.write({ ...draft, fields: fields({ content: 'source tab newer unsaved text' }) });
  const unrelated = sourceCache.write({ noteId: 'note-1', writerId: 'unrelated-tab', baseRevision: 3,
    fields: fields({ content: 'unrelated unsaved draft' }) });
  assert.equal(session.receiveRemote(note({ revision: 4, ...draft.fields,
    updatedAt: '2026-02-02T00:00:00.000Z' })), true);
  assert.equal(session.snapshot().baseRevision, 4);
  assert.equal(session.snapshot().dirty, false);
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(session.snapshot().conflict, null);
  assert.equal(storage.getItem(own.key), null);
  assert.equal(storage.getItem(newerSource.key), newerSource.raw);
  assert.equal(storage.getItem(unrelated.key), unrelated.raw);
  assert.equal(timers.jobs.size, 0);
  assert.equal(await session.flush(), true);
  assert.equal(calls.length, 0);
});

test('matching latest remote state can acknowledge a prior conflict outside an active save', () => {
  const { session, cache } = setup();
  session.change({ content: 'local text now matches latest server note' });
  assert.equal(session.receiveRemote(note({ revision: 8, content: 'different server text' })), false);
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(session.receiveRemote(note({ revision: 8, ...session.snapshot().fields })), true);
  assert.equal(session.snapshot().status, 'saved');
  assert.equal(session.snapshot().dirty, false);
  assert.equal(session.snapshot().baseRevision, 8);
  assert.equal(session.snapshot().conflict, null);
  assert.equal(session.snapshot().error, null);
  assert.deepEqual(cache.records(), []);
});

test('remote conflict before a queued save starts prevents any API request', async () => {
  const { session, calls, cache } = setup();
  session.change({ content: 'queued local save' });
  const work = session.flush();
  assert.equal(session.receiveRemote(note({ revision: 4, content: 'remote arrived first' })), false);
  assert.equal(await work, false);
  assert.equal(calls.length, 0);
  assert.equal(cache.latest('note-1').fields.content, 'queued local save');
});

test('older in-flight success or failure cannot erase a newer received conflict or latest local draft', async () => {
  for (const outcome of ['success', 'offline', 'conflict']) {
    const response = deferred();
    const calls = [];
    const { session, cache, storage, timers } = setup({ save: payload => {
      calls.push(payload);
      return response.promise;
    } });
    session.change({ content: 'submitted local snapshot' });
    const work = session.flush();
    await turns();
    session.change({ content: 'newer accepted local text' });
    const raw = cache.latest('note-1');
    assert.equal(session.receiveRemote(note({ revision: 9, content: 'newer model edit' })), false);
    const conflicted = session.snapshot();
    if (outcome === 'success') response.resolve(metadata(calls[0], 4));
    else response.reject(Object.assign(new Error('old request failed'), outcome === 'conflict' ? { code: 'CONFLICT', revision: 4 } : {}));
    assert.equal(await work, false);
    assert.deepEqual(session.snapshot(), conflicted);
    assert.equal(session.snapshot().conflict.serverRevision, 9);
    assert.equal(storage.getItem(raw.key), raw.raw);
    timers.tick(10000);
    assert.equal(await session.flush(), false);
    assert.equal(calls.length, 1);
    assert.equal(timers.jobs.size, 0);
  }
});

test('matching remote fields during an active save retain a conflict until the save settles', async () => {
  const response = deferred();
  let payload;
  const { session, cache } = setup({ save: input => { payload = input; return response.promise; } });
  session.change({ content: 'same text as remote but request still pending' });
  const work = session.flush();
  await turns();
  const remote = note({ revision: 4, ...session.snapshot().fields });
  assert.equal(session.receiveRemote(remote), false);
  assert.equal(session.snapshot().status, 'conflict');
  assert.equal(session.snapshot().dirty, true);
  response.resolve(metadata(payload));
  assert.equal(await work, false);
  assert.equal(cache.latest('note-1').fields.content, remote.content);
  assert.equal(session.receiveRemote(remote), true);
  assert.equal(session.snapshot().baseRevision, 4);
  assert.equal(session.snapshot().dirty, false);
  assert.deepEqual(cache.records(), []);
});

test('clean remote update during old flush finalization survives without revision regression', async () => {
  const response = deferred();
  let payload;
  let requests = 0;
  const { session, cache } = setup({ save: input => { requests += 1; payload = input; return response.promise; } });
  let accepted = false;
  session.subscribe(snapshot => {
    if (snapshot.status === 'saved' && snapshot.baseRevision === 4) {
      accepted = session.receiveRemote(note({ revision: 10, title: 'Latest remote title',
        category: 'reading', pinned: true, content: 'remote text received before flush promise settles' }));
    }
  });
  session.change({ content: 'older local save' });
  const work = session.flush();
  await turns();
  response.resolve(metadata(payload, 4));
  assert.equal(await work, true);
  assert.equal(accepted, true);
  assert.equal(session.snapshot().baseRevision, 10);
  assert.equal(session.snapshot().fields.title, 'Latest remote title');
  assert.equal(session.snapshot().fields.category, 'reading');
  assert.equal(session.snapshot().fields.pinned, true);
  assert.equal(session.snapshot().fields.content, 'remote text received before flush promise settles');
  assert.equal(session.snapshot().dirty, false);
  assert.deepEqual(cache.records(), []);
  assert.equal(requests, 1);
});

test('stopped or abandoned sessions cannot receive remote changes or restart autosave', async () => {
  for (const action of ['stop', 'abandon']) {
    const { session, timers, calls } = setup();
    await session[action]();
    const before = session.snapshot();
    assert.equal(session.receiveRemote(note({ revision: 4, content: 'arrived after teardown' })), false);
    assert.deepEqual(session.snapshot(), before);
    session.start();
    timers.tick(10000);
    await turns();
    assert.equal(timers.jobs.size, 0);
    assert.equal(calls.length, 0);
  }
});

test('synchronous API errors and invalid metadata retain recoverable drafts', async () => {
  for (const save of [() => { throw new Error('sync failure'); },
    async payload => ({ ok: true, note: { id: payload.id, revision: payload.revision - 1 } }),
    async () => ({ ok: false })]) {
    const { session, cache } = setup({ save });
    session.change({ content: 'keep on bad response' });
    assert.equal(await session.flush(), false);
    assert.equal(session.snapshot().status, 'offline');
    assert.equal(cache.latest('note-1').fields.content, 'keep on bad response');
  }
});
