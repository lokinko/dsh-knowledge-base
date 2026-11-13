import test from 'node:test';
import assert from 'node:assert/strict';
import { NotesStore, noteSchema, noteVersionSchema } from '../../src/host/notes/store.js';

// All fixtures are in-memory. Deliberately return stored references so clone
// assertions exercise the store rather than hiding aliasing in the adapter.
class Table {
  records = new Map();
  writes = 0;
  failPut = false;
  failDelete = false;
  get(key) { return this.records.get(key); }
  entries() { return this.records.entries(); }
  async put(key, value) {
    if (this.failPut) throw new Error('fixture history write failed');
    this.writes++;
    this.records.set(key, value);
  }
  async delete(key) {
    if (this.failDelete) throw new Error('fixture history delete failed');
    this.records.delete(key);
  }
}
function fixture() {
  const notes = new Table();
  const versions = new Table();
  let milliseconds = Date.parse('2026-11-05T03:00:00.000Z');
  const store = new NotesStore(notes, versions, () => new Date(milliseconds).toISOString());
  return { notes, versions, store,
    advance: (amount = 1000) => { milliseconds += amount; },
    run: input => store.execute(input),
  };
}
const full = async (f, id) => (await f.run({ action: 'get', id })).note;
const create = async (f, fields = {}) => (await f.run({ action: 'create', ...fields })).note;
const update = async (f, note, fields) => (await f.run({ action: 'update', id: note.id, revision: note.revision, ...fields })).note;
const codeIs = code => error => error instanceof Error && error.code === code;

// The API is exercised via execute, with schemas also checked directly for consumers.
test('create defaults, schemas, metadata, get, and defensive copies', async () => {
  const f = fixture();
  const defaults = await create(f);
  assert.equal(defaults.title, 'Untitled');
  assert.equal(defaults.category, 'document');
  assert.equal(defaults.pinned, false);
  assert.equal(defaults.journalDate, '');
  assert.equal(defaults.trashedAt, '');
  assert.equal(defaults.revision, 1);
  assert.equal(defaults.contentLength, 0);
  assert.equal('content' in defaults, false);
  assert.equal(noteSchema.parse(await full(f, defaults.id)).content, '');
  const tags = ['Alpha'];
  const request = { action: 'create', title: ' Original ', content: 'body', tags };
  const pending = f.run(request);
  tags.push('caller mutation');
  request.content = 'caller mutation';
  const created = (await pending).note;
  created.tags.push('metadata mutation');
  const firstRead = await full(f, created.id);
  assert.equal(firstRead.title, ' Original ');
  assert.equal(firstRead.content, 'body');
  assert.deepEqual(firstRead.tags, ['Alpha']);
  firstRead.tags.push('get mutation');
  firstRead.content = 'get mutation';
  assert.deepEqual((await full(f, created.id)).tags, ['Alpha']);
  assert.equal((await full(f, created.id)).content, 'body');
  assert.deepEqual(JSON.parse(JSON.stringify(created)), created);
});

test('list searches title/content/tags, filters, counts, pagination and deterministic ordering', async () => {
  const f = fixture();
  const a = await create(f, { title: 'TITLE Match', tags: ['MixedTag'] });
  f.advance();
  const b = await create(f, { title: 'Reading', content: 'deep Needle text', category: 'reading', tags: ['work'] });
  f.advance();
  const c = await create(f, { title: 'Code', category: 'code', pinned: true, tags: ['work'] });
  const d = await create(f, { title: 'Also pinned', category: 'journal', pinned: true });
  const expectedPins = [c.id, d.id].sort();
  const result = await f.run({ action: 'list' });
  assert.deepEqual(result.notes.map(n => n.id), [...expectedPins, b.id, a.id]);
  assert.deepEqual(result.counts, { all: 4, document: 1, reading: 1, code: 1, journal: 1, trash: 0 });
  assert.equal(result.offset, 0);
  assert.equal(result.limit, 50);
  assert.ok(result.notes.every(n => !('content' in n)));
  for (const [query, id] of [['title MATCH', a.id], ['NEEDLE', b.id], ['mixedtag', a.id]]) {
    const found = await f.run({ action: 'list', query });
    assert.deepEqual(found.notes.map(n => n.id), [id]);
    assert.deepEqual(found.counts, result.counts);
  }
  assert.equal((await f.run({ action: 'list', category: 'reading' })).notes[0].id, b.id);
  assert.deepEqual((await f.run({ action: 'list', tag: 'work', pinnedOnly: true })).notes.map(n => n.id), [c.id]);
  const page = await f.run({ action: 'list', offset: 1, limit: 2 });
  assert.equal(page.total, 4);
  assert.deepEqual(page.notes.map(n => n.id), result.notes.slice(1, 3).map(n => n.id));
  assert.equal((await f.run({ action: 'list', offset: 100 })).notes.length, 0);
});

