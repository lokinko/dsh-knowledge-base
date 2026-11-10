import test from 'node:test';
import assert from 'node:assert/strict';
import { NotesStore } from './notes-store.js';
import { NoteEdits, registerNoteEdits } from './note-edits.js';

const url = 'http://fixture.invalid/api/dsh-note/note-edits';
const missingId = '00000000-0000-4000-8000-000000000001';
class Table {
  records = new Map();
  writes = 0;
  get(key) { return this.records.get(key); }
  entries() { return this.records.entries(); }
  async put(key, value) { this.writes++; this.records.set(key, structuredClone(value)); }
  async delete(key) { this.records.delete(key); }
}
function fixture(seed) {
  const notes = new Table();
  const versions = new Table();
  if (seed) {
    notes.records = structuredClone(seed.notes.records);
    versions.records = structuredClone(seed.versions.records);
  }
  const store = new NotesStore(notes, versions, () => '2026-11-05T03:00:00.000Z');
  const edits = new NoteEdits(store);
  let route;
  let tool;
  const cleanups = [];
  const removed = [];
  registerNoteEdits({
    effect(callback) { cleanups.push(callback()); },
    connection: { fetch: { register(value) {
      route = value; return () => { removed.push('route'); };
    } } },
    tools: { register(value) { tool = value; return () => { removed.push('tool'); }; } },
  }, edits);
  const raw = body => route.fetch(new Request(url, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json' } }));
  const http = async input => {
    const response = await raw(JSON.stringify(input));
    return { response, value: await response.json() };
  };
  return { notes, versions, store, edits, route, tool, raw, http, cleanups, removed };
}
const create = async (f, content = '', fields = {}) =>
  (await f.store.execute({ action: 'create', content, ...fields })).note;
const read = async (f, id) => (await f.store.execute({ action: 'get', id })).note;
const replace = (note, oldText, newText, extra = {}) =>
  ({ action: 'replace', id: note.id, revision: note.revision, oldText, newText, ...extra });
const append = (note, text) => ({ action: 'append', id: note.id, revision: note.revision, text });
const codeIs = code => error => error instanceof Error && error.code === code;

// All tables, requests, and registry objects below are fixtures; no profile or user records are used.
test('registers compact edit_note and streaming POST route with owned cleanup', async () => {
  const f = fixture();
  assert.equal(f.tool.name, 'edit_note');
  assert.equal(f.route.path, '/api/dsh-note/note-edits');
  assert.deepEqual(f.route.methods, ['POST']);
  assert.equal(f.route.requestBody, 'streaming');
  assert.equal(f.tool.parameters.additionalProperties, false);
  assert.deepEqual(f.tool.parameters.required, ['action', 'id', 'revision']);
  for (const key of ['newText', 'oldText', 'text']) {
    assert.equal(Object.hasOwn(f.tool.parameters.properties[key], 'maxLength'), false);
  }
  const parametersBytes = Buffer.byteLength(JSON.stringify(f.tool.parameters));
  const toolBytes = Buffer.byteLength(JSON.stringify({ name: f.tool.name,
    description: f.tool.description, parameters: f.tool.parameters }));
  assert.ok(toolBytes < 1500);
  console.log(`edit_note parameters JSON: ${parametersBytes} bytes; model-facing tool JSON: ${toolBytes} bytes (new tool baseline: 0).`);
  assert.deepEqual(f.tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }]);
  for (const cleanup of f.cleanups.toReversed()) await cleanup();
  assert.deepEqual(f.removed, ['tool', 'route']);
});

test('small literal patch preserves a five-million-character Unicode/CRLF note and its history', async () => {
  const f = fixture();
  const prefix = '  标题 😀\r\n'.repeat(300000);
  const suffix = '\t尾部 🧪\r\n  '.repeat(300000);
  const source = `${prefix}unique target\r\n${suffix}`;
  assert.ok(source.length >= 5000000);
  const note = await create(f, source, { title: 'Keep title', category: 'code', tags: ['keep'], pinned: true });
  const newText = '$& $1 $$ $` $\' 更新\r\n';
  const result = await f.edits.execute(replace(note, 'unique target\r\n', newText));
  assert.equal(result.replacementCount, 1);
  assert.equal('content' in result.note, false);
  assert.equal(result.note.revision, 2);
  const current = await read(f, note.id);
  assert.equal(current.content, prefix + newText + suffix);
  assert.equal(current.title, 'Keep title');
  assert.equal(current.category, 'code');
  assert.deepEqual(current.tags, ['keep']);
  assert.equal(current.pinned, true);
  const version = await f.store.execute({ action: 'version', id: note.id, versionId: `${note.id}:1` });
  assert.equal(version.version.content, source);
});

