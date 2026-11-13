import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CategoryStore, categoryTreeSchema, defaultCategoryTree } from '../../src/host/categories/store.js';
import { NotesStore, noteSchema, noteVersionSchema } from '../../src/host/notes/store.js';
import { registerCategories } from '../../src/host/categories/host.js';
class Table {
  records = new Map(); writes = 0; fail = false;
  get(id) { return this.records.get(id); }
  entries() { return this.records.entries(); }
  async put(id, value) { if (this.fail) throw new Error('put failed'); this.records.set(id, value); this.writes++; }
  async delete(id) { this.records.delete(id); }
}
function fixture() {
  const table = new Table(); const categories = new CategoryStore(table);
  const notes = new Table(); const versions = new Table();
  const store = new NotesStore(notes, versions, undefined, { categories });
  return { table, categories, notes, versions, store };
}
const tree = async store => (await store.execute({ action: 'list' })).tree;
async function create(store, name, parentId = null) {
  const previous = await tree(store);
  const next = (await store.execute({ action: 'create', revision: previous.revision, name, parentId })).tree;
  return next.items.find(item => !previous.items.some(old => old.id === item.id));
}
async function write(store, fields) {
  return store.execute({ revision: (await tree(store)).revision, ...fields });
}
const code = expected => error => error.code === expected;

test('deleting a parent preserves exact notes/history and promotes children in sibling order',async()=>{
 const f=fixture(),parent=await create(f.categories,'Work'),removed=await create(f.categories,'Project',parent.id),child=await create(f.categories,'Detail',removed.id);
 const raw='# Keep\r\nbody\nend\r';
 const note=(await f.store.execute({action:'create',category:removed.id,content:raw})).note;
 await f.store.execute({action:'checkpoint',id:note.id,revision:note.revision});
 const beforeNotes=structuredClone([...f.notes.records]),beforeVersions=structuredClone([...f.versions.records]);
 await write(f.categories,{action:'delete',id:removed.id});const next=await tree(f.categories);
 assert.equal(next.items.some(item=>item.id===removed.id),false);assert.equal(next.items.find(item=>item.id===child.id).parentId,parent.id);
 assert.deepEqual(next.redirects,[{id:removed.id,targetId:parent.id}]);assert.deepEqual([...f.notes.records],beforeNotes);assert.deepEqual([...f.versions.records],beforeVersions);
 const current=(await f.store.execute({action:'get',id:note.id})).note;assert.equal(current.category,parent.id);assert.equal(current.content,raw);assert.equal(current.revision,note.revision);
 const listed=await f.store.execute({action:'list',category:parent.id,includeDescendants:false});assert.equal(listed.total,1);assert.equal(listed.counts[parent.id],1);assert.equal(listed.notes[0].category,parent.id);
 assert.equal((await f.store.searchSnapshot())[0].category,parent.id);
 const reopened=new NotesStore(f.notes,f.versions,undefined,{categories:new CategoryStore(f.table)});assert.equal((await reopened.execute({action:'get',id:note.id})).note.category,parent.id);
 await reopened.execute({action:'update',id:note.id,revision:note.revision,category:removed.id,content:raw+'edited'});
 assert.equal((await reopened.execute({action:'get',id:note.id})).note.category,parent.id);
});

test('builtin deletion redirects old and new notes, compacts redirect chains, and protects the last category',async()=>{
 const f=fixture();const old=(await f.store.execute({action:'create',category:'reading',content:'keep'})).note;
 for(const id of ['reading','document','code'])await write(f.categories,{action:'delete',id});
 const next=await tree(f.categories);assert.deepEqual(next.items.map(item=>item.id),['journal']);assert.ok(next.redirects.every(item=>item.targetId==='journal'));assert.equal(categoryTreeSchema.safeParse(next).success,true);
 assert.equal((await f.store.execute({action:'get',id:old.id})).note.category,'journal');
 assert.equal((await f.store.execute({action:'create'})).note.category,'journal');
 assert.equal((await f.store.execute({action:'create',category:'reading'})).note.category,'journal');
 const before=await tree(f.categories);await assert.rejects(write(f.categories,{action:'delete',id:'journal'}),code('LAST_CATEGORY'));assert.deepEqual(await tree(f.categories),before);
 assert.equal(f.notes.records.get(old.id).category,'reading');
});

test('deletion is CAS protected and persistence failures or sibling name collisions preserve the tree',async()=>{
 const f=fixture(),parent=await create(f.categories,'Work'),removed=await create(f.categories,'Project',parent.id);
 await create(f.categories,'Clash',parent.id);await create(f.categories,'Clash',removed.id);const before=await tree(f.categories);
 await assert.rejects(write(f.categories,{action:'delete',id:removed.id}),/Duplicate sibling/);assert.deepEqual(await tree(f.categories),before);
 await assert.rejects(f.categories.execute({action:'delete',id:'reading',revision:0}),code('CONFLICT'));
 f.table.fail=true;await assert.rejects(write(f.categories,{action:'delete',id:'reading'}),/put failed/);f.table.fail=false;assert.deepEqual(await tree(f.categories),before);
 await write(f.categories,{action:'delete',id:'reading'});assert.equal((await tree(f.categories)).revision,before.revision+1);
});