test('library can request bounded longer excerpts without changing directory defaults or stored note bytes',async()=>{
 const f=fixture(),content='# Long note\r\n'+('正文与链接 https://example.com/source\r\n'.repeat(100));
 const note=await create(f,{content});const writes=f.notes.writes;
 assert.equal((await f.run({action:'list'})).notes[0].excerpt,content.slice(0,160));
 const listed=(await f.run({action:'list',excerptLength:1600})).notes[0];
 assert.equal(listed.excerpt,content.slice(0,1600));assert.equal('content' in listed,false);
 assert.equal((await f.run({action:'list',excerptLength:0})).notes[0].excerpt,'');
 for(const excerptLength of [-1,1601,1.5])await assert.rejects(f.run({action:'list',excerptLength}));
 assert.equal((await full(f,note.id)).content,content);assert.equal(f.notes.writes,writes);
});

test('multi-MB Markdown preserves whitespace, CRLF and Unicode through storage and history restore', async () => {
  const f = fixture();
  const segment = '  # 标题 😀\r\n\r\n```js\r\n  let x = 1;  \r\n```\r\n\t\r\n';
  const markdown = segment.repeat(80000);
  assert.ok(markdown.length > 2000000);
  let note = await create(f, { content: markdown });
  assert.equal((await full(f, note.id)).content, markdown);
  assert.equal(note.contentLength, markdown.length);
  assert.equal(note.excerpt, markdown.slice(0, 160));
  const replacement = `\r\n更新 🧪\r\n${markdown}\r\n  `;
  note = await update(f, note, { content: replacement });
  assert.equal(note.contentLength, replacement.length);
  assert.equal((await full(f, note.id)).content, replacement);
  const history = await f.run({ action: 'versions', id: note.id });
  const versionId = history.versions[0].versionId;
  const saved = await f.run({ action: 'version', id: note.id, versionId });
  assert.equal(saved.version.content, markdown);
  assert.equal(noteVersionSchema.parse(saved.version).noteId, note.id);
  // Rehydrate JSON records using a fresh store, matching the unchanged domain shape.
  for (const table of [f.notes, f.versions]) {
    table.records = new Map(JSON.parse(JSON.stringify([...table.records])));
  }
  const reloaded = new NotesStore(f.notes, f.versions);
  assert.equal((await reloaded.execute({ action: 'get', id: note.id })).note.content, replacement);
  const restored = await reloaded.execute({ action: 'restore_version', id: note.id,
    revision: note.revision, versionId });
  assert.equal(restored.note.contentLength, markdown.length);
  assert.equal((await reloaded.execute({ action: 'get', id: note.id })).note.content, markdown);
  const previous = await reloaded.execute({ action: 'version', id: note.id, versionId: `${note.id}:2` });
  assert.equal(previous.version.content, replacement);
});