test('unique replacement rejects ambiguous, overlapping and missing matches without writes', async () => {
  const f = fixture();
  const note = await create(f, 'same\r\nsame\r\naaa');
  const before = await read(f, note.id);
  for (const [oldText, code] of [['same', 'AMBIGUOUS_MATCH'], ['aa', 'AMBIGUOUS_MATCH'], ['missing', 'NO_MATCH']]) {
    await assert.rejects(f.edits.execute(replace(note, oldText, 'new')), codeIs(code));
  }
  assert.deepEqual(await read(f, note.id), before);
  assert.equal(f.notes.writes, 1);
  assert.equal(f.versions.writes, 0);
});

test('replaceAll counts nonoverlapping literal matches and treats replacement dollars as source', async () => {
  const f = fixture();
  let note = await create(f, '😀\r\n😀\r\naaa');
  const result = await f.edits.execute(replace(note, '😀', '$&\t🧪', { replaceAll: true }));
  assert.equal(result.replacementCount, 2);
  assert.equal((await read(f, note.id)).content, '$&\t🧪\r\n$&\t🧪\r\naaa');
  note = result.note;
  const overlap = await f.edits.execute(replace(note, 'aa', '', { replaceAll: true }));
  assert.equal(overlap.replacementCount, 1);
  assert.equal((await read(f, note.id)).content, '$&\t🧪\r\n$&\t🧪\r\na');
});

test('append uses exact EOF text with no implicit newline; noops preserve revision and history', async () => {
  const f = fixture();
  let note = await create(f, '  first\r\n');
  const first = await f.edits.execute(append(note, '\t😀\r\n  '));
  assert.equal(first.replacementCount, 0);
  assert.equal((await read(f, note.id)).content, '  first\r\n\t😀\r\n  ');
  note = first.note;
  const writes = f.notes.writes;
  const versions = f.versions.writes;
  const noAppend = await f.edits.execute(append(note, ''));
  assert.deepEqual(noAppend.note, note);
  const noReplace = await f.edits.execute(replace(note, 'first', 'first'));
  assert.equal(noReplace.replacementCount, 1);
  assert.deepEqual(noReplace.note, note);
  assert.equal(f.notes.writes, writes);
  assert.equal(f.versions.writes, versions);
});

test('each edit checkpoints the previous body even within the same five-minute window and can restore it', async () => {
  const f = fixture(); // The clock stays fixed for both edits.
  const original = '  user source 😀\r\n';
  const note = await create(f, original);
  const first = await f.tool.execute(replace(note, 'user source', 'first model edit'));
  const beforeSecond = '  first model edit 😀\r\n';
  const second = await f.tool.execute(append(first.note, '\r\nsecond model edit 🧪'));
  const history = await f.store.execute({ action: 'versions', id: note.id });
  assert.deepEqual(history.versions.map(version => version.revision), [2, 1]);
  assert.equal(history.versions[0].savedAt, history.versions[1].savedAt);
  const previous = await f.store.execute({ action: 'version', id: note.id, versionId: `${note.id}:2` });
  assert.equal(previous.version.content, beforeSecond);
  const initial = await f.store.execute({ action: 'version', id: note.id, versionId: `${note.id}:1` });
  assert.equal(initial.version.content, original);
  const restored = await f.store.execute({ action: 'restore_version', id: note.id,
    revision: second.note.revision, versionId: `${note.id}:2` });
  assert.equal(restored.note.revision, 4);
  assert.equal((await read(f, note.id)).content, beforeSecond);
});

