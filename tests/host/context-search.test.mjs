import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { NotesStore } from '../../src/host/notes/store.js';
import { ContextSearch } from '../../src/host/search/context-search.js';

class Table {
  records = new Map();
  scans = 0;
  gets = [];
  onEntry = null;
  get(id) { this.gets.push(id); return this.records.get(id); }
  async *entries() {
    this.scans++;
    let count = 0;
    for (const entry of this.records) {
      yield entry;
      this.onEntry?.(++count);
    }
  }
  put(id, value) { this.records.set(id, value); }
  delete(id) { this.records.delete(id); }
}
function fixture(count = 0) {
  const table = new Table(), versions = new Table();
  let ticks = 1000;
  const clock = () => new Date(Date.UTC(2026, 10, 1) + ticks++).toISOString();
  const notes = new NotesStore(table, versions, clock);
  const records = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(), title: `Note ${i}`, content: `body ${i}`,
    tags: [], category: 'document', pinned: false, journalDate: '', trashedAt: '',
    createdAt: new Date(Date.UTC(2026, 10, 1) + i).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 10, 1) + i).toISOString(), revision: 1,
  }));
  for (const record of records) table.records.set(record.id, structuredClone(record));
  const search = new ContextSearch({ notes });
  return { table, versions, notes, records, search,
    find: (query, options = {}) => search.execute({ action: 'search', query, ...options }),
  };
}
const codeIs = code => error => error?.code === code;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('101 notes remain searchable when a queued update promotes the last-page note', async () => {
  const f = fixture(101), target = f.records[0];
  f.table.records.get(target.id).content = 'lastpage needle';
  let update;
  f.table.onEntry = count => {
    if (count !== 100 || update) return;
    // This note would move from the second list page into the first page.
    // A list(offset)/get search loses it when the update runs between pages.
    update = f.notes.execute({ action: 'update', id: target.id, revision: 1,
      pinned: true, content: 'promoted replacement' });
  };
  const result = await f.find('lastpage');
  assert.equal(result.total, 1);
  assert.equal(result.results[0].ref.id, target.id);
  assert.equal(result.results[0].ref.revision, 1);
  assert.equal(result.results[0].snippet, 'lastpage needle');
  await update;
  assert.equal(f.table.scans, 1);
  assert.deepEqual(f.table.gets, [target.id]); // the queued update's sole get
  f.table.onEntry = null;
  assert.equal((await f.find('lastpage')).total, 0);
  assert.equal((await f.find('promoted')).results[0].ref.revision, 2);
});

test('full search uses one snapshot, zero public list/get operations, including trash', async () => {
  const f = fixture(3);
  f.table.records.get(f.records[2].id).trashedAt = '2026-11-01T00:00:01.000Z';
  const execute = f.notes.execute.bind(f.notes);
  const actions = [];
  f.notes.execute = input => { actions.push(input.action); return execute(input); };
  let snapshots = 0;
  const snapshot = f.notes.searchSnapshot.bind(f.notes);
  f.notes.searchSnapshot = () => { snapshots++; return snapshot(); };
  assert.equal((await f.find('body', { includeTrashed: true })).total, 3);
  assert.equal(snapshots, 1);
  assert.equal(f.table.scans, 1);
  assert.deepEqual(actions, []);
  assert.deepEqual(f.table.gets, []);
  assert.equal((await f.find('body')).total, 2);
  assert.equal(snapshots, 2);
  assert.equal(f.table.scans, 2);
});

test('snapshot shares the write queue, returns detached records, and recovers after errors', async () => {
  const f = fixture(1), record = f.records[0];
  const entered = deferred(), release = deferred();
  const entries = f.table.entries.bind(f.table);
  f.table.entries = async function* () {
    entered.resolve();
    await release.promise;
    yield* entries();
  };
  const before = f.notes.execute({ action: 'update', id: record.id, revision: 1, title: 'before' });
  const snapshot = f.notes.searchSnapshot();
  await entered.promise;
  let afterFinished = false;
  const after = f.notes.execute({ action: 'update', id: record.id, revision: 2, title: 'after' })
    .then(result => { afterFinished = true; return result; });
  await nextTurn();
  assert.equal(afterFinished, false);
  release.resolve();
  await before;
  const captured = await snapshot;
  assert.equal(captured[0].title, 'before');
  assert.equal(captured[0].revision, 2);
  await after;
  assert.equal(captured[0].title, 'before');
  captured[0].tags.push('caller mutation');
  assert.deepEqual((await f.notes.execute({ action: 'get', id: record.id })).note.tags, []);
  f.table.entries = () => { throw new Error('fixture scan failure'); };
  await assert.rejects(f.notes.searchSnapshot(), /fixture scan failure/);
  assert.equal((await f.notes.execute({ action: 'get', id: record.id })).note.title, 'after');
});

test('documentId searches use a single direct get without scanning or pruning unrelated cache', async () => {
  const f = fixture(3);
  await f.find('body');
  const other = f.search.cache.get(`note:${f.records[1].id}`);
  f.table.scans = 0;
  f.table.gets = [];
  f.notes.searchSnapshot = () => { throw new Error('must not scan'); };
  f.table.entries = () => { throw new Error('must not enumerate'); };
  const result = await f.find('body', { documentId: f.records[0].id });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].ref.id, f.records[0].id);
  assert.deepEqual(f.table.gets, [f.records[0].id]);
  assert.equal(f.table.scans, 0);
  assert.equal(f.search.cache.get(`note:${f.records[1].id}`), other);
  const missingId = randomUUID();
  assert.equal((await f.find('body', { documentId: missingId })).total, 0);
  assert.equal((await f.find('body', { documentId: 'unknown-document' })).total, 0);
});

