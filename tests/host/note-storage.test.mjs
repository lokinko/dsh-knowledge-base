import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NoteStorage, noteStorageControlSchema, NOTE_STORAGE_CONTROL_KEY } from '../../src/host/storage/note-storage.js';
import { noteSchema, noteVersionSchema, NotesStore } from '../../src/host/notes/store.js';
import { chatBindingSchema } from '../../src/host/coauthor/note-chats.js';

// Real filesystem fixtures, isolated from all runtime/profile/user tables.
class Table {
  data = new Map();
  failPut = false;
  beforePut = null;
  async get(key) { return structuredClone(this.data.get(key)); }
  async entries() { return structuredClone([...this.data]); }
  async put(key, value) {
    if (this.beforePut) await this.beforePut(key, structuredClone(value));
    if (this.failPut) throw new Error('fixture put failed');
    this.data.set(key, structuredClone(value));
  }
  async delete(key) { this.data.delete(key); }
}
const schemas = { notes: noteSchema, note_versions: noteVersionSchema, note_chats: chatBindingSchema };
const now = '2026-11-06T00:00:00.000Z';
const newNote = (patch = {}) => noteSchema.parse({ id: randomUUID(), title: 'Fixture 标题', content: 'raw\r\ntext  ',
  category: 'document', tags: ['fixture'], pinned: false, journalDate: '', trashedAt: '', createdAt: now, updatedAt: now, revision: 1, ...patch });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const recordFile = (control, name, key) => path.join(control.directory, 'dsh-notebook', 'generations', control.generation,
  name, createHash('sha256').update(key).digest('hex') + '.json');