test('noops and invalid matches never request a checkpoint or mutate fresh notes', async () => {
  const f = fixture();
  const note = await create(f, 'same same\r\nunique 😀');
  const before = await read(f, note.id);
  const execute = f.store.execute.bind(f.store);
  const actions = [];
  f.store.execute = input => { actions.push(input.action); return execute(input); };
  await f.edits.execute(append(note, ''));
  await f.edits.execute(replace(note, 'unique', 'unique'));
  await f.edits.execute(replace(note, 'same', 'same', { replaceAll: true }));
  await assert.rejects(f.edits.execute(replace(note, 'same', 'changed')), codeIs('AMBIGUOUS_MATCH'));
  await assert.rejects(f.edits.execute(replace(note, 'missing', 'changed')), codeIs('NO_MATCH'));
  await assert.rejects(f.edits.execute(append({ ...note, revision: 2 }, 'changed')), codeIs('CONFLICT'));
  assert.equal(actions.includes('checkpoint'), false);
  assert.deepEqual(await read(f, note.id), before);
  assert.equal(f.notes.writes, 1);
  assert.equal(f.versions.writes, 0);
});

test('a failed forced checkpoint after an earlier edit prevents any update within the throttle window', async () => {
  const f = fixture();
  const original = await create(f, 'user source\r\n');
  const first = await f.edits.execute(append(original, 'first model edit'));
  const before = await read(f, original.id);
  const execute = f.store.execute.bind(f.store);
  const actions = [];
  f.store.execute = input => { actions.push(input.action); return execute(input); };
  f.versions.put = async () => { throw new Error('fixture checkpoint failure'); };
  for (const input of [replace(first.note, 'first', 'second'), append(first.note, 'second')]) {
    actions.length = 0;
    await assert.rejects(f.edits.execute(input), /fixture checkpoint failure/);
    assert.deepEqual(actions, ['get', 'checkpoint']);
    assert.deepEqual(await read(f, original.id), before);
  }
  assert.equal(f.notes.writes, 2);
  assert.equal(f.versions.records.has(`${original.id}:2`), false);
});

test('a direct writer after checkpoint but before update causes CAS conflict and preserves both versions', async () => {
  const f = fixture();
  const note = await create(f, 'body\r\n');
  const execute = f.store.execute.bind(f.store);
  let intercepted = false;
  f.store.execute = async input => {
    const result = await execute(input);
    if (!intercepted && input.action === 'checkpoint') {
      intercepted = true;
      await execute({ action: 'update', id: note.id, revision: 1, content: 'external update\r\n' });
    }
    return result;
  };
  await assert.rejects(f.edits.execute(replace(note, 'body', 'model edit')), codeIs('CONFLICT'));
  assert.equal((await read(f, note.id)).content, 'external update\r\n');
  assert.equal((await read(f, note.id)).revision, 2);
  const saved = await execute({ action: 'version', id: note.id, versionId: `${note.id}:1` });
  assert.equal(saved.version.content, 'body\r\n');
  assert.equal(f.notes.writes, 2);
});

test('strict action validation rejects malformed fields before reading or writing', async () => {
  const f = fixture();
  const note = await create(f, 'body');
  const before = await read(f, note.id);
  const invalid = [null, [], {}, { ...append(note, 'x'), action: 'delete' },
    { ...append(note, 'x'), id: 'bad' },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(revision => ({ ...append(note, 'x'), revision })),
    { ...replace(note, '', 'x') }, { ...replace(note, 'body', undefined) },
    { ...replace(note, 'body', null) }, { ...replace(note, 'body', 'x'), replaceAll: 'true' },
    { ...replace(note, 'body', 'x'), text: 'extra' },
    { ...append(note, undefined) }, { ...append(note, null) },
    { ...append(note, 'x'), oldText: 'body' }, { ...append(note, 'x'), unknown: true }];
  let reads = 0;
  const execute = f.store.execute.bind(f.store);
  f.store.execute = input => { reads++; return execute(input); };
  for (const input of invalid) await assert.rejects(f.edits.execute(input));
  assert.equal(reads, 0);
  assert.deepEqual(await read(f, note.id), before);
  assert.equal(f.versions.writes, 0);
});

