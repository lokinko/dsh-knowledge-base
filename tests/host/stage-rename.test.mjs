import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {NoteStorage, NOTE_STORAGE_CONTROL_KEY} from '../../src/host/storage/note-storage.js';
import {noteSchema, noteVersionSchema} from '../../src/host/notes/store.js';
import {chatBindingSchema} from '../../src/host/coauthor/note-chats.js';

class Table {
  rows = new Map();
  async get(key) { return structuredClone(this.rows.get(key)); }
  async entries() { return structuredClone([...this.rows]); }
  async put(key, value) { this.rows.set(key, structuredClone(value)); }
  async delete(key) { this.rows.delete(key); }
}
async function fixture(t, platform = 'win32') {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-stage-rename-test-'));
  const schemas = {notes: noteSchema, note_versions: noteVersionSchema, note_chats: chatBindingSchema};
  const legacy = Object.fromEntries(Object.keys(schemas).map(name => [name, new Table()]));
  const controlTable = new Table(), managers = [], attempts = [], waits = [];
  let faults = [];
  const checked = target => {
    const absolute = path.resolve(target);
    assert.ok(absolute.startsWith(path.resolve(temp) + path.sep), 'Only owned fixture descendants may be mutated');
    return absolute;
  };
  const publication = {platform, wait: async ms => { waits.push(ms); }, rename: async (source, target) => {
    checked(source); checked(target);
    assert.equal(path.dirname(source), path.dirname(target));
    assert.equal(path.basename(source), '.stage-' + path.basename(target));
    attempts.push([source, target]);
    const fault = faults.shift();
    if (fault) throw fault;
    await fs.rename(source, target);
  }};
  const make = () => {
    const manager = new NoteStorage({legacy, controlTable, schemas, stagePublication: publication});
    managers.push(manager); return manager;
  };
  t.after(async () => {
    for (const manager of managers.reverse()) await manager.close();
    const absolute = path.resolve(temp);
    assert.ok(path.basename(absolute).startsWith('dsh-stage-rename-test-'));
    assert.equal(path.dirname(absolute), await fs.realpath(os.tmpdir()));
    await fs.rm(absolute, {recursive: true, force: true});
  });
  const manager = await make().start();
  const now = '2026-11-10T00:00:00.000Z';
  const note = noteSchema.parse({id: randomUUID(), title: 'Exact source', content: '# source\r\n中文🙂', createdAt: now, updatedAt: now, revision: 1});
  await manager.table('notes').put(note.id, note);
  const state = () => structuredClone(controlTable.rows.get(NOTE_STORAGE_CONTROL_KEY));
  const switchTo = async name => manager.execute({action: 'set', directory: checked(path.join(temp, name)), revision: state().revision});
  return {manager, note, make, state, switchTo, attempts, waits, checked,
    inject(...next) { faults = next; attempts.length = 0; waits.length = 0; }};
}
const error = code => Object.assign(new Error('Injected stage publication ' + code), {code});

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows stage publication retries ${code} without changing the atomic rename paths`, async t => {
    const f = await fixture(t);
    const fault = error(code);
    f.inject(fault, fault, fault);
    const before = f.state();
    const result = await f.switchTo('published');
    assert.equal(result.revision, before.revision + 1);
    assert.deepEqual(f.waits, [20, 40, 80]);
    assert.equal(f.attempts.length, 4);
    assert.ok(f.attempts.every(pair => pair[0] === f.attempts[0][0] && pair[1] === f.attempts[0][1]));
    await assert.rejects(fs.stat(f.attempts[0][0]), {code: 'ENOENT'});
    assert.equal((await fs.stat(f.attempts[0][1])).isDirectory(), true);
    assert.deepEqual(await f.manager.table('notes').get(f.note.id), f.note);
    await f.manager.close();
    assert.deepEqual(await (await f.make().start()).table('notes').get(f.note.id), f.note);
  });
}

test('exhausted Windows publication leaves the old pointer, source generation and queued writes intact', async t => {
  const f = await fixture(t);
  await f.switchTo('source');
  const before = f.state();
  const sourceRoot = path.join(before.directory, 'dsh-notebook', 'generations', before.generation);
  const marker = await fs.readFile(path.join(sourceRoot, 'generation.json'), 'utf8');
  const fault = error('EPERM');
  f.inject(fault, fault, fault, fault);
  const switching = f.switchTo('denied');
  const next = {...f.note, title: 'Queued after denied publication', revision: 2};
  const writing = f.manager.table('notes').put(next.id, next);
  await assert.rejects(switching, failure => failure === fault);
  await writing;
  assert.deepEqual(f.waits, [20, 40, 80]);
  assert.equal(f.attempts.length, 4);
  assert.deepEqual(f.state(), before);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'generation.json'), 'utf8'), marker);
  assert.equal((await fs.stat(f.attempts[0][0])).isDirectory(), true);
  await assert.rejects(fs.stat(f.attempts[0][1]), {code: 'ENOENT'});
  assert.deepEqual(await f.manager.table('notes').get(next.id), next);
  await f.manager.close();
  assert.deepEqual(await (await f.make().start()).table('notes').get(next.id), next);
});

for (const [platform, code] of [['win32', 'ENOENT'], ['win32', 'EEXIST'], ['win32', 'ENOTEMPTY'], ['linux', 'EPERM']]) {
  test(`${platform} publication propagates ${code} immediately and preserves the pointer`, async t => {
    const f = await fixture(t, platform), before = f.state(), fault = error(code);
    f.inject(fault);
    await assert.rejects(f.switchTo('permanent'), failure => failure === fault);
    assert.equal(f.attempts.length, 1);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(f.state(), before);
    assert.deepEqual(await f.manager.table('notes').get(f.note.id), f.note);
    assert.equal((await fs.stat(f.attempts[0][0])).isDirectory(), true);
    await assert.rejects(fs.stat(f.attempts[0][1]), {code: 'ENOENT'});
  });
}