const present = async target => { try { await fs.lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function fixture(t, seed = true) {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dsh-note-storage-test-'));
  const legacy = { notes: new Table(), note_versions: new Table(), note_chats: new Table() };
  const controlTable = new Table();
  const managers = [];
  const todo = new Table();
  await todo.put('unrelated-todo', { text: 'Task fixture remains independent', completed: false });
  const note = newNote();
  const version = noteVersionSchema.parse({ ...note, versionId: note.id + ':1', noteId: note.id, savedAt: now });
  const binding = chatBindingSchema.parse({ noteId: note.id, sessionId: 'fixture-native-conversation', createdAt: now, updatedAt: now });
  if (seed) { await legacy.notes.put(note.id, note); await legacy.note_versions.put(version.versionId, version); await legacy.note_chats.put(note.id, binding); }
  const make = (options = {}) => { const manager = new NoteStorage({ legacy, controlTable, schemas, ...options }); managers.push(manager); return manager; };
  const checked = target => { const absolute = path.resolve(target); assert.ok(absolute.startsWith(path.resolve(temp) + path.sep), 'Only fixture descendants may be mutated'); return absolute; };
  t.after(async () => {
    for (const manager of managers.reverse()) await manager.close();
    const absolute = path.resolve(temp);
    assert.ok(path.basename(absolute).startsWith('dsh-note-storage-test-'));
    assert.equal(path.dirname(absolute), await fs.realpath(os.tmpdir()));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return { temp, legacy, controlTable, todo, note, version, binding, make, checked,
    state: () => structuredClone(controlTable.data.get(NOTE_STORAGE_CONTROL_KEY)) };
}

test('default startup stays on native note tables, validates clones and leaves todos independent', async t => {
  const f = await fixture(t);
  const manager = await f.make().start();
  const status = await manager.execute({ action: 'status' });
  assert.equal(status.mode, 'default'); assert.equal(status.directory, ''); assert.equal(status.revision, 0);
  assert.deepEqual(status.counts, { notes: 1, versions: 1, bindings: 1 });
  assert.equal(noteStorageControlSchema.parse(f.state()).libraryId, status.libraryId);
  const copy = await manager.table('notes').get(f.note.id); copy.tags.push('external');
  assert.deepEqual((await manager.table('notes').get(f.note.id)).tags, ['fixture']);
  const entries = await manager.table('notes').entries(); entries[0][1].title = 'external';
  assert.equal((await manager.table('notes').get(f.note.id)).title, f.note.title);
  await assert.rejects(manager.table('notes').put(f.note.id, { ...f.note, revision: 0 }), { code: 'INVALID_RECORD' });
  await assert.rejects(manager.table('notes').put('wrong-key', f.note), { code: 'INVALID_RECORD' });
  assert.throws(() => manager.table('todos'), /Unknown notebook table/);
  assert.deepEqual(await f.todo.entries(), [['unrelated-todo', { text: 'Task fixture remains independent', completed: false }]]);
});

test('directory migration preserves exact multi-MB Unicode CRLF notes, history, bindings and restart', async t => {
  const f = await fixture(t);
  const content = ' 标题🙂\\raw\r\nquoted"\t\u0000尾部  '.repeat(150000);
  assert.ok(content.length > 2 * 1024 * 1024);
  const note = { ...f.note, content };
  await f.legacy.notes.put(note.id, note);
  const manager = await f.make().start();
  const directory = path.join(f.temp, 'selected');
  const checked = await manager.execute({ action: 'check', directory });
  assert.equal(checked.writable, true); assert.equal(checked.exists, false); assert.equal(checked.ownedState, 'uninitialized');
  assert.equal((await manager.execute({ action: 'status' })).mode, 'default');
  assert.equal(await present(directory), false, 'check must not create the selected folder');
  const switched = await manager.execute({ action: 'set', directory, revision: 0 });
  assert.equal(switched.mode, 'directory'); assert.equal(switched.revision, 1);
  assert.equal((await manager.table('notes').get(note.id)).content, content);
  assert.deepEqual(await manager.table('note_versions').get(f.version.versionId), f.version);
  assert.deepEqual(await manager.table('note_chats').get(note.id), f.binding);
  assert.equal((await f.legacy.notes.get(note.id)).content, content, 'Native source is retained as a backup');
  const saved = JSON.parse(await fs.readFile(recordFile(f.state(), 'notes', note.id), 'utf8'));
  assert.equal(saved.key, note.id); assert.equal(saved.value.content, content);
  await manager.close();
  const reopened = await f.make({ initialDirectory: path.join(f.temp, 'ignored-bootstrap') }).start();
  assert.equal((await reopened.table('notes').get(note.id)).content, content);
  assert.deepEqual((await reopened.execute({ action: 'status' })).counts, { notes: 1, versions: 1, bindings: 1 });
});

test('autosave updates one record without rewriting unrelated records or generations', async t => {
  const f = await fixture(t), manager = await f.make().start();
  await manager.execute({ action: 'set', directory: path.join(f.temp, 'library'), revision: 0 });
  const control = f.state();
  const historyFile = recordFile(control, 'note_versions', f.version.versionId);
  const historyStat = await fs.stat(historyFile), historyRaw = await fs.readFile(historyFile, 'utf8');
  const generations = path.join(control.directory, 'dsh-notebook', 'generations');
  const before = await fs.readdir(generations);
  const updated = { ...f.note, title: 'single-record autosave', content: 'next\r\n', revision: 2 };
  await manager.table('notes').put(updated.id, updated);
  assert.deepEqual(await fs.readdir(generations), before);
  assert.equal(await fs.readFile(historyFile, 'utf8'), historyRaw);
  const afterStat = await fs.stat(historyFile);
  assert.equal(afterStat.mtimeMs, historyStat.mtimeMs); assert.equal(afterStat.ino, historyStat.ino);
  assert.deepEqual(await manager.table('notes').get(updated.id), updated);
  assert.equal((await f.legacy.notes.get(updated.id)).revision, 1);
  assert.equal((await manager.execute({ action: 'status' })).revision, 1, 'Record writes do not change settings CAS revision');
});

test('search, history, restore and coauthor bindings continue through the storage proxy', async t => {
  const f = await fixture(t), manager = await f.make().start();
  await manager.execute({ action: 'set', directory: path.join(f.temp, 'library'), revision: 0 });
  const store = new NotesStore(manager.table('notes'), manager.table('note_versions'), () => now);
  const result = await store.execute({ action: 'update', id: f.note.id, revision: 1, content: 'searchable fixture needle' });
  assert.equal(result.note.revision, 2);
  assert.equal((await store.execute({ action: 'list', query: 'needle' })).notes[0].id, f.note.id);
  assert.equal((await store.execute({ action: 'versions', id: f.note.id })).versions[0].versionId, f.version.versionId);
  const restored = await store.execute({ action: 'restore_version', id: f.note.id, revision: 2, versionId: f.version.versionId });
  assert.equal(restored.note.revision, 3);
  assert.equal((await store.execute({ action: 'get', id: f.note.id })).note.content, f.note.content);
  assert.deepEqual(await manager.table('note_chats').get(f.note.id), f.binding);
});

test('settings CAS and same canonical path are atomic and same-path set is a no-op', async t => {
  const f = await fixture(t), manager = await f.make().start(), directory = path.join(f.temp, 'library');
  const first = manager.execute({ action: 'set', directory, revision: 0 });
  const stale = manager.execute({ action: 'set', directory: path.join(f.temp, 'other'), revision: 0 });
  await first; await assert.rejects(stale, { code: 'CONFLICT' });
  const before = f.state();
  const result = await manager.execute({ action: 'set', directory: path.join(directory, '.'), revision: 1 });
  assert.equal(result.revision, 1); assert.deepEqual(f.state(), before);
  await assert.rejects(manager.execute({ action: 'set', directory }), { code: 'INVALID_REQUEST' });
  await assert.rejects(manager.execute({ action: 'check', directory: 'relative/path' }), { code: 'INVALID_DIRECTORY' });
  assert.equal((await manager.execute({ action: 'check', directory })).ownedState, 'owned');
});

test('a stale manager cannot overwrite a persistent settings pointer changed elsewhere', async t => {
  const f = await fixture(t), first = await f.make().start(), stale = await f.make().start();
  await first.execute({ action: 'set', directory: path.join(f.temp, 'first-owner'), revision: 0 });
  const pointer = f.state(), destination = path.join(f.temp, 'must-not-create');
  await assert.rejects(stale.execute({ action: 'set', directory: destination, revision: 0 }), { code: 'CONFLICT' });
  assert.deepEqual(f.state(), pointer); assert.equal(await present(destination), false);
});

test('native table failure does not advance the active memory snapshot', async t => {
  const f = await fixture(t), manager = await f.make().start();
  f.legacy.notes.failPut = true;
  await assert.rejects(manager.table('notes').put(f.note.id, { ...f.note, title: 'must not commit', revision: 2 }), /fixture put failed/);
  assert.deepEqual(await manager.table('notes').get(f.note.id), f.note);
  assert.equal((await manager.execute({ action: 'status' })).revision, 0);
});

test('failed pointer commit keeps source route and pointer, and queued writes resume there', async t => {
  const f = await fixture(t), manager = await f.make().start();
  const before = f.state();
  f.controlTable.failPut = true;
  const switching = manager.execute({ action: 'set', directory: path.join(f.temp, 'failed-target'), revision: 0 });
  const updated = { ...f.note, title: 'queued after migration failure', revision: 2 };
  const writing = manager.table('notes').put(updated.id, updated);
  await assert.rejects(switching, /fixture put failed/); await writing;
  assert.deepEqual(f.state(), before);
  assert.equal((await manager.execute({ action: 'status' })).mode, 'default');
  assert.deepEqual(await f.legacy.notes.get(updated.id), updated);
  f.controlTable.failPut = false;
  assert.equal((await manager.execute({ action: 'set', directory: path.join(f.temp, 'failed-target'), revision: 0 })).revision, 1);
  assert.deepEqual(await manager.table('notes').get(updated.id), updated);
});

test('return to default reconciles only note table keys and control failure rolls native preparation back', async t => {
  const f = await fixture(t), manager = await f.make().start();
  await manager.execute({ action: 'set', directory: path.join(f.temp, 'first'), revision: 0 });
  const sourcePointer = f.state();
  const updated = { ...f.note, content: 'current directory text', revision: 2 };
  await manager.table('notes').put(updated.id, updated);
  const deleted = newNote(); await f.legacy.notes.put(deleted.id, deleted);
  const nativeBefore = await f.legacy.notes.entries();
  f.controlTable.failPut = true;
  await assert.rejects(manager.execute({ action: 'set', directory: '', revision: 1 }), /fixture put failed/);
  assert.deepEqual(f.state(), sourcePointer);
  assert.deepEqual(await f.legacy.notes.entries(), nativeBefore);
  assert.equal((await manager.execute({ action: 'status' })).mode, 'directory');
  f.controlTable.failPut = false;
  await manager.execute({ action: 'set', directory: '', revision: 1 });
  assert.deepEqual(await f.legacy.notes.get(updated.id), updated); assert.equal(await f.legacy.notes.get(deleted.id), undefined);
  assert.equal((await manager.execute({ action: 'status' })).revision, 2);
  assert.equal(await present(recordFile(sourcePointer, 'notes', updated.id)), true, 'Previous directory remains a backup');
  await manager.execute({ action: 'set', directory: path.join(f.temp, 'second'), revision: 2 });
  assert.deepEqual(await manager.table('notes').get(updated.id), updated);
  assert.equal((await f.todo.get('unrelated-todo')).completed, false);
});

test('writes admitted before and after a switch resolve their backend at queue execution time', async t => {
  const f = await fixture(t), manager = await f.make().start();
  const entered = deferred(), release = deferred();
  f.legacy.notes.beforePut = async () => { entered.resolve(); await release.promise; };
  const before = { ...f.note, content: 'before switch', revision: 2 };
  const first = manager.table('notes').put(before.id, before);
  await entered.promise;
  const switching = manager.execute({ action: 'set', directory: path.join(f.temp, 'queued'), revision: 0 });
  const after = { ...f.note, content: 'after switch', revision: 3 };
  const last = manager.table('notes').put(after.id, after);
  assert.equal((await manager.table('notes').get(after.id)).revision, 1, 'Reads remain on the active snapshot during preparation');
  release.resolve();
  await Promise.all([first, switching, last]);
  assert.deepEqual(await f.legacy.notes.get(before.id), before);
  assert.deepEqual(await manager.table('notes').get(after.id), after);
  assert.equal(JSON.parse(await fs.readFile(recordFile(f.state(), 'notes', after.id), 'utf8')).value.revision, 3);
});

test('failed record write never commits memory and restart detects corrupt records', async t => {
  const f = await fixture(t), manager = await f.make().start();
  await manager.execute({ action: 'set', directory: path.join(f.temp, 'library'), revision: 0 });
  const extra = newNote(), file = f.checked(recordFile(f.state(), 'notes', extra.id));
  await fs.mkdir(file);
  await assert.rejects(manager.table('notes').put(extra.id, extra), { code: 'CORRUPT_STORAGE' });
  assert.equal(await manager.table('notes').get(extra.id), undefined);
  assert.equal((await manager.execute({ action: 'status' })).counts.notes, 1);
  await fs.rmdir(file);
  await manager.close();
  const originalFile = f.checked(recordFile(f.state(), 'notes', f.note.id));
  await fs.writeFile(originalFile, '{corrupt fixture', 'utf8');
  await assert.rejects(f.make().start(), { code: 'CORRUPT_STORAGE' });
  assert.equal(await present(path.join(f.state().directory, 'dsh-notebook', '.lock')), false);
});

test('configured missing directory fails on restart without silently opening native data', async t => {
  const f = await fixture(t), manager = await f.make().start();
  await manager.execute({ action: 'set', directory: path.join(f.temp, 'configured'), revision: 0 });
  const pointer = f.state(); await manager.close();
  await fs.rename(f.checked(pointer.directory), f.checked(path.join(f.temp, 'moved-away')));
  await assert.rejects(f.make().start(), { code: 'MISSING_STORAGE' });
  assert.deepEqual(f.state(), pointer); assert.equal(await present(pointer.directory), false);
  assert.equal((await f.legacy.notes.get(f.note.id)).revision, 1);
});

test('live process lock excludes another manager, and proved-dead PID lock is reclaimed', async t => {
  const f = await fixture(t), first = await f.make().start();
  await first.execute({ action: 'set', directory: path.join(f.temp, 'library'), revision: 0 });
  await assert.rejects(f.make().start(), { code: 'LOCKED' });
  const pointer = f.state(); await first.close();
  const lock = f.checked(path.join(pointer.directory, 'dsh-notebook', '.lock'));
  let deadPID = 2147483647;
  assert.throws(() => process.kill(deadPID, 0), error => error.code === 'ESRCH');
  await fs.writeFile(lock, JSON.stringify({ version: 1, libraryId: pointer.libraryId, pid: deadPID, token: randomUUID(), acquiredAt: now }), { flag: 'wx' });
  const reopened = await f.make().start();
  const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.deepEqual(await reopened.table('notes').get(f.note.id), f.note);
  await reopened.close(); assert.equal(await present(lock), false);
});

test('competing stale-lock reclaimers cannot both acquire a replacement live lock', async t => {
  const f = await fixture(t), first = await f.make().start();
  await first.execute({ action: 'set', directory: path.join(f.temp, 'reclaim-race'), revision: 0 });
  await first.close();
  const lock = f.checked(path.join(f.state().directory, 'dsh-notebook', '.lock'));
  const dead = { version: 1, libraryId: f.state().libraryId, pid: 2147483647, token: randomUUID() };
  await fs.writeFile(lock, JSON.stringify(dead), { flag: 'wx' });
  const contenders = [f.make(), f.make()];
  const results = await Promise.allSettled(contenders.map(manager => manager.start()));
  const winners = results.filter(result => result.status === 'fulfilled');
  const losers = results.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 1); assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, 'LOCKED');
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, process.pid);
  const guarded = await fs.readFile(lock, 'utf8');
  assert.deepEqual(await winners[0].value.table('notes').get(f.note.id), f.note);
  assert.equal(await fs.readFile(lock, 'utf8'), guarded);
  assert.equal(await present(path.join(path.dirname(lock), '.reclaim.lock')), false);
});

test('live or stale reclaim guards are never recursively reclaimed or allowed to remove the actual lock', async t => {
  const f = await fixture(t), first = await f.make().start();
  await first.execute({ action: 'set', directory: path.join(f.temp, 'guard-recovery'), revision: 0 });
  await first.close();
  const root = path.join(f.state().directory, 'dsh-notebook');
  const lock = f.checked(path.join(root, '.lock')), guard = f.checked(path.join(root, '.reclaim.lock'));
  const dead = JSON.stringify({ version: 1, libraryId: f.state().libraryId, pid: 2147483647, token: randomUUID() });
  await fs.writeFile(lock, dead, { flag: 'wx' });
  for (const pid of [process.pid, 2147483647]) {
    const raw = JSON.stringify({ version: 1, libraryId: f.state().libraryId, pid, token: randomUUID() });
    await fs.writeFile(guard, raw);
    await assert.rejects(f.make().start(), { code: 'LOCKED' });
    assert.equal(await fs.readFile(guard, 'utf8'), raw);
    assert.equal(await fs.readFile(lock, 'utf8'), dead);
  }
  await fs.unlink(lock);
  await assert.rejects(f.make().start(), { code: 'LOCKED' });
  assert.equal(await present(lock), false, 'A stale guard cannot be bypassed by creating a fresh main lock');
});

test('a separate Node process cannot acquire an active notebook directory lock', async t => {
  const f = await fixture(t), manager = await f.make().start();
  await manager.execute({ action: 'set', directory: path.join(f.temp, 'process-lock'), revision: 0 });
  const source = `
    import {NoteStorage} from ${JSON.stringify(new URL('../../src/host/storage/note-storage.js', import.meta.url).href)};
    import {noteSchema,noteVersionSchema} from ${JSON.stringify(new URL('../../src/host/notes/store.js', import.meta.url).href)};
    import {chatBindingSchema} from ${JSON.stringify(new URL('../../src/host/coauthor/note-chats.js', import.meta.url).href)};
    const state=${JSON.stringify(f.state())};
    const empty={entries:async()=>[],get:async()=>undefined,put:async()=>{},delete:async()=>{}};
    const storage=new NoteStorage({legacy:{notes:empty,note_versions:empty,note_chats:empty},
      controlTable:{get:async()=>state,put:async()=>{}},schemas:{notes:noteSchema,note_versions:noteVersionSchema,note_chats:chatBindingSchema}});
    try {await storage.start();await storage.close();process.exitCode=2;}
    catch(error){if(error.code!=='LOCKED'){console.error(error);process.exitCode=3;}}
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Lock worker failed: ' + code + '/' + signal))); });
  assert.equal((await manager.table('notes').get(f.note.id)).revision, 1);
});

test('directory record deletes survive restart while native source backups remain intact', async t => {
  const f = await fixture(t), manager = await f.make().start();
  await manager.execute({ action: 'set', directory: path.join(f.temp, 'delete-records'), revision: 0 });
  const file = recordFile(f.state(), 'note_chats', f.note.id);
  await manager.table('note_chats').delete(f.note.id);
  assert.equal(await present(file), false);
  assert.equal(await manager.table('note_chats').get(f.note.id), undefined);
  assert.deepEqual(await f.legacy.note_chats.get(f.note.id), f.binding);
  await manager.close();
  const reopened = await f.make().start();
  assert.equal(await reopened.table('note_chats').get(f.note.id), undefined);
  assert.equal((await reopened.execute({ action: 'status' })).counts.bindings, 0);
});

test('close during asynchronous startup waits for pointer commit and releases its active lock', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.controlTable.beforePut = async () => { entered.resolve(); await release.promise; };
  const manager = f.make({ initialDirectory: path.join(f.temp, 'closing-startup') });
  const starting = manager.start();
  await entered.promise;
  const closing = manager.close();
  release.resolve();
  await starting; await closing;
  assert.equal(await present(path.join(f.state().directory, 'dsh-notebook', '.lock')), false);
  await assert.rejects(manager.table('notes').entries(), { code: 'CLOSED' });
});

test('foreign and unmanaged destination folders are refused without changing unrelated files', async t => {
  const f = await fixture(t), first = await f.make().start();
  const target = path.join(f.temp, 'owned');
  await first.execute({ action: 'set', directory: target, revision: 0 });
  const foreignControl = new Table(), outsider = await f.make({ controlTable: foreignControl }).start();
  const checked = await outsider.execute({ action: 'check', directory: target });
  assert.equal(checked.ownedState, 'foreign'); assert.equal(checked.writable, false);
  await assert.rejects(outsider.execute({ action: 'set', directory: target, revision: 0 }), { code: 'FOREIGN_LIBRARY' });
  const unmarked = path.join(f.temp, 'unmarked'); await fs.mkdir(path.join(unmarked, 'dsh-notebook'), { recursive: true });
  const unrelated = path.join(unmarked, 'dsh-notebook', 'personal.txt'); await fs.writeFile(unrelated, 'untouched');
  await assert.rejects(outsider.execute({ action: 'set', directory: unmarked, revision: 0 }));
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'untouched');
  assert.equal((await outsider.execute({ action: 'status' })).mode, 'default');
});

test('managed child symlinks cannot escape the selected directory', async t => {
  const f = await fixture(t), manager = await f.make().start();
  const selected = path.join(f.temp, 'selected'), outside = path.join(f.temp, 'outside');
  await fs.mkdir(selected); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'personal.txt'), 'untouched');
  try { await fs.symlink(outside, path.join(selected, 'dsh-notebook'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host does not permit fixture symlinks'); return; } throw error; }
  await assert.rejects(manager.execute({ action: 'set', directory: selected, revision: 0 }), { code: 'INVALID_DIRECTORY' });
  assert.equal(await fs.readFile(path.join(outside, 'personal.txt'), 'utf8'), 'untouched');
});

test('initialDirectory bootstraps before the first saved storage choice and preserves later pointers', async t => {
  const f = await fixture(t), firstDir = path.join(f.temp, 'bootstrap');
  const first = await f.make({ initialDirectory: firstDir }).start();
  const pointer = f.state(); assert.equal(pointer.directory, await fs.realpath(firstDir));
  await first.close();
  const next = await f.make({ initialDirectory: path.join(f.temp, 'must-not-replace') }).start();
  assert.equal((await next.execute({ action: 'status' })).directory, pointer.directory);
  assert.equal(await present(path.join(f.temp, 'must-not-replace')), false);
});

test('failed initial directory pointer commit retries with the same durable library identity', async t => {
  const f = await fixture(t), directory = path.join(f.temp, 'bootstrap-retry');
  let failCommit = true;
  f.controlTable.beforePut = async (_key, value) => { if (value.directory && failCommit) throw new Error('bootstrap pointer commit failed'); };
  await assert.rejects(f.make({ initialDirectory: directory }).start(), /bootstrap pointer commit failed/);
  const initial = f.state();
  assert.equal(initial.revision, 0); assert.equal(initial.directory, '');
  const marker = JSON.parse(await fs.readFile(path.join(directory, 'dsh-notebook', 'library.json'), 'utf8'));
  assert.equal(marker.libraryId, initial.libraryId);
  await assert.rejects(f.make({ initialDirectory: directory }).start(), /bootstrap pointer commit failed/);
  assert.deepEqual(f.state(), initial, 'A still-failing configured bootstrap never silently succeeds on default');
  failCommit = false;
  const recovered = await f.make({ initialDirectory: directory }).start();
  assert.equal(f.state().libraryId, initial.libraryId);
  assert.equal(f.state().revision, 1); assert.equal(f.state().directory, await fs.realpath(directory));
  assert.deepEqual(await recovered.table('notes').get(f.note.id), f.note);
  await recovered.execute({ action: 'set', directory: '', revision: 1 });
  await recovered.close();
  const restarted = await f.make({ initialDirectory: directory }).start();
  assert.equal((await restarted.execute({ action: 'status' })).mode, 'default');
  assert.equal(f.state().revision, 2, 'Explicit return to default is not replaced by bootstrap config');
});

test('storage requests reject arrays, unknown fields and unqualified Windows root paths', async t => {
  const f = await fixture(t), manager = await f.make().start();
  for (const request of [[], { action: 'status', directory: '' }, { action: 'check', directory: '', revision: 0 },
    { action: 'set', directory: '', revision: 0, overwrite: true }]) {
    await assert.rejects(manager.execute(request), { code: 'INVALID_REQUEST' });
  }
  if (process.platform === 'win32') {
    for (const directory of ['\\root-without-drive', '/root-without-drive', 'C:drive-relative']) {
      await assert.rejects(manager.execute({ action: 'check', directory }), { code: 'INVALID_DIRECTORY' });
    }
  }
  assert.equal((await manager.execute({ action: 'status' })).revision, 0);
});

test('close drains admitted writes before releasing locks and rejects new operations', async t => {
  const f = await fixture(t), manager = await f.make().start();
  const entered = deferred(), release = deferred();
  f.legacy.notes.beforePut = async () => { entered.resolve(); await release.promise; };
  const updated = { ...f.note, title: 'drained before close', revision: 2 };
  const writing = manager.table('notes').put(updated.id, updated);
  await entered.promise;
  const closing = manager.close();
  await assert.rejects(manager.table('notes').put(updated.id, { ...updated, revision: 3 }), { code: 'CLOSED' });
  release.resolve(); await writing; await closing;
  assert.deepEqual(await f.legacy.notes.get(updated.id), updated);
  await assert.rejects(manager.table('notes').get(updated.id), { code: 'CLOSED' });
});