test('stale revisions reject before matching and competing edits cannot overwrite a winner', async () => {
  const f = fixture();
  const note = await create(f, 'body');
  const outcomes = await Promise.allSettled([
    f.edits.execute(replace(note, 'body', 'winner')),
    f.edits.execute(append(note, ' loser')),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'CONFLICT');
  const current = await read(f, note.id);
  assert.equal(current.content, 'winner');
  await assert.rejects(f.edits.execute(replace(note, 'missing', 'stale')), codeIs('CONFLICT'));
  assert.deepEqual(await read(f, note.id), current);
});

test('a direct NotesStore writer between read and patch commit causes a conflict without lost updates', async () => {
  const f = fixture();
  const note = await create(f, 'body');
  const execute = f.store.execute.bind(f.store);
  let intercepted = false;
  f.store.execute = async input => {
    const result = await execute(input);
    if (!intercepted && input.action === 'get') {
      intercepted = true;
      await execute({ action: 'update', id: note.id, revision: 1, content: 'external update' });
    }
    return result;
  };
  await assert.rejects(f.edits.execute(replace(note, 'body', 'patch')), codeIs('CONFLICT'));
  assert.equal((await read(f, note.id)).content, 'external update');
  assert.equal((await read(f, note.id)).revision, 2);
  assert.equal(f.notes.writes, 2);
});

test('trashed notes, missing notes and failed history writes keep NotesStore protections', async () => {
  const f = fixture();
  const note = await create(f, 'body');
  await assert.rejects(f.edits.execute(append({ id: missingId, revision: 1 }, 'x')), codeIs('NOT_FOUND'));
  f.versions.put = async () => { throw new Error('fixture history failure'); };
  await assert.rejects(f.edits.execute(append(note, 'x')), /fixture history failure/);
  assert.equal((await read(f, note.id)).content, 'body');
  f.versions.put = Table.prototype.put;
  const trash = await f.store.execute({ action: 'trash', id: note.id, revision: 1 });
  await assert.rejects(f.edits.execute(append(trash.note, 'x')), codeIs('TRASHED'));
  assert.equal((await read(f, note.id)).content, 'body');
});

test('tool and HTTP use identical literal edit operations and bounded metadata results', async () => {
  const seed = fixture();
  const initial = await create(seed, 'same\r\nsame\r\nunique');
  const ui = fixture(seed);
  const agent = fixture(seed);
  for (const input of [replace(initial, 'same', 'new', { replaceAll: true }),
    append({ ...initial, revision: 2 }, '\r\n尾部 😀'),
    replace({ ...initial, revision: 3 }, 'unique', '')]) {
    const http = await ui.http(input);
    const tool = await agent.tool.execute(input);
    assert.equal(http.response.status, 200);
    assert.equal(http.response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(tool, http.value);
    assert.equal('content' in tool.note, false);
    assert.deepEqual(agent.notes.records, ui.notes.records);
    assert.deepEqual(agent.versions.records, ui.versions.records);
  }
});

test('HTTP errors retain stable JSON codes/status and tool errors retain original codes', async () => {
  const f = fixture();
  const note = await create(f, 'body body');
  for (const [input, status, code] of [
    [replace(note, 'body', 'x'), 400, 'AMBIGUOUS_MATCH'],
    [replace(note, 'missing', 'x'), 400, 'NO_MATCH'],
    [append({ ...note, revision: 2 }, 'x'), 409, 'CONFLICT'],
    [append({ id: missingId, revision: 1 }, 'x'), 404, 'NOT_FOUND'],
    [{ ...append(note, 'x'), extra: true }, 400, 'INVALID_REQUEST'],
  ]) {
    const { response, value } = await f.http(input);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(response.headers.get('Content-Type'), /application\/json/);
    assert.equal(value.ok, false);
    assert.equal(value.code, code);
    assert.equal(typeof value.error, 'string');
    if (code !== 'INVALID_REQUEST') await assert.rejects(f.tool.execute(input), codeIs(code));
  }
  for (const body of ['', '{', 'null', '[]']) {
    const response = await f.raw(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
  }
  const unsupported = await f.route.fetch(new Request(url));
  assert.equal(unsupported.status, 400);
  assert.equal((await read(f, note.id)).content, 'body body');
});

test('replacement and streamed append accept large exact text without a fixed body cap', async () => {
  const f = fixture();
  const note = await create(f, 'target');
  const text = '\u0000\r\n😀标题 '.repeat(180000);
  assert.ok(text.length > 1300000);
  const replaced = await f.tool.execute(replace(note, 'target', text));
  assert.equal(replaced.note.contentLength, text.length);
  const bytes = new TextEncoder().encode(JSON.stringify(append(replaced.note, text)));
  let offset = 0;
  const body = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + 65537, bytes.length);
    controller.enqueue(bytes.subarray(offset, end));
    offset = end;
  } });
  const response = await f.route.fetch(new Request(url, { method: 'POST', body, duplex: 'half' }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.note.contentLength, text.length * 2);
  assert.equal(result.replacementCount, 0);
  assert.equal((await read(f, note.id)).content, text + text);
});