test('boundary validation rejects invalid inputs without changing either table', async () => {
  const f = fixture();
  const invalidCreate = [
    { title: 'x'.repeat(201) }, { title: 123 },
    { content: null }, { category: 'other' }, { pinned: 'true' },
    { tags: [''] }, { tags: ['x'.repeat(41)] }, { tags: ['same', 'same'] },
    { tags: Array.from({ length: 21 }, (_, i) => String(i)) },
    { tags: 'tag' }, { journalDate: '2025-02-29' }, { journalDate: '2026-02-30' },
    { journalDate: '2026-13-01' }, { journalDate: '2026-1-01' },
    { id: 'caller-id' }, { unknown: true }, { trashedAt: '' },
  ];
  for (const fields of invalidCreate) await assert.rejects(f.run({ action: 'create', ...fields }));
  for (const input of [null, [], {}, { action: 'delete' }, { action: 'invented' },
    { action: 'get', id: 'bad' }, { action: 'list', limit: 0 }, { action: 'list', limit: 101 },
    { action: 'list', offset: -1 }, { action: 'list', offset: 0.5 }, { action: 'list', trashed: 'false' },
    { action: 'list', category: '' }, { action: 'list', tag: '' },
    { action: 'journal' }, { action: 'journal', date: '2026-02-29' }]) {
    await assert.rejects(f.run(input));
  }
  assert.equal(f.notes.records.size, 0);
  assert.equal(f.versions.records.size, 0);
  const allowed = await create(f, { title: 'x'.repeat(200), content: '',
    tags: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(40, 'x')), journalDate: '2024-02-29' });
  assert.equal(allowed.tags.length, 20);
  assert.equal(allowed.title.length, 200);
  for (const revision of [undefined, 0, -1, 1.5, '1']) {
    await assert.rejects(f.run({ action: 'update', id: allowed.id, revision, title: 'no' }));
  }
  const stored = await full(f, allowed.id);
  assert.equal(noteSchema.safeParse({ ...stored, createdAt: '2026-02-30T00:00:00Z' }).success, false);
  assert.equal(noteSchema.safeParse({ ...stored, trashedAt: 'yesterday' }).success, false);
  assert.equal(noteSchema.safeParse({ ...stored, revision: 0 }).success, false);
  assert.equal(noteVersionSchema.safeParse({ ...stored, noteId: stored.id,
    versionId: 'wrong', savedAt: stored.updatedAt }).success, false);
  assert.equal(f.versions.records.size, 0);
});

test('journal requires calendar date, is concurrent-idempotent and recreates only after trash', async () => {
  const f = fixture();
  const [one, two] = await Promise.all([
    f.run({ action: 'journal', date: '2024-02-29' }), f.run({ action: 'journal', date: '2024-02-29' }),
  ]);
  assert.equal(one.note.id, two.note.id);
  assert.equal(f.notes.records.size, 1);
  assert.equal(one.note.title, '2024-02-29');
  assert.equal(one.note.category, 'journal');
  assert.equal(one.note.journalDate, '2024-02-29');
  assert.equal((await full(f, one.note.id)).content, '# 2024-02-29\n\n');
  await f.run({ action: 'trash', id: one.note.id, revision: 1 });
  const replacement = (await f.run({ action: 'journal', date: '2024-02-29' })).note;
  assert.notEqual(replacement.id, one.note.id);
  for (const date of ['', '2023-02-29', '2024-04-31', '2024-00-01', '2024-01-00', '2024-01-01T00:00:00Z']) {
    await assert.rejects(f.run({ action: 'journal', date }));
  }
});