test('defaults are implicit, detached, compatible with both constructors, and strict persisted validation', async () => {
  const f = fixture();
  const defaults = await tree(f.categories);
  assert.deepEqual(defaults, defaultCategoryTree()); assert.equal(f.table.writes, 0);
  defaults.items[0].name = 'mutated';
  assert.equal((await new CategoryStore({ table: f.table }).snapshot()).items[0].name, '');
  for (const mutate of [
    t => t.items.push({ ...t.items[0] }),
    t => { t.items[0].parentId = randomUUID(); },
    t => { t.items[0].order = 9; },
    t => { t.items[0].parentId = 'document'; },
    t => { t.items = t.items.slice(1); },
  ]) { const t = defaultCategoryTree(); mutate(t); assert.equal(categoryTreeSchema.safeParse(t).success, false); }
});

test('CAS admits one concurrent write and recovers after validation and persistence failures', async () => {
  const f = fixture();
  const results = await Promise.allSettled(['A', 'B'].map(name => f.categories.execute({ action: 'create', name, revision: 0 })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal((await tree(f.categories)).revision, 1);
  f.table.fail = true;
  await assert.rejects(create(f.categories, 'Failed'), /put failed/);
  f.table.fail = false;
  assert.equal((await tree(f.categories)).revision, 1);
  await assert.rejects(write(f.categories, { action: 'create', name: 'x'.repeat(81) }));
  await create(f.categories, 'Recovered');
  assert.equal((await tree(f.categories)).revision, 2);
});

test('sibling reorder, cross-parent move and builtin nesting preserve identity and normalize orders', async () => {
  const f = fixture(); const a = await create(f.categories, 'A'); const b = await create(f.categories, 'B');
  await write(f.categories, { action: 'move', id: b.id, parentId: null, beforeId: a.id });
  let t = await tree(f.categories);
  assert.deepEqual(t.items.filter(i => i.parentId === null).sort((a,b) => a.order-b.order).map(i => i.id),
    ['document', 'reading', 'code', 'journal', b.id, a.id]);
  await write(f.categories, { action: 'move', id: a.id, parentId: b.id });
  await write(f.categories, { action: 'move', id: 'reading', parentId: a.id });
  t = await tree(f.categories);
  assert.equal(t.items.find(i => i.id === 'reading').parentId, a.id);
  assert.equal(t.items.find(i => i.id === a.id).order, 0);
  assert.equal(categoryTreeSchema.safeParse(t).success, true);
  const writes = f.table.writes;
  await write(f.categories, { action: 'move', id: a.id, parentId: b.id });
  await write(f.categories, { action: 'update', id: a.id, name: 'A' });
  assert.equal(f.table.writes, writes);
  await assert.rejects(write(f.categories, { action: 'move', id: b.id, parentId: a.id }));
  await assert.rejects(write(f.categories, { action: 'move', id: b.id, parentId: b.id }));
  await assert.rejects(write(f.categories, { action: 'move', id: b.id, parentId: null, beforeId: a.id }), code('INVALID_REQUEST'));
  await assert.rejects(write(f.categories, { action: 'move', id: b.id, beforeId: b.id }), code('INVALID_REQUEST'));
  await assert.rejects(create(f.categories, 'A', b.id), /Duplicate sibling/);
  await assert.rejects(write(f.categories, { action: 'update', id: a.id, name: '  ' }));
  await write(f.categories, { action: 'update', id: 'document', name: 'Renamed' });
  await write(f.categories, { action: 'update', id: 'document', name: '' });
});

test('depth 8 is accepted; deeper create and subtree moves fail without writing', async () => {
  const f = fixture(); let parent = 'document';
  for (let depth = 2; depth <= 8; depth++) parent = (await create(f.categories, `Level ${depth}`, parent)).id;
  const before = await tree(f.categories);
  await assert.rejects(create(f.categories, 'Too deep', parent), /depth exceeds 8/);
  await assert.rejects(write(f.categories, { action: 'move', id: 'reading', parentId: parent }), /depth exceeds 8/);
  assert.deepEqual(await tree(f.categories), before);
  const branch = await create(f.categories, 'Branch'); await create(f.categories, 'Child', branch.id);
  const level7 = (await tree(f.categories)).items.find(i => i.name === 'Level 7');
  await assert.rejects(write(f.categories, { action: 'move', id: branch.id, parentId: level7.id }), /depth exceeds 8/);
});

test('500 item limit and duplicate custom sibling names are enforced', async () => {
  const f = fixture(); const t = defaultCategoryTree();
  for (let i = 4; i < 500; i++) t.items.push({ id: randomUUID(), name: `Item ${i}`, parentId: null, order: i });
  f.table.records.set('categories', t);
  await assert.rejects(create(f.categories, 'Overflow'));
  assert.equal((await tree(f.categories)).items.length, 500);
  const other = fixture(); await create(other.categories, 'Name');
  await assert.rejects(create(other.categories, ' Name '), /Duplicate sibling/);
  await create(other.categories, 'Name', 'document');
});

test('notes validate category existence, include descendants and roll up active counts without double counting totals', async () => {
  const f = fixture(); const parent = await create(f.categories, 'Work'); const child = await create(f.categories, 'Project', parent.id);
  const a = (await f.store.execute({ action: 'create', category: parent.id, content: 'parent' })).note;
  const b = (await f.store.execute({ action: 'create', category: child.id, content: 'child' })).note;
  const c = (await f.store.execute({ action: 'create', category: child.id })).note;
  await f.store.execute({ action: 'trash', id: c.id, revision: c.revision });
  let result = await f.store.execute({ action: 'list', category: parent.id });
  assert.deepEqual(new Set(result.notes.map(n => n.id)), new Set([a.id, b.id]));
  assert.equal(result.counts[parent.id], 2); assert.equal(result.counts[child.id], 1);
  assert.equal(result.counts.all, 2); assert.equal(result.counts.trash, 1);
  assert.equal((await f.store.execute({ action: 'list', category: parent.id, includeDescendants: false })).total, 1);
  assert.equal((await f.store.execute({ action: 'list', category: parent.id, trashed: true })).total, 1);
  await write(f.categories, { action: 'move', id: parent.id, parentId: 'document' });
  result = await f.store.execute({ action: 'list', category: 'document' });
  assert.equal(result.total, 2); assert.equal(result.counts.document, 2);
  const stored = structuredClone([...f.notes.records]); const history = structuredClone([...f.versions.records]);
  await write(f.categories, { action: 'update', id: parent.id, name: 'Renamed work' });
  assert.deepEqual([...f.notes.records], stored); assert.deepEqual([...f.versions.records], history);
  await assert.rejects(f.store.execute({ action: 'create', category: randomUUID() }), code('NOT_FOUND'));
  await assert.rejects(f.store.execute({ action: 'update', id: a.id, revision: a.revision, category: randomUUID() }), code('NOT_FOUND'));
});

test('category snapshot ordering waits for preceding writes and excludes later changes', async () => {
  const f = fixture();
  await f.store.execute({ action: 'create', category: 'reading' });
  const pending = f.categories.execute({ action: 'create', revision: 0, name: 'Queued' });
  const listing = f.store.execute({ action: 'list', category: 'document' });
  const move = f.categories.execute({ action: 'move', revision: 1, id: 'reading', parentId: 'document' });
  const created = await pending; const custom = created.tree.items.at(-1).id;
  const earlier = await listing;
  assert.equal(earlier.counts[custom], 0);
  assert.equal(earlier.counts.document, 0); assert.equal(earlier.total, 0);
  await move;
  const later = await f.store.execute({ action: 'list', category: 'document' });
  assert.equal(later.total, 1); assert.equal(later.counts.document, 1);
});

test('old constructors and schema records retain exact fields and large UUID-category content', async () => {
  const f = fixture(); const old = new NotesStore(f.notes, f.versions);
  assert.deepEqual((await old.execute({ action: 'list' })).counts,
    { all: 0, document: 0, reading: 0, code: 0, journal: 0, trash: 0 });
  await assert.rejects(old.execute({ action: 'create', category: randomUUID() }), code('NOT_FOUND'));
  const note = (await old.execute({ action: 'create', content: '文本\r\n'.repeat(300000) })).note;
  const stored = f.notes.get(note.id); const custom = { ...stored, category: randomUUID() };
  assert.deepEqual(noteSchema.parse(custom), custom);
  const version = { ...custom, versionId: `${custom.id}:1`, noteId: custom.id, savedAt: custom.updatedAt };
  assert.deepEqual(noteVersionSchema.parse(version), version);
  f.notes.records.set(note.id, custom);
  assert.deepEqual((await old.execute({ action: 'get', id: note.id })).note, custom);
  assert.equal((await old.execute({ action: 'list' })).counts.all, 1);
});

test('HTTP and tool registration expose CAS with useful error statuses', async () => {
  const f = fixture(); let route; let tool;
  registerCategories({ effect: fn => fn(), connection: { fetch: { register: value => { route = value; } } },
    tools: { register: value => { tool = value; } } }, f.categories);
  assert.equal(route.path, '/api/dsh-note/categories'); assert.equal(tool.name, 'manage_note_categories');
  assert.equal((await route.fetch(new Request('http://local', { method: 'GET' }))).status, 200);
  await tool.execute({ action: 'create', revision: 0, name: 'Tool' });
  for (const [request, expected] of [
    [{ action: 'create', revision: 0, name: 'Conflict' }, 409],
    [{ action: 'update', revision: 1, id: randomUUID(), name: 'Missing' }, 404],
    [{ action: 'create', revision: 1, name: '' }, 400],
  ]) assert.equal((await route.fetch(new Request('http://local', { method: 'POST', body: JSON.stringify(request) }))).status, expected);
});