test('cache reuses unchanged atoms, refreshes content/metadata, and prunes missing records', async () => {
  const f = fixture(2), record = f.records[0], key = `note:${record.id}`;
  await f.find('body');
  const cached = f.search.cache.get(key);
  const initialAtoms = cached.atoms;
  const initialId = initialAtoms[0].atomId;
  await f.find('body');
  assert.equal(f.search.cache.get(key), cached);
  await f.notes.execute({ action: 'update', id: record.id, revision: 1,
    title: 'newtitle', content: 'replacement', tags: ['newtag'] });
  const updated = await f.find('newtag');
  assert.equal(updated.total, 1);
  assert.equal(updated.results[0].title, 'newtitle');
  assert.deepEqual(updated.results[0].tags, ['newtag']);
  assert.notEqual(updated.results[0].atomId, initialId);
  assert.notEqual(f.search.cache.get(key).atoms, initialAtoms);
  updated.results[0].tags.push('result mutation');
  assert.deepEqual((await f.find('newtag')).results[0].tags, ['newtag']);
  f.table.records.delete(record.id);
  await f.find('replacement');
  assert.equal(f.search.cache.has(key), false);
});

test('fingerprints detect same-length source replacement even if persisted revision metadata is unchanged', async () => {
  const f = fixture(1), record = f.records[0];
  const original = (await f.find('body')).results[0];
  // Simulate an imported/repaired table row that retained revision and time.
  f.table.records.get(record.id).content = 'edit 0';
  await assert.rejects(f.search.execute({ action: 'read', atomId: original.atomId }), codeIs('CONFLICT'));
  assert.equal((await f.find('body')).total, 0);
  const replacement = (await f.find('edit')).results[0];
  assert.notEqual(replacement.ref.fingerprint, original.ref.fingerprint);
  assert.equal(replacement.ref.revision, original.ref.revision);
});

test('trash, restore, stale/missing reads and ctx1 reference format retain their behavior', async () => {
  const f = fixture(1), record = f.records[0];
  const original = (await f.find('body')).results[0];
  assert.ok(original.atomId.startsWith('ctx1:'));
  assert.deepEqual(JSON.parse(decodeURIComponent(original.atomId.slice(5))), original.ref);
  const read = await f.search.execute({ action: 'read', atomId: original.atomId, limit: 2 });
  assert.equal(read.content, 'bo');
  assert.equal(read.nextStart, 2);
  assert.equal((await f.search.execute({ action: 'read', atomId: read.nextAtomId })).content, 'dy 0');
  await f.notes.execute({ action: 'trash', id: record.id, revision: 1 });
  assert.equal((await f.find('body')).total, 0);
  assert.equal((await f.find('body', { documentId: record.id })).total, 0);
  const trashed = (await f.find('body', { includeTrashed: true })).results[0];
  assert.ok(trashed.trashedAt);
  await assert.rejects(f.search.execute({ action: 'read', atomId: original.atomId }), codeIs('TRASHED'));
  await assert.rejects(f.search.execute({ action: 'read', atomId: original.atomId, includeTrashed: true }), codeIs('CONFLICT'));
  assert.equal((await f.search.execute({ action: 'read', atomId: trashed.atomId, includeTrashed: true })).content, 'body 0');
  await f.notes.execute({ action: 'restore', id: record.id, revision: 2 });
  assert.equal((await f.find('body')).total, 1);
  await assert.rejects(f.search.execute({ action: 'read', atomId: trashed.atomId }), codeIs('CONFLICT'));
  const current = (await f.find('body')).results[0];
  await f.notes.execute({ action: 'update', id: record.id, revision: 3, content: 'changed' });
  await assert.rejects(f.search.execute({ action: 'read', atomId: current.atomId }), codeIs('CONFLICT'));
  f.table.records.delete(record.id);
  await assert.rejects(f.search.execute({ action: 'read', atomId: current.atomId }), codeIs('MISSING'));
});

test('lexical ranking, Chinese matching, bounded UTF-16 snippets and chunk continuation', async () => {
  const f = fixture(2);
  f.table.records.get(f.records[0].id).content = '# 标题\n\n知识库 ' + '😀'.repeat(1800);
  f.table.records.get(f.records[1].id).title = '知识库';
  const result = await f.find('知识库', { limit: 1, snippetLimit: 9 });
  assert.equal(result.total >= 2, true);
  assert.equal(result.truncated, true);
  assert.equal(result.results.length, 1);
  const all = await f.find('知识库', { documentId: f.records[0].id, snippetLimit: 9 });
  assert.ok(all.results.every(hit => hit.snippet.length <= 9));
  const hit = all.results[0];
  const first = await f.search.execute({ action: 'read', atomId: hit.atomId, limit: 17 });
  assert.ok(!/[\uD800-\uDBFF]$/.test(first.content));
  const next = await f.search.execute({ action: 'read', atomId: first.nextAtomId });
  const source = f.table.records.get(f.records[0].id).content;
  assert.equal(first.content + next.content, source.slice(hit.ref.start, hit.ref.end));
});