test('update preserves omitted fields, noops, stale requests and serialized concurrent writes', async () => {
  const f = fixture();
  const note = await create(f, { title: 'Before', content: 'keep', tags: ['tag'], category: 'reading' });
  f.advance();
  const noop = await update(f, note, { title: 'Before', tags: ['tag'] });
  assert.deepEqual(noop, note);
  assert.equal(f.notes.writes, 1);
  assert.equal(f.versions.writes, 0);
  const outcomes = await Promise.allSettled([
    update(f, note, { title: 'Winner' }), update(f, note, { title: 'Loser' }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'CONFLICT');
  let current = await full(f, note.id);
  assert.equal(current.revision, 2);
  assert.equal(current.title, 'Winner');
  assert.equal(current.content, 'keep');
  assert.equal(current.category, 'reading');
  assert.deepEqual(current.tags, ['tag']);
  await assert.rejects(update(f, note, { content: 'stale' }), codeIs('CONFLICT'));
  current = await update(f, current, { pinned: true });
  assert.equal(current.revision, 3);
  assert.equal((await f.run({ action: 'versions', id: note.id })).total, 1);
  const missing = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(f.run({ action: 'get', id: missing }), codeIs('NOT_FOUND'));
  await assert.rejects(f.run({ action: 'update', id: missing, revision: 1 }), codeIs('NOT_FOUND'));
  assert.equal((await f.run({ action: 'list' })).total, 1); // failed requests do not poison the queue
});

test('auto checkpoints previous text at most once per five minutes; explicit checkpoints are stable', async () => {
  const f = fixture();
  let note = await create(f, { title: 'first', content: 'one' });
  const original = await full(f, note.id);
  note = await update(f, note, { content: 'two' });
  let versions = await f.run({ action: 'versions', id: note.id });
  assert.equal(versions.total, 1);
  assert.equal(versions.versions[0].revision, 1);
  const firstSavedAt = versions.versions[0].savedAt;
  assert.equal((await f.run({ action: 'version', id: note.id, versionId: `${note.id}:1` })).version.content, original.content);
  f.advance(299999);
  note = await update(f, note, { title: 'second' });
  assert.equal((await f.run({ action: 'versions', id: note.id })).total, 1);
  f.advance(1);
  note = await update(f, note, { content: 'three' });
  versions = await f.run({ action: 'versions', id: note.id });
  assert.deepEqual(versions.versions.map(v => v.revision), [3, 1]);
  assert.ok(versions.versions.every(v => !('content' in v)));
  const checkpoint = await f.run({ action: 'checkpoint', id: note.id, revision: note.revision });
  assert.equal(checkpoint.version.versionId, `${note.id}:4`);
  f.advance();
  const repeated = await f.run({ action: 'checkpoint', id: note.id, revision: note.revision });
  assert.deepEqual(repeated, checkpoint);
  assert.equal((await full(f, note.id)).revision, 4);
  assert.equal((await f.run({ action: 'versions', id: note.id })).total, 3);
  assert.equal((await f.run({ action: 'version', id: note.id, versionId: `${note.id}:1` })).version.savedAt, firstSavedAt);
  await assert.rejects(f.run({ action: 'checkpoint', id: note.id, revision: 1 }), codeIs('CONFLICT'));
  for (const limit of [0, 51]) await assert.rejects(f.run({ action: 'versions', id: note.id, limit }));
  const page = await f.run({ action: 'versions', id: note.id, offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.versions.length, 1);
  assert.equal(page.offset, 1);
  assert.equal(page.limit, 1);
});

test('trash forces checkpoint, excludes active list, and restore is soft and revision checked', async () => {
  const f = fixture();
  let note = await create(f, { content: 'before' });
  note = await update(f, note, { content: 'latest' });
  f.advance();
  const trash = (await f.run({ action: 'trash', id: note.id, revision: note.revision })).note;
  assert.equal(trash.revision, 3);
  assert.ok(trash.trashedAt);
  assert.equal((await f.run({ action: 'versions', id: note.id })).total, 2);
  assert.equal((await f.run({ action: 'version', id: note.id, versionId: `${note.id}:2` })).version.content, 'latest');
  const active = await f.run({ action: 'list' });
  assert.equal(active.total, 0);
  assert.equal(active.counts.all, 0);
  assert.equal(active.counts.trash, 1);
  assert.equal((await f.run({ action: 'list', trashed: true })).notes[0].id, note.id);
  assert.equal((await full(f, note.id)).content, 'latest');
  await assert.rejects(update(f, trash, { content: 'blocked' }), codeIs('TRASHED'));
  await assert.rejects(f.run({ action: 'restore_version', id: note.id, revision: 3, versionId: `${note.id}:1` }), codeIs('TRASHED'));
  await assert.rejects(f.run({ action: 'restore', id: note.id, revision: 2 }), codeIs('CONFLICT'));
  assert.deepEqual((await f.run({ action: 'trash', id: note.id, revision: 3 })).note, trash);
  f.advance();
  const restored = (await f.run({ action: 'restore', id: note.id, revision: 3 })).note;
  assert.equal(restored.revision, 4);
  assert.equal(restored.trashedAt, '');
  assert.notEqual(restored.updatedAt, trash.updatedAt);
  assert.equal(f.notes.records.size, 1);
  assert.equal((await f.run({ action: 'list' })).total, 1);
  assert.deepEqual((await f.run({ action: 'restore', id: note.id, revision: 4 })).note, restored);
});

test('version restore checkpoints current and restores only title/content; version scope is checked', async () => {
  const f = fixture();
  let note = await create(f, { title: 'Old', content: '  old\r\n', category: 'document', tags: ['old'] });
  note = await update(f, note, { title: 'New', content: 'new', category: 'code', tags: ['current'], pinned: true,
    journalDate: '2026-11-05' });
  const other = await create(f, { content: 'foreign' });
  await f.run({ action: 'checkpoint', id: other.id, revision: other.revision });
  for (const action of ['version', 'restore_version']) {
    const input = { action, id: note.id, versionId: `${other.id}:1` };
    if (action === 'restore_version') input.revision = 2;
    await assert.rejects(f.run(input), codeIs('NOT_FOUND'));
  }
  await assert.rejects(f.run({ action: 'version', id: note.id, versionId: `${note.id}:999` }), codeIs('NOT_FOUND'));
  f.advance();
  const restored = (await f.run({ action: 'restore_version', id: note.id, revision: 2, versionId: `${note.id}:1` })).note;
  assert.equal(restored.revision, 3);
  const current = await full(f, note.id);
  assert.equal(current.title, 'Old');
  assert.equal(current.content, '  old\r\n');
  assert.equal(current.category, 'code');
  assert.deepEqual(current.tags, ['current']);
  assert.equal(current.pinned, true);
  assert.equal(current.journalDate, '2026-11-05');
  const savedCurrent = (await f.run({ action: 'version', id: note.id, versionId: `${note.id}:2` })).version;
  assert.equal(savedCurrent.content, 'new');
  savedCurrent.tags.push('mutation');
  assert.deepEqual((await f.run({ action: 'version', id: note.id, versionId: `${note.id}:2` })).version.tags, ['current']);
  await assert.rejects(f.run({ action: 'restore_version', id: note.id, revision: 2, versionId: `${note.id}:1` }), codeIs('CONFLICT'));
});

test('history retention holds at 50 per note and does not prune other notes', async () => {
  const f = fixture();
  let note = await create(f, { content: '0' });
  const other = await create(f, { content: 'untouched' });
  await f.run({ action: 'checkpoint', id: other.id, revision: 1 });
  for (let i = 1; i <= 55; i++) {
    await f.run({ action: 'checkpoint', id: note.id, revision: note.revision });
    f.advance();
    note = await update(f, note, { content: String(i) });
  }
  const history = await f.run({ action: 'versions', id: note.id, limit: 50 });
  assert.equal(history.total, 50);
  assert.equal(history.versions.length, 50);
  assert.deepEqual(history.versions.map(v => v.revision), Array.from({ length: 50 }, (_, i) => 55 - i));
  assert.equal(f.versions.records.size, 51);
  assert.equal((await f.run({ action: 'versions', id: other.id })).total, 1);
  await assert.rejects(f.run({ action: 'version', id: note.id, versionId: `${note.id}:1` }), codeIs('NOT_FOUND'));
  assert.equal((await full(f, note.id)).content, '55');
});

test('history write failure preserves current note for edit, trash, checkpoint and restore_version', async () => {
  const f = fixture();
  let note = await create(f, { title: 'Original', content: 'first' });
  const before = await full(f, note.id);
  f.versions.failPut = true;
  for (const input of [
    { action: 'update', id: note.id, revision: 1, title: 'blocked' },
    { action: 'trash', id: note.id, revision: 1 },
    { action: 'checkpoint', id: note.id, revision: 1 },
  ]) {
    await assert.rejects(f.run(input), /fixture history write failed/);
    assert.deepEqual(await full(f, note.id), before);
  }
  f.versions.failPut = false;
  note = await update(f, note, { content: 'second' });
  const current = await full(f, note.id);
  f.versions.failPut = true;
  await assert.rejects(f.run({ action: 'restore_version', id: note.id, revision: 2, versionId: `${note.id}:1` }), /fixture history write failed/);
  assert.deepEqual(await full(f, note.id), current);
  f.versions.failPut = false;
  assert.equal((await update(f, note, { pinned: true })).revision, 3);
});

test('async read adapters work, input defaults tolerate old descriptive fields, bad clocks reject writes', async () => {
  const f = fixture();
  f.notes.get = async key => f.notes.records.get(key);
  f.notes.entries = async () => f.notes.records.entries();
  f.versions.get = async key => f.versions.records.get(key);
  f.versions.entries = async () => f.versions.records.entries();
  let note = await create(f);
  note = await update(f, note, { content: 'async' });
  assert.equal((await f.run({ action: 'list' })).total, 1);
  assert.equal((await f.run({ action: 'versions', id: note.id })).total, 1);
  const original = await full(f, note.id);
  const legacy = { id: original.id, createdAt: original.createdAt, updatedAt: original.updatedAt, revision: original.revision };
  f.notes.records.set(note.id, legacy);
  assert.equal((await full(f, note.id)).title, 'Untitled');
  assert.deepEqual(f.notes.records.get(note.id), legacy); // read defaults do not rewrite records
  const badClock = new NotesStore(new Table(), new Table(), () => 'not a timestamp');
  await assert.rejects(badClock.execute({ action: 'create' }));
});
