import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NoteStorage, NOTE_STORAGE_CONTROL_KEY } from '../../src/host/storage/note-storage.js';
import { CategoryStore, categoryTreeSchema, defaultCategoryTree } from '../../src/host/categories/store.js';
import { NotesStore,noteSchema, noteVersionSchema } from '../../src/host/notes/store.js';
import { chatBindingSchema } from '../../src/host/coauthor/note-chats.js';
import { attachmentSchema } from '../../src/host/attachments/schema.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const now = '2026-11-10T00:00:00.000Z';
const schemas = { notes: noteSchema, note_versions: noteVersionSchema, note_chats: chatBindingSchema,
  attachments: attachmentSchema, note_categories: categoryTreeSchema };
class Table {
  data = new Map();
  failPut = false;
  puts = 0;
  async get(key) { return structuredClone(this.data.get(key)); }
  async entries() { return structuredClone([...this.data]); }
  async put(key, value) {
    if (this.failPut) throw new Error('fixture put failed');
    this.puts++;
    this.data.set(key, structuredClone(value));
  }
  async delete(key) { this.data.delete(key); }
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dsh-category-storage-test-'));
  const legacy = Object.fromEntries(Object.keys(schemas).map(name => [name, new Table()]));
  const controlTable = new Table(), managers = [], objects = new Map();
  const blobs = {
    async save({ data, name }) {
      const parts = [];
      for await (const chunk of data) parts.push(chunk);
      const bytes = Buffer.concat(parts), attachmentId = 'fixture:' + digest(bytes);
      objects.set(attachmentId, bytes);
      return { attachmentId, bytes: bytes.length, name };
    },
    async *read(ref) {
      const value = objects.get(ref.attachmentId);
      if (!value) throw new Error('fixture missing native blob');
      yield value;
    },
    hostPath() { return undefined; },
  };
  const note = noteSchema.parse({ id: randomUUID(), title: 'preserved', content: 'exact\r\n正文🙂  ',
    createdAt: now, updatedAt: now, revision: 1 });
  const version = noteVersionSchema.parse({ ...note, versionId: note.id + ':1', noteId: note.id, savedAt: now });
  const binding = chatBindingSchema.parse({ noteId: note.id, sessionId: 'fixture-chat', createdAt: now, updatedAt: now });
  await legacy.notes.put(note.id, note);
  await legacy.note_versions.put(version.versionId, version);
  await legacy.note_chats.put(note.id, binding);
  const make = ({ categories = true, attachments = true } = {}) => {
    const enabled = { ...legacy };
    if (!categories) delete enabled.note_categories;
    if (!attachments) delete enabled.attachments;
    const manager = new NoteStorage({ legacy: enabled, schemas, controlTable, blobs });
    managers.push(manager);
    return manager;
  };
  const checked = target => {
    const absolute = path.resolve(target);
    assert.ok(absolute.startsWith(path.resolve(temp) + path.sep), 'Only owned fixture descendants may be mutated');
    return absolute;
  };
  t.after(async () => {
    for (const manager of managers.reverse()) await manager.close();
    const absolute = path.resolve(temp);
    assert.ok(path.basename(absolute).startsWith('dsh-category-storage-test-'));
    assert.equal(path.dirname(absolute), await fs.realpath(os.tmpdir()));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const state = () => structuredClone(controlTable.data.get(NOTE_STORAGE_CONTROL_KEY));
  const root = (pointer = state()) => path.join(pointer.directory, 'dsh-notebook', 'generations', pointer.generation);
  const switchTo = async (manager, directory) => manager.execute({ action: 'set', directory,
    revision: (await manager.execute({ action: 'status' })).revision });
  const create = (categories, name = '研究', revision = 0, parentId = 'document') =>
    categories.execute({ action: 'create', name, revision, parentId });
  const seedAttachment = async manager => {
    const bytes = Buffer.from('original attachment\0正文');
    const ref = await blobs.save({ data: (async function* () { yield bytes; })(), name: 'fixture.bin' });
    const row = attachmentSchema.parse({ id: randomUUID(), ownerType: 'note', ownerId: note.id,
      name: ref.name, mediaType: 'application/octet-stream', size: bytes.length, sha256: digest(bytes),
      ref, revision: 1, createdAt: now, removedAt: '' });
    await manager.table('attachments').put(row.id, row);
    return { row, bytes };
  };
  const assertCore = async manager => {
    assert.deepEqual(await manager.table('notes').get(note.id), note);
    assert.deepEqual(await manager.table('note_versions').get(version.versionId), version);
    assert.deepEqual(await manager.table('note_chats').get(note.id), binding);
  };
  return { temp, legacy, controlTable, make, checked, state, root, switchTo, create, seedAttachment, assertCore };
}

for (const attachments of [false, true]) {
  test(`old ${attachments ? 'four' : 'three'}-table library opens without writes; first category write stages an owned generation`, async t => {
    const f = await fixture(t), old = await f.make({ categories: false, attachments }).start();
    const binary = attachments ? await f.seedAttachment(old) : null;
    await f.switchTo(old, path.join(f.temp, 'configured-library'));
    const pointer = f.state(), oldRoot = f.root(), marker = await fs.readFile(path.join(oldRoot, 'generation.json'), 'utf8');
    const listing = await fs.readdir(oldRoot);
    await old.close();
    const storage = await f.make().start(), categories = new CategoryStore(storage.table('note_categories'));
    assert.deepEqual((await categories.execute({ action: 'list' })).tree, defaultCategoryTree());
    assert.deepEqual(await storage.table('note_categories').entries(), []);
    assert.deepEqual(f.state(), pointer);
    assert.equal(f.legacy.note_categories.puts, 0);
    assert.equal((await storage.execute({ action: 'check', directory: pointer.directory })).writable, true);
    await f.assertCore(storage);
    const { tree } = await f.create(categories);
    assert.equal(tree.revision, 1);
    assert.equal(tree.items.length, 5);
    assert.equal(f.state().libraryId, pointer.libraryId);
    assert.equal(f.state().directory, pointer.directory);
    assert.equal(f.state().revision, pointer.revision + 1);
    assert.notEqual(f.state().generation, pointer.generation);
    assert.equal(await fs.readFile(path.join(oldRoot, 'generation.json'), 'utf8'), marker);
    assert.deepEqual(await fs.readdir(oldRoot), listing);
    assert.deepEqual(await storage.table('note_categories').get('categories'), tree);
    await f.assertCore(storage);
    if (binary) assert.deepEqual(await fs.readFile(path.join(f.root(), 'blobs', binary.row.sha256)), binary.bytes);
    const generation = f.state().generation;
    await categories.execute({ action: 'update', revision: 1, id: tree.items.at(-1).id, name: '重命名' });
    assert.equal(f.state().generation, generation, 'Normal category edits update one row rather than restaging');
    await storage.close();
    const restarted = await f.make().start();
    assert.equal((await new CategoryStore(restarted.table('note_categories')).snapshot()).items.at(-1).name, '重命名');
    await f.assertCore(restarted);
  });
}

test('failed first-write pointer commit keeps the configured route, identity, tree and original files', async t => {
  const f = await fixture(t), old = await f.make({ categories: false }).start();
  const binary = await f.seedAttachment(old);
  await f.switchTo(old, path.join(f.temp, 'configured-library'));
  const pointer = f.state(), oldRoot = f.root();
  const marker = await fs.readFile(path.join(oldRoot, 'generation.json'), 'utf8');
  await old.close();
  const storage = await f.make().start(), categories = new CategoryStore(storage.table('note_categories'));
  f.controlTable.failPut = true;
  await assert.rejects(f.create(categories), /fixture put failed/);
  assert.deepEqual(f.state(), pointer);
  assert.equal((await storage.execute({ action: 'status' })).directory, pointer.directory);
  assert.deepEqual(await categories.snapshot(), defaultCategoryTree());
  assert.equal(await fs.readFile(path.join(oldRoot, 'generation.json'), 'utf8'), marker);
  assert.deepEqual(await fs.readFile(path.join(oldRoot, 'blobs', binary.row.sha256)), binary.bytes);
  await f.assertCore(storage);
  f.controlTable.failPut = false;
  await storage.close();
  const retry = await f.make().start();
  await f.create(new CategoryStore(retry.table('note_categories')));
  assert.equal(f.state().libraryId, pointer.libraryId);
  assert.equal(f.state().directory, pointer.directory);
});

test('first category write rejects a pointer changed during staging and keeps its in-memory route', async t => {
  const f = await fixture(t), old = await f.make({ categories: false, attachments: false }).start();
  await f.switchTo(old, path.join(f.temp, 'configured-library'));
  const pointer = f.state();
  await old.close();
  const storage = await f.make().start(), categories = new CategoryStore(storage.table('note_categories'));
  const stage = storage._stage.bind(storage);
  storage._stage = async (...args) => {
    await stage(...args);
    f.controlTable.data.set(NOTE_STORAGE_CONTROL_KEY, { ...pointer, revision: pointer.revision + 1 });
  };
  await assert.rejects(f.create(categories), { code: 'CONFLICT' });
  assert.equal(storage._active.generation, pointer.generation);
  assert.equal((await storage.execute({ action: 'status' })).libraryId, pointer.libraryId);
  assert.deepEqual(await categories.snapshot(), defaultCategoryTree());
  await f.assertCore(storage);
});

test('classification tree and blobs follow default→A→B→default→restart without changing legacy counts', async t => {
  const f = await fixture(t), storage = await f.make().start();
  const categories = new CategoryStore(storage.table('note_categories'));
  const binary = await f.seedAttachment(storage);
  const parent = (await f.create(categories)).tree.items.at(-1).id;
  const created = await f.create(categories, '子分类', 1, parent);
  const child = created.tree.items.at(-1).id;
  const { tree } = await categories.execute({ action: 'move', revision: 2, id: child, parentId: 'reading' });
  const libraryId = f.state().libraryId;
  for (const directory of [path.join(f.temp, 'A'), path.join(f.temp, 'B'), '']) {
    await f.switchTo(storage, directory);
    assert.deepEqual(await categories.snapshot(), tree);
    assert.equal(f.state().libraryId, libraryId);
    assert.deepEqual((await storage.execute({ action: 'status' })).counts,
      { notes: 1, versions: 1, bindings: 1, attachments: 1 });
    await f.assertCore(storage);
    let bytes = Buffer.alloc(0);
    for await (const part of (await storage.readAttachment(binary.row)).data) bytes = Buffer.concat([bytes, part]);
    assert.deepEqual(bytes, binary.bytes);
  }
  assert.deepEqual(f.legacy.note_categories.data.get('categories'), tree);
  await storage.close();
  const restarted = await f.make().start();
  assert.deepEqual(await new CategoryStore(restarted.table('note_categories')).snapshot(), tree);
});

test('category-only generations retain custom note category IDs across directory migration and restart', async t => {
  const f = await fixture(t), storage = await f.make({ attachments: false }).start();
  const categories = new CategoryStore(storage.table('note_categories'));
  const { tree } = await f.create(categories);
  const customId = tree.items.at(-1).id;
  const [[id, note]] = await storage.table('notes').entries();
  await storage.table('notes').put(id, { ...note, category: customId });
  await f.switchTo(storage, path.join(f.temp, 'category-only'));
  const marker = JSON.parse(await fs.readFile(path.join(f.root(), 'generation.json'), 'utf8'));
  assert.deepEqual(marker.tables, ['notes', 'note_versions', 'note_chats', 'note_categories']);
  await storage.close();
  const restarted = await f.make({ attachments: false }).start();
  assert.equal((await restarted.table('notes').get(id)).category, customId);
  assert.deepEqual(await new CategoryStore(restarted.table('note_categories')).snapshot(), tree);
  await f.switchTo(restarted, '');
  assert.equal(f.legacy.notes.data.get(id).category, customId);
});

test('category writes admitted during migration execute against the committed destination', async t => {
  const f = await fixture(t), storage = await f.make().start();
  const categories = new CategoryStore(storage.table('note_categories'));
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const stage = storage._stage.bind(storage);
  storage._stage = async (...args) => { enter(); await released; return stage(...args); };
  const switching = f.switchTo(storage, path.join(f.temp, 'queued-destination'));
  await entered;
  const creating = f.create(categories);
  release();
  await switching;
  const { tree } = await creating;
  assert.equal(f.legacy.note_categories.puts, 0);
  assert.deepEqual(await categories.snapshot(), tree);
  const row = path.join(f.root(), 'note_categories', digest('categories') + '.json');
  assert.deepEqual(JSON.parse(await fs.readFile(row, 'utf8')).value, tree);
  await storage.close();
  const restarted = await f.make().start();
  assert.deepEqual(await new CategoryStore(restarted.table('note_categories')).snapshot(), tree);
});

test('return-to-default pointer failure rolls category and core native tables back', async t => {
  const f = await fixture(t), storage = await f.make().start();
  const categories = new CategoryStore(storage.table('note_categories'));
  const initial = (await f.create(categories)).tree;
  await f.switchTo(storage, path.join(f.temp, 'A'));
  const current = (await f.create(categories, 'custom only', 1)).tree;
  const pointer = f.state();
  f.controlTable.failPut = true;
  await assert.rejects(f.switchTo(storage, ''), /fixture put failed/);
  assert.deepEqual(f.state(), pointer);
  assert.deepEqual(f.legacy.note_categories.data.get('categories'), initial);
  assert.deepEqual(await categories.snapshot(), current);
  await f.assertCore(storage);
  f.controlTable.failPut = false;
  await f.switchTo(storage, '');
  assert.deepEqual(f.legacy.note_categories.data.get('categories'), current);
});

test('new category generations require their declared directory on restart and before migration', async t => {
  const f = await fixture(t), storage = await f.make().start();
  await f.switchTo(storage, path.join(f.temp, 'A'));
  const categories = new CategoryStore(storage.table('note_categories'));
  await f.create(categories);
  const pointer = f.state();
  const marker = JSON.parse(await fs.readFile(path.join(f.root(), 'generation.json'), 'utf8'));
  assert.ok(marker.tables.includes('note_categories'));
  const categoryDirectory = f.checked(path.join(f.root(), 'note_categories'));
  await fs.rm(categoryDirectory, { recursive: true });
  await assert.rejects(f.switchTo(storage, ''), { code: 'INVALID_DIRECTORY' });
  assert.deepEqual(f.state(), pointer);
  await storage.close();
  await assert.rejects(f.make().start(), { code: 'INVALID_DIRECTORY' });
  assert.deepEqual(f.state(), pointer);
});

test('category upgrade verifies retained attachment bytes before publishing its pointer', async t => {
  const f = await fixture(t), old = await f.make({ categories: false }).start();
  const binary = await f.seedAttachment(old);
  await f.switchTo(old, path.join(f.temp, 'A'));
  const pointer = f.state();
  await old.close();
  const storage = await f.make().start();
  const blob = f.checked(path.join(f.root(), 'blobs', binary.row.sha256));
  await fs.writeFile(blob, Buffer.alloc(binary.bytes.length, 88));
  await assert.rejects(f.create(new CategoryStore(storage.table('note_categories'))), { code: 'CORRUPT_ATTACHMENT' });
  assert.deepEqual(f.state(), pointer);
  assert.deepEqual(await storage.table('note_categories').entries(), []);
});

test('category table identity is id and incomplete opt-in preserves old constructors', async t => {
  const f = await fixture(t), disabled = await f.make({ categories: false, attachments: false }).start();
  assert.throws(() => disabled.table('note_categories'), /Unknown notebook table/);
  const enabled = await f.make({ attachments: false }).start();
  assert.deepEqual((await enabled.execute({ action: 'status' })).counts, { notes: 1, versions: 1, bindings: 1 });
  await assert.rejects(enabled.table('note_categories').put('wrong-key', defaultCategoryTree()), { code: 'INVALID_RECORD' });
  assert.deepEqual(await enabled.table('note_categories').entries(), []);
});


test('deleted category redirects survive directory migration, restart and return to default without changing note bytes',async t=>{
 const f=await fixture(t),manager=await f.make().start();const binary=await f.seedAttachment(manager);
 const categories=new CategoryStore(manager.table('note_categories'));
 await categories.execute({action:'delete',id:'document',revision:0});
 await f.assertCore(manager);await f.switchTo(manager,path.join(f.temp,'deleted-category-library'));await manager.close();
 const restarted=await f.make().start(),again=new CategoryStore(restarted.table('note_categories'));
 const tree=(await again.execute({action:'list'})).tree;assert.deepEqual(tree.redirects,[{id:'document',targetId:'reading'}]);
 await f.assertCore(restarted);
 const notes=new NotesStore(restarted.table('notes'),restarted.table('note_versions'),undefined,{categories:again});
 const id=(await restarted.table('notes').entries())[0][0];assert.equal((await notes.execute({action:'get',id})).note.category,'reading');
 const descriptor=await restarted.readAttachment(binary.row),parts=[];for await(const part of descriptor.data)parts.push(part);assert.deepEqual(Buffer.concat(parts),binary.bytes);
 await f.switchTo(restarted,'');await f.assertCore(restarted);assert.deepEqual((await again.execute({action:'list'})).tree.redirects,tree.redirects);
});
