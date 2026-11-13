import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NoteStorage, NOTE_STORAGE_CONTROL_KEY } from '../../src/host/storage/note-storage.js';
import { attachmentSchema } from '../../src/host/attachments/schema.js';
import { noteSchema, noteVersionSchema } from '../../src/host/notes/store.js';
import { chatBindingSchema } from '../../src/host/coauthor/note-chats.js';

const now = '2026-11-09T00:00:00.000Z';
const hash = data => createHash('sha256').update(data).digest('hex');
const schemas = { notes: noteSchema, note_versions: noteVersionSchema, note_chats: chatBindingSchema, attachments: attachmentSchema };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
class Table {
  data = new Map(); failPut = false; beforePut;
  async get(key) { return structuredClone(this.data.get(key)); }
  async entries() { return structuredClone([...this.data]); }
  async put(key, value) {
    await this.beforePut?.(key, value);
    if (this.failPut) throw new Error('fixture put failed');
    this.data.set(key, structuredClone(value));
  }
  async delete(key) { this.data.delete(key); }
}
async function* diskStream(file, signal) {
  const handle = await fs.open(file, 'r');
  try {
    while (true) {
      signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(32 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally { await handle.close(); }
}
// Disk-backed fake for the exact immutable service adapter contract. Its ID is
// intentionally distinct from SHA filenames, so no ID-to-path assumptions pass.
class Blobs {
  constructor(root) { this.root = root; }
  failSave = false; wrongRef = false; beforeRead; maxChunk = 0; saved = 0; reads = 0;
  hostPath(ref) {
    assert.match(ref.attachmentId, /^fake-file:[a-f0-9]{64}$/);
    return path.join(this.root, ref.attachmentId.slice(10));
  }
  async save({ data, name = '', signal }) {
    if (this.failSave) throw new Error('fixture blob save failed');
    const temporary = path.join(this.root, '.tmp-' + randomUUID());
    const handle = await fs.open(temporary, 'wx');
    const digest = createHash('sha256'); let bytes = 0;
    try {
      for await (const chunk of data) {
        signal?.throwIfAborted();
        this.maxChunk = Math.max(this.maxChunk, chunk.length);
        digest.update(chunk); bytes += chunk.length;
        await handle.writeFile(chunk);
      }
      await handle.sync();
    } finally { await handle.close(); }
    const id = digest.digest('hex');
    await fs.rename(temporary, path.join(this.root, id));
    this.saved++;
    return { attachmentId: 'fake-file:' + (this.wrongRef ? '0'.repeat(64) : id), name, bytes };
  }
  async *read(ref, signal) {
    this.reads++;
    await this.beforeRead?.(ref);
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of diskStream(this.hostPath(ref), signal)) { digest.update(chunk); bytes += chunk.length; yield chunk; }
    assert.equal(bytes, ref.bytes); assert.equal('fake-file:' + digest.digest('hex'), ref.attachmentId);
  }
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dsh-attachment-storage-test-'));
  const native = path.join(temp, 'native'); await fs.mkdir(native);
  const blobs = new Blobs(native);
  const legacy = Object.fromEntries(Object.keys(schemas).map(name => [name, new Table()]));
  const controlTable = new Table(), managers = [];
  const make = (options = {}) => {
    const manager = new NoteStorage({ legacy, schemas, controlTable, blobs, ...options }); managers.push(manager); return manager;
  };
  const checked = target => {
    const absolute = path.resolve(target);
    assert.ok(absolute.startsWith(path.resolve(temp) + path.sep), 'Mutations must stay in the owned absolute fixture prefix');
    return absolute;
  };
  t.after(async () => {
    for (const manager of managers.reverse()) await manager.close();
    const absolute = path.resolve(temp);
    assert.ok(path.basename(absolute).startsWith('dsh-attachment-storage-test-'));
    assert.equal(path.dirname(absolute), await fs.realpath(os.tmpdir()));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const state = () => structuredClone(controlTable.data.get(NOTE_STORAGE_CONTROL_KEY));
  const root = (pointer = state()) => path.join(pointer.directory, 'dsh-notebook', 'generations', pointer.generation);
  const record = (row, pointer = state()) => path.join(root(pointer), 'attachments', hash(row.id) + '.json');
  const blob = (row, pointer = state()) => path.join(root(pointer), 'blobs', row.sha256);
  const putBytes = async (bytes, patch = {}) => {
    const ref = await blobs.save({ data: (async function* () { yield bytes; })(), name: patch.name || 'same.bin' });
    return attachmentSchema.parse({ id: randomUUID(), ownerType: 'note', ownerId: randomUUID(), name: ref.name,
      mediaType: 'application/octet-stream', size: bytes.length, sha256: hash(bytes), ref, revision: 1, createdAt: now, removedAt: '', ...patch });
  };
  const switchTo = async (manager, directory) => manager.execute({ action: 'set', directory, revision: (await manager.execute({ action: 'status' })).revision });
  return { temp, native, blobs, legacy, controlTable, make, state, root, record, blob, putBytes, switchTo, checked };
}
async function digestDescriptor(descriptor) {
  const hash = createHash('sha256'); let size = 0, max = 0;
  for await (const chunk of descriptor.data) { hash.update(chunk); size += chunk.length; max = Math.max(max, chunk.length); }
  return { sha256: hash.digest('hex'), size, max };
}
async function checkRead(manager, row, expectedPath) {
  const descriptor = await manager.readAttachment(row);
  if (expectedPath) assert.equal(descriptor.hostPath, expectedPath);
  const actual = await digestDescriptor(descriptor);
  assert.equal(actual.sha256, row.sha256); assert.equal(actual.size, row.size); assert.ok(actual.max <= 64 * 1024);
}

test('attachment support is strictly opt-in and needs the complete blob adapter only when enabled', async t => {
  const f = await fixture(t);
  const noTable = { ...f.legacy }; delete noTable.attachments;
  const a = await f.make({ legacy: noTable, blobs: undefined }).start();
  assert.deepEqual((await a.execute({ action: 'status' })).counts, { notes: 0, versions: 0, bindings: 0 });
  assert.throws(() => a.table('attachments'), /Unknown notebook table/);
  const noSchema = { ...schemas }; delete noSchema.attachments;
  const b = await f.make({ schemas: noSchema, blobs: undefined }).start();
  assert.throws(() => b.table('attachments'), /Unknown notebook table/);
  assert.throws(() => f.make({ blobs: undefined }), /blobs adapter/);
});

test('old three-table directory reopens with attachments empty; first upload stages a new owned generation', async t => {
  const f = await fixture(t);
  const legacy = { ...f.legacy }; delete legacy.attachments;
  const old = await f.make({ legacy, blobs: undefined }).start();
  await f.switchTo(old, path.join(f.temp, 'old-library'));
  const pointer = f.state(), oldRoot = f.root(pointer);
  const marker = await fs.readFile(path.join(oldRoot, 'generation.json'), 'utf8');
  const listing = await fs.readdir(oldRoot);
  await old.close();
  const upgraded = await f.make().start();
  assert.deepEqual((await upgraded.execute({ action: 'status' })).counts, { notes: 0, versions: 0, bindings: 0, attachments: 0 });
  assert.equal((await upgraded.execute({ action: 'check', directory: pointer.directory })).writable, true);
  assert.deepEqual(f.state(), pointer, 'Reading the old directory must not rewrite its pointer or files');
  const row = await f.putBytes(Buffer.from('legacy upgrade\0raw'));
  await upgraded.table('attachments').put(row.id, row);
  assert.notEqual(f.state().generation, pointer.generation);
  assert.equal(f.state().revision, pointer.revision + 1);
  assert.equal(await fs.readFile(path.join(oldRoot, 'generation.json'), 'utf8'), marker);
  assert.deepEqual(await fs.readdir(oldRoot), listing);
  await checkRead(upgraded, row, f.blob(row));
  await upgraded.close();
  await checkRead(await f.make().start(), row, f.blob(row));
});

test('failed old-generation upgrade keeps its pointer, memory, and source files intact', async t => {
  const f = await fixture(t), legacy = { ...f.legacy }; delete legacy.attachments;
  const old = await f.make({ legacy, blobs: undefined }).start();
  await f.switchTo(old, path.join(f.temp, 'upgrade-fail')); await old.close();
  const manager = await f.make().start(), pointer = f.state();
  const row = await f.putBytes(Buffer.from('not committed'));
  f.controlTable.failPut = true;
  await assert.rejects(manager.table('attachments').put(row.id, row), /fixture put failed/);
  assert.deepEqual(f.state(), pointer); assert.equal(await manager.table('attachments').get(row.id), undefined);
  assert.equal((await fs.readdir(f.root(pointer))).includes('attachments'), false);
  f.controlTable.failPut = false;
  await manager.table('attachments').put(row.id, row); await checkRead(manager, row);
});

test('large exact bytes, zero bytes, same filenames and both owner types survive default→A→B→default→restart', async t => {
  const f = await fixture(t), manager = await f.make().start();
  const rows = [await f.putBytes(Buffer.alloc(3 * 1024 * 1024 + 71, 197)), await f.putBytes(Buffer.alloc(0)),
    await f.putBytes(Buffer.from('%PDF-1.7\r\n\0\xffpayload'), { ownerType: 'task', mediaType: 'application/pdf' })];
  for (const row of rows) { await manager.table('attachments').put(row.id, row); await checkRead(manager, row, f.blobs.hostPath(row.ref)); }
  await f.switchTo(manager, path.join(f.temp, 'A'));
  const a = f.state();
  for (const row of rows) {
    await checkRead(manager, row, f.blob(row));
    const raw = await fs.readFile(f.record(row), 'utf8');
    assert.deepEqual(JSON.parse(raw), { key: row.id, value: row });
    assert.equal(raw.includes('base64'), false); assert.ok(raw.length < 1500);
  }
  // Subsequent migrations must read the active custom copies, even if native
  // copies disappeared. Sources remain immutable backup files on disk.
  for (const row of rows) await fs.unlink(f.checked(f.blobs.hostPath(row.ref)));
  const reads = f.blobs.reads;
  await f.switchTo(manager, path.join(f.temp, 'B'));
  const b = f.state(); assert.equal(f.blobs.reads, reads);
  for (const row of rows) { await checkRead(manager, row); assert.equal((await fs.stat(f.blob(row, a))).size, row.size); }
  await f.switchTo(manager, '');
  for (const row of rows) {
    assert.deepEqual(await manager.table('attachments').get(row.id), row);
    await checkRead(manager, row, f.blobs.hostPath(row.ref));
    assert.equal((await fs.stat(f.blob(row, a))).size, row.size); assert.equal((await fs.stat(f.blob(row, b))).size, row.size);
  }
  assert.equal((await manager.execute({ action: 'status' })).counts.attachments, 3);
  await manager.close(); const restarted = await f.make().start();
  for (const row of rows) { assert.deepEqual(await restarted.table('attachments').get(row.id), row); await checkRead(restarted, row); }
});

test('metadata update changes one row only, preserves removed blobs and historical references', async t => {
  const f = await fixture(t), manager = await f.make().start();
  const a = await f.putBytes(Buffer.from('a')), b = await f.putBytes(Buffer.from('b'));
  for (const row of [a, b]) await manager.table('attachments').put(row.id, row);
  await f.switchTo(manager, path.join(f.temp, 'one-row'));
  const pointer = f.state(), before = await fs.stat(f.record(b)), blobBefore = await fs.stat(f.blob(a));
  const marker = await fs.readFile(path.join(f.root(), 'generation.json'), 'utf8');
  await fs.unlink(f.checked(f.blobs.hostPath(a.ref)));
  const removed = { ...a, revision: 2, removedAt: now };
  await manager.table('attachments').put(a.id, removed);
  assert.deepEqual(f.state(), pointer);
  assert.equal((await fs.stat(f.record(b))).mtimeMs, before.mtimeMs);
  assert.equal((await fs.stat(f.record(b))).ino, before.ino);
  assert.equal((await fs.stat(f.blob(a))).mtimeMs, blobBefore.mtimeMs);
  assert.equal(await fs.readFile(path.join(f.root(), 'generation.json'), 'utf8'), marker);
  await assert.rejects(manager.table('attachments').delete(a.id), { code: 'INVALID_REQUEST' });
  await checkRead(manager, a);
  await f.switchTo(manager, path.join(f.temp, 'removed-migrated'));
  assert.equal((await manager.execute({ action: 'status' })).counts.attachments, 2);
  await checkRead(manager, removed);
  await f.switchTo(manager, ''); await checkRead(manager, a);
});

for (const fault of ['missing', 'corrupt', 'size']) test(`${fault} custom blob rejects migration and download without native fallback or pointer commit`, async t => {
  const f = await fixture(t), manager = await f.make().start(), row = await f.putBytes(Buffer.from('original bytes'));
  await manager.table('attachments').put(row.id, row);
  await f.switchTo(manager, path.join(f.temp, fault));
  const pointer = f.state(), file = f.checked(f.blob(row)), reads = f.blobs.reads;
  if (fault === 'missing') await fs.unlink(file);
  else await fs.writeFile(file, Buffer.from(fault === 'size' ? 'short' : 'different data'));
  await assert.rejects((async () => digestDescriptor(await manager.readAttachment(row)))());
  await assert.rejects(f.switchTo(manager, path.join(f.temp, fault + '-target')));
  assert.deepEqual(f.state(), pointer); assert.deepEqual(await manager.table('attachments').get(row.id), row);
  await assert.rejects(f.switchTo(manager, ''));
  assert.deepEqual(f.state(), pointer); assert.equal(f.blobs.reads, reads);
});

test('immutable service failure and changed content identity reject return to default before native metadata reconciliation', async t => {
  const f = await fixture(t), manager = await f.make().start(), row = await f.putBytes(Buffer.from('restore'));
  await manager.table('attachments').put(row.id, row); await f.switchTo(manager, path.join(f.temp, 'restore-fail'));
  const pointer = f.state(), nativeBefore = await f.legacy.attachments.entries();
  f.blobs.failSave = true;
  await assert.rejects(f.switchTo(manager, ''), /blob save failed/);
  f.blobs.failSave = false; f.blobs.wrongRef = true;
  await assert.rejects(f.switchTo(manager, ''), { code: 'CORRUPT_ATTACHMENT' });
  assert.deepEqual(f.state(), pointer); assert.deepEqual(await f.legacy.attachments.entries(), nativeBefore);
});

test('pointer commit failure on return to default rolls all four native tables back', async t => {
  const f = await fixture(t), manager = await f.make().start(), row = await f.putBytes(Buffer.from('native rollback'));
  await manager.table('attachments').put(row.id, row); await f.switchTo(manager, path.join(f.temp, 'rollback'));
  const newer = { ...row, revision: 2, removedAt: now };
  await manager.table('attachments').put(row.id, newer);
  const before = await f.legacy.attachments.entries(), pointer = f.state();
  f.controlTable.failPut = true;
  await assert.rejects(f.switchTo(manager, ''), /fixture put failed/);
  assert.deepEqual(f.state(), pointer); assert.deepEqual(await f.legacy.attachments.entries(), before);
  assert.deepEqual(await manager.table('attachments').get(row.id), newer);
});

test('failed metadata write keeps memory unchanged after a durable blob copy', async t => {
  const f = await fixture(t), manager = await f.make().start();
  await f.switchTo(manager, path.join(f.temp, 'metadata-fail'));
  const row = await f.putBytes(Buffer.from('blob is preserved on failed metadata'));
  await fs.mkdir(f.checked(f.record(row)));
  await assert.rejects(manager.table('attachments').put(row.id, row), { code: 'CORRUPT_STORAGE' });
  assert.equal(await manager.table('attachments').get(row.id), undefined);
  assert.equal((await fs.stat(f.blob(row))).size, row.size);
});

test('uploads and storage switches serialize, including an upload queued during migration', async t => {
  const f = await fixture(t), manager = await f.make().start();
  const a = await f.putBytes(Buffer.from('first queued')), b = await f.putBytes(Buffer.from('second queued'));
  const entered = deferred(), release = deferred();
  f.blobs.beforeRead = async ref => { if (ref.attachmentId === a.ref.attachmentId) { entered.resolve(); await release.promise; } };
  const first = manager.table('attachments').put(a.id, a);
  await entered.promise;
  const switching = manager.execute({ action: 'set', directory: path.join(f.temp, 'queued'), revision: 0 });
  const second = manager.table('attachments').put(b.id, b);
  assert.equal(await manager.table('attachments').get(a.id), undefined);
  release.resolve(); await Promise.all([first, switching, second]);
  assert.deepEqual(await f.legacy.attachments.get(a.id), a);
  assert.equal(await f.legacy.attachments.get(b.id), undefined);
  for (const row of [a, b]) await checkRead(manager, row, f.blob(row));
  await manager.close();
  const reopened = await f.make().start();
  for (const row of [a, b]) await checkRead(reopened, row);
});

test('host-path-only descriptors never call the native stream adapter before iteration', async t => {
  const f = await fixture(t), manager = await f.make().start(), row = await f.putBytes(Buffer.from('lazy descriptor'));
  await manager.table('attachments').put(row.id, row);
  const read = f.blobs.read.bind(f.blobs); let called = 0;
  f.blobs.read = (...args) => { called++; return read(...args); };
  const descriptor = await manager.readAttachment(row);
  assert.equal(descriptor.hostPath, f.blobs.hostPath(row.ref)); assert.equal(called, 0);
  await digestDescriptor(descriptor); assert.equal(called, 1);
});

test('a descriptor captured before migration reads its retained source generation; abort closes iteration', async t => {
  const f = await fixture(t), manager = await f.make().start(), row = await f.putBytes(Buffer.alloc(3 * 1024 * 1024, 77));
  await manager.table('attachments').put(row.id, row); await f.switchTo(manager, path.join(f.temp, 'snapshot-A'));
  const descriptor = await manager.readAttachment(row), oldPath = descriptor.hostPath;
  await f.switchTo(manager, path.join(f.temp, 'snapshot-B'));
  assert.notEqual(oldPath, f.blob(row)); assert.equal((await digestDescriptor(descriptor)).sha256, row.sha256);
  const abort = new AbortController(), cancelled = await manager.readAttachment(row, abort.signal);
  const iterator = cancelled.data[Symbol.asyncIterator](); await iterator.next();
  abort.abort(new Error('fixture cancelled'));
  await assert.rejects(iterator.next(), /fixture cancelled/);
  await assert.rejects(manager.readAttachment(row, abort.signal), /fixture cancelled/);
});

test('large generated stream restores with bounded chunks and no binary payload in metadata', async t => {
  const f = await fixture(t), manager = await f.make().start();
  const size = 24 * 1024 * 1024 + 13, digest = createHash('sha256');
  const data = (async function* () {
    let left = size;
    while (left) { const chunk = Buffer.alloc(Math.min(left, 17 * 1024), left % 251); digest.update(chunk); left -= chunk.length; yield chunk; }
  })();
  const ref = await f.blobs.save({ data, name: 'stream.bin' });
  const row = attachmentSchema.parse({ id: randomUUID(), ownerType: 'task', ownerId: randomUUID(), name: ref.name,
    mediaType: 'application/octet-stream', size, sha256: digest.digest('hex'), ref, revision: 1, createdAt: now, removedAt: '' });
  await manager.table('attachments').put(row.id, row); await f.switchTo(manager, path.join(f.temp, 'stream'));
  await checkRead(manager, row); f.blobs.maxChunk = 0;
  await f.switchTo(manager, ''); assert.ok(f.blobs.maxChunk <= 64 * 1024);
  assert.ok(JSON.stringify(await manager.table('attachments').get(row.id)).length < 1500);
});

test('new generations reject missing core or attachment directories, missing blobs, and changed byte lengths on restart', async t => {
  for (const name of ['notes', 'attachments', 'blobs', 'missing-object', 'wrong-size']) {
    const f = await fixture(t), manager = await f.make().start(), row = await f.putBytes(Buffer.from(name));
    await manager.table('attachments').put(row.id, row); await f.switchTo(manager, path.join(f.temp, 'restart-' + name)); await manager.close();
    if (name === 'missing-object') await fs.unlink(f.checked(f.blob(row)));
    else if (name === 'wrong-size') await fs.writeFile(f.checked(f.blob(row)), Buffer.from('truncated'));
    else {
      const target = f.checked(path.join(f.root(), name));
      await fs.rename(target, f.checked(path.join(f.temp, name + '-moved-' + randomUUID())));
    }
    await assert.rejects(f.make().start());
  }
});

test('cold restart only stats binary objects; same-size corruption rejects read and migration; missing legacy core tables still fail', async t => {
  const f = await fixture(t), manager = await f.make().start(), row = await f.putBytes(Buffer.from('hash original'));
  await manager.table('attachments').put(row.id, row); await f.switchTo(manager, path.join(f.temp, 'restart-hash')); await manager.close();
  await fs.writeFile(f.checked(f.blob(row)), Buffer.from('hash changed!'));
  const reads = f.blobs.reads, pointer = f.state();
  const restarted = await f.make().start();
  assert.equal(f.blobs.reads, reads); assert.deepEqual(f.state(), pointer);
  assert.deepEqual(await restarted.table('attachments').get(row.id), row);
  await assert.rejects((async () => digestDescriptor(await restarted.readAttachment(row)))(), { code: 'CORRUPT_ATTACHMENT' });
  await assert.rejects(f.switchTo(restarted, path.join(f.temp, 'corrupt-migrate')), { code: 'CORRUPT_ATTACHMENT' });
  await assert.rejects(f.switchTo(restarted, ''), { code: 'CORRUPT_ATTACHMENT' });
  assert.deepEqual(f.state(), pointer);
  const other = await fixture(t), legacy = { ...other.legacy }; delete legacy.attachments;
  const old = await other.make({ legacy, blobs: undefined }).start();
  await other.switchTo(old, path.join(other.temp, 'legacy-core')); await old.close();
  await fs.rename(other.checked(path.join(other.root(), 'notes')), other.checked(path.join(other.temp, 'notes-moved')));
  await assert.rejects(other.make().start(), { code: 'INVALID_DIRECTORY' });
});

async function denyWrites(target) {
  if (process.platform === 'win32') {
    const account = process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' + process.env.USERNAME : process.env.USERNAME;
    assert.ok(account, 'Windows fixture needs its current account to set and restore its own ACL');
    const icacls = args => new Promise((resolve, reject) => {
      const child = spawn('icacls.exe', [target, ...args], { stdio: 'ignore' });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Fixture icacls failed: ' + code)));
    });
    await icacls(['/deny', account + ':(OI)(CI)(W)']);
    return () => icacls(['/remove:d', account]);
  }
  await fs.chmod(target, 0o500);
  return () => fs.chmod(target, 0o700);
}
test('read-only blob directory and migration target reject writes without committing memory or pointer', { skip: process.platform !== 'win32' && process.getuid?.() === 0 ? 'chmod cannot deny root writes' : false }, async t => {
  const f = await fixture(t), manager = await f.make().start();
  await f.switchTo(manager, path.join(f.temp, 'readonly'));
  const row = await f.putBytes(Buffer.from('denied')), directory = f.checked(path.join(f.root(), 'blobs'));
  const pointer = f.state();
  const restore = await denyWrites(directory);
  try {
    await assert.rejects(manager.table('attachments').put(row.id, row));
    assert.equal(await manager.table('attachments').get(row.id), undefined);
    assert.deepEqual(f.state(), pointer);
  } finally { await restore(); }
  await manager.table('attachments').put(row.id, row);
  const target = f.checked(path.join(f.temp, 'denied-migration')); await fs.mkdir(target);
  const restoreTarget = await denyWrites(target);
  try {
    await assert.rejects(f.switchTo(manager, target));
    assert.deepEqual(f.state(), pointer); await checkRead(manager, row);
  } finally { await restoreTarget(); }
});
