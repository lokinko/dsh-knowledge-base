import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AttachmentStorage } from './attachment-storage.js';

export const NOTE_STORAGE_CONTROL_KEY = 'state';
export const noteStorageControlSchema = z.object({
  libraryId: z.string().uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  directory: z.string(),
  generation: z.union([z.literal(''), z.string().uuid()]),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict().refine(value => Boolean(value.directory) === Boolean(value.generation), 'Invalid storage pointer');

const TABLES = ['notes', 'note_versions', 'note_chats'];
const FORMAT = 'dsh.todo-manager.notebook';
const MANAGED = 'dsh-notebook';
const clone = value => structuredClone(value);
const fail = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const filename = key => createHash('sha256').update(key, 'utf8').digest('hex') + '.json';
const pointerKey = name => name === 'notes' || name === 'attachments' ? 'id' : name === 'note_versions' ? 'versionId' : 'noteId';
const exists = async target => { try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

async function plainDirectory(target) {
  const stat = await exists(target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw fail('INVALID_DIRECTORY', 'Expected an existing real directory: ' + target);
  return target;
}
async function plainFile(target) {
  const stat = await exists(target);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw fail('CORRUPT_STORAGE', 'Expected a regular managed file: ' + target);
}
async function jsonFile(target) {
  await plainFile(target);
  try { return JSON.parse(await fs.readFile(target, 'utf8')); }
  catch (error) { throw fail('CORRUPT_STORAGE', 'Invalid managed JSON: ' + target, error); }
}
async function syncDirectory(target) {
  // Windows does not expose portable directory fsync. File fsync is mandatory;
  // directory sync is additionally attempted on hosts which support it.
  let handle;
  try { handle = await fs.open(target, 'r'); await handle.sync(); }
  catch (error) { if (!['EISDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}
async function atomicJSON(target, value) {
  const parent = path.dirname(target);
  await plainDirectory(parent);
  const current = await exists(target);
  if (current && (current.isSymbolicLink() || !current.isFile())) throw fail('CORRUPT_STORAGE', 'Unsafe managed record path');
  const temporary = path.join(parent, '.tmp-' + randomUUID());
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, target);
    await syncDirectory(parent);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function canonicalDirectory(input, create = false) {
  if (typeof input !== 'string' || !input || input.includes('\0') || !path.isAbsolute(input) ||
      (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(input))) {
    throw fail('INVALID_DIRECTORY', 'Choose an absolute directory on the Host');
  }
  const requested = path.resolve(input);
  const suffix = [];
  let ancestor = requested;
  while (!await exists(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw fail('INVALID_DIRECTORY', 'Directory has no existing ancestor');
    suffix.unshift(path.basename(ancestor)); ancestor = parent;
  }
  const resolvedAncestor = await fs.realpath(ancestor);
  await plainDirectory(resolvedAncestor);
  const canonical = path.join(resolvedAncestor, ...suffix);
  if (create) {
    await fs.mkdir(canonical, { recursive: true });
    await plainDirectory(canonical);
    return { directory: await fs.realpath(canonical), exists: true, probe: canonical };
  }
  return { directory: canonical, exists: suffix.length === 0, probe: resolvedAncestor };
}
function livePID(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw fail('LOCKED', 'Invalid storage lock owner');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

/** Three dedicated notebook tables, with an opt-in attachment table. No todo table is accepted or modified.
 * Reads return immutable snapshots of the active route. Every mutation and
 * storage switch shares one queue; its backend is resolved at execution time.
 */
export class NoteStorage {
  constructor({ legacy, controlTable, schemas, initialDirectory = '', blobs }) {
    this.tables = Object.freeze([...TABLES, ...(legacy?.attachments && schemas?.attachments ? ['attachments'] : [])]);
    this.attachments = this.tables.includes('attachments') ? new AttachmentStorage(blobs) : null;
    for (const name of this.tables) {
      if (!legacy?.[name] || typeof schemas?.[name]?.parse !== 'function') throw new TypeError('Missing notebook table/schema: ' + name);
    }
    if (!controlTable) throw new TypeError('Storage control table is required');
    this.legacy = legacy;
    this.controlTable = controlTable;
    this.schemas = schemas;
    this.initialDirectory = initialDirectory;
    this._queue = Promise.resolve();
    this._state = null;
    this._maps = null;
    this._active = null;
    this._locks = new Set();
    this._proxies = new Map();
    this._startPromise = null;
    this._closePromise = null;
    this._closing = false;
    this._closed = false;
  }

  _validated(name, key, value) {
    if (typeof key !== 'string' || !key) throw fail('INVALID_RECORD', 'Invalid notebook record key');
    let parsed;
    try { parsed = this.schemas[name].parse(clone(value)); }
    catch (error) { throw fail('INVALID_RECORD', 'Invalid ' + name + ' record', error); }
    if (parsed[pointerKey(name)] !== key) throw fail('INVALID_RECORD', 'Notebook record key does not match its identity');
    return clone(parsed);
  }
  async _nativeSnapshot() {
    const maps = Object.fromEntries(this.tables.map(name => [name, new Map()]));
    for (const name of this.tables) {
      for await (const [key, value] of await this.legacy[name].entries()) {
        if (maps[name].has(key)) throw fail('INVALID_RECORD', 'Duplicate native notebook key');
        maps[name].set(key, this._validated(name, key, value));
      }
    }
    return maps;
  }
  _snapshot() {
    return Object.fromEntries(this.tables.map(name => [name, new Map([...this._maps[name]].map(([key, value]) => [key, this._validated(name, key, value)]))]));
  }
  _ready() {
    if (!this._maps || !this._state) throw fail('NOT_STARTED', 'Notebook storage has not started');
    if (this._closed) throw fail('CLOSED', 'Notebook storage is closed');
  }
  _enqueue(work) {
    if (this._closing) return Promise.reject(fail('CLOSED', 'Notebook storage is closing'));
    const result = this._queue.then(() => { this._ready(); return work(); });
    this._queue = result.catch(() => {});
    return result;
  }

  start() {
    if (this._closing) return Promise.reject(fail('CLOSED', 'Notebook storage is closed'));
    this._startPromise ??= this._start();
    return this._startPromise;
  }
  async _start() {
    let state;
    try {
      const stored = await this.controlTable.get(NOTE_STORAGE_CONTROL_KEY);
      if (stored != null) {
        state = noteStorageControlSchema.parse(clone(stored));
        if (state.directory) {
          const canonical = await canonicalDirectory(state.directory);
          if (!canonical.exists || canonical.directory !== state.directory) throw fail('MISSING_STORAGE', 'Configured notebook directory is missing or changed');
          const root = await this._managed(canonical.directory, state.libraryId, false);
          const lock = await this._lock(root, state.libraryId);
          const active = { root, generation: state.generation, lock };
          const maps = await this._load(active, state.libraryId);
          this._active = active; this._maps = maps;
        } else this._maps = await this._nativeSnapshot();
        this._state = state;
      } else {
        state = noteStorageControlSchema.parse({ libraryId: randomUUID(), revision: 0, directory: '', generation: '', updatedAt: new Date().toISOString() });
        const maps = await this._nativeSnapshot();
        // Persist the stable library identity before creating any owned folder.
        // Revision zero means no storage choice has yet been committed.
        await this.controlTable.put(NOTE_STORAGE_CONTROL_KEY, clone(state));
        this._maps = maps; this._active = null; this._state = state;
      }
      // A failed initial migration keeps the revision-zero default pointer and
      // identity. Restart retries the configured target with that SAME owner;
      // it never silently opens blank native data or treats its own folder as foreign.
      // Returning to default after a saved choice has revision > 0 and is final.
      if (!this._state.directory && this._state.revision === 0 && this.initialDirectory) {
        await this._set(this.initialDirectory, 0);
      }
      return this;
    } catch (error) {
      await this._releaseAll();
      this._maps = null; this._state = null; this._active = null;
      throw error;
    }
  }

  table(name) {
    if (!this.tables.includes(name)) throw new TypeError('Unknown notebook table: ' + name);
    if (!this._proxies.has(name)) this._proxies.set(name, Object.freeze({
      get: async key => {
        this._ready();
        const value = this._maps[name].get(key);
        return value === undefined ? undefined : this._validated(name, key, value);
      },
      entries: async () => {
        this._ready();
        return [...this._maps[name]].map(([key, value]) => [key, this._validated(name, key, value)]);
      },
      put: (key, value) => {
        let captured;
        try { captured = this._validated(name, key, value); } catch (error) { return Promise.reject(error); }
        return this._enqueue(async () => {
          if (this._active) {
            await this._secureActive();
            if (name === 'attachments') {
              if (this._active.missingAttachments) return this._upgradeAttachments(key, captured);
              await this.attachments.ensure(this._generationRoot(this._active), captured,
                () => this.attachments.adapter.read(captured.ref));
            }
            await atomicJSON(this._recordPath(this._active, name, key), { key, value: captured });
          } else {
            if (name === 'attachments') await this.attachments.verify(this.attachments.adapter.read(captured.ref), captured);
            await this.legacy[name].put(key, clone(captured));
          }
          this._maps[name].set(key, captured);
        });
      },
      delete: key => this._enqueue(async () => {
        if (typeof key !== 'string' || !key) throw fail('INVALID_RECORD', 'Invalid notebook key');
        if (name === 'attachments') throw fail('INVALID_REQUEST', 'Attachment removal must preserve metadata with removedAt');
        if (this._active) {
          await this._secureActive();
          const file = this._recordPath(this._active, name, key);
          const stat = await exists(file);
          if (stat) { await plainFile(file); await fs.unlink(file); await syncDirectory(path.dirname(file)); }
        } else await this.legacy[name].delete(key);
        this._maps[name].delete(key);
      }),
    }));
    return this._proxies.get(name);
  }

  /** Capture the current backend in the same queue as switches and uploads.
   * The returned stream remains readable after migration: old generations stay.
   * Integrity is checked at EOF; callers must consume the stream to verify it.
   */
  readAttachment(row, signal) {
    let captured;
    try {
      if (!this.attachments) throw new TypeError('Attachments are not enabled');
      captured = this._validated('attachments', row?.id, row);
    } catch (error) { return Promise.reject(error); }
    return this._enqueue(async () => {
      signal?.throwIfAborted();
      if (this._active) {
        await this._secureActive();
        return this.attachments.directoryDescriptor(this._generationRoot(this._active), captured, signal);
      }
      return this.attachments.nativeDescriptor(captured, signal);
    });
  }
  async _attachmentSource(row, source = this._active) {
    return source
      ? (await this.attachments.directoryDescriptor(this._generationRoot(source), row)).data
      : this.attachments.adapter.read(row.ref);
  }
  async _upgradeAttachments(key, row) {
    // Old three-table generations are read-only during upgrade. Stage all four
    // tables, add the new blob, and publish only after the control write succeeds.
    await this._assertCurrentPointer();
    if (this._state.revision === Number.MAX_SAFE_INTEGER) throw fail('CONFLICT', 'Storage revision is exhausted');
    const maps = this._snapshot();
    maps.attachments.set(key, row);
    const active = { ...this._active, generation: randomUUID(), missingAttachments: false };
    await this._stage(active, maps, this._state.libraryId, value => value.id === key
      ? this.attachments.adapter.read(value.ref) : this._attachmentSource(value));
    const state = noteStorageControlSchema.parse({ ...this._state, generation: active.generation,
      revision: this._state.revision + 1, updatedAt: new Date().toISOString() });
    await this._assertCurrentPointer();
    await this.controlTable.put(NOTE_STORAGE_CONTROL_KEY, clone(state));
    this._state = state; this._active = active; this._maps = maps;
  }

  execute(input) {
    let request;
    try {
      request = clone(input);
      if (!request || typeof request !== 'object' || Array.isArray(request) || !['status', 'check', 'set'].includes(request.action)) throw fail('INVALID_REQUEST', 'Unknown storage action');
      const allowed = request.action === 'status' ? ['action'] : request.action === 'check' ? ['action', 'directory'] : ['action', 'directory', 'revision'];
      if (Object.keys(request).some(key => !allowed.includes(key))) throw fail('INVALID_REQUEST', 'Unexpected storage request field');
      if (request.action !== 'status' && typeof request.directory !== 'string') throw fail('INVALID_REQUEST', 'Directory is required');
      if (request.action === 'set' && (!Number.isSafeInteger(request.revision) || request.revision < 0)) throw fail('INVALID_REQUEST', 'Current storage revision is required');
    } catch (error) { return Promise.reject(error); }
    return this._enqueue(async () => {
      if (request.action === 'status') return this._status();
      if (request.action === 'check') return this._check(request.directory);
      return this._set(request.directory, request.revision);
    });
  }
  _status() {
    return { ok: true, revision: this._state.revision, directory: this._state.directory,
      mode: this._active ? 'directory' : 'default', libraryId: this._state.libraryId,
      counts: { notes: this._maps.notes.size, versions: this._maps.note_versions.size, bindings: this._maps.note_chats.size,
        ...(this.attachments ? { attachments: this._maps.attachments.size } : {}) } };
  }

  async _managed(directory, libraryId, create) {
    await plainDirectory(directory);
    const root = path.join(directory, MANAGED);
    let stat = await exists(root);
    let created = false;
    if (!stat && create) {
      try { await fs.mkdir(root, { mode: 0o700 }); created = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await exists(root);
    }
    if (!stat) throw fail('MISSING_STORAGE', 'Configured managed notebook folder is missing');
    await plainDirectory(root);
    if (created) {
      await atomicJSON(path.join(root, 'library.json'), { format: FORMAT, version: 1, libraryId });
      await fs.mkdir(path.join(root, 'generations'), { mode: 0o700 });
    }
    const marker = await jsonFile(path.join(root, 'library.json'));
    if (marker?.format !== FORMAT || marker.version !== 1 || !z.string().uuid().safeParse(marker.libraryId).success) throw fail('CORRUPT_STORAGE', 'Invalid managed notebook ownership marker');
    if (marker.libraryId !== libraryId) throw fail('FOREIGN_LIBRARY', 'This directory belongs to a different notebook library');
    const allowed = new Set(['library.json', 'generations', '.lock', '.reclaim.lock']);
    for (const entry of await fs.readdir(root)) if (!allowed.has(entry)) throw fail('CORRUPT_STORAGE', 'Unrecognized file in managed notebook folder');
    await plainDirectory(path.join(root, 'generations'));
    return root;
  }
  async _lock(root, libraryId) {
    const file = path.join(root, '.lock');
    const value = { version: 1, libraryId, pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString() };
    const raw = JSON.stringify(value);
    for (let attempt = 0; attempt < 3; attempt++) {
      const guardFile = path.join(root, '.reclaim.lock');
      if (await exists(guardFile)) {
        let guard;
        try { guard = await jsonFile(guardFile); } catch { throw fail('LOCKED', 'Notebook reclaim guard requires manual recovery'); }
        if (guard?.libraryId !== libraryId || !Number.isSafeInteger(guard.pid) || guard.pid <= 0 || !livePID(guard.pid)) {
          throw fail('LOCKED', 'Stale or invalid notebook reclaim guard requires manual recovery');
        }
      }
      let handle;
      try {
        handle = await fs.open(file, 'wx', 0o600);
        await handle.writeFile(raw, 'utf8'); await handle.sync(); await handle.close(); handle = null;
        const lock = { file, raw };
        this._locks.add(lock);
        return lock;
      } catch (error) {
        if (handle) {
          await handle.close();
          await fs.unlink(file).catch(() => {});
        }
        if (error.code !== 'EEXIST') throw error;
        await this._reclaimDeadLock(root, file, libraryId);
      }
    }
    throw fail('LOCKED', 'Could not acquire notebook directory lock');
  }
  async _reclaimDeadLock(root, file, libraryId) {
    // Raw reread+unlink is not compare-and-swap: another reclaimer could replace
    // .lock between them. An exclusive guard serializes all stale-lock removal.
    // The guard itself is never automatically reclaimed; a crashed guard owner
    // requires explicit manual recovery rather than recursing into the same race.
    const guardFile = path.join(root, '.reclaim.lock');
    const raw = JSON.stringify({ version: 1, libraryId, pid: process.pid, token: randomUUID() });
    let handle, acquired = false;
    try {
      try { handle = await fs.open(guardFile, 'wx', 0o600); acquired = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = await jsonFile(guardFile); } catch { throw fail('LOCKED', 'Notebook reclaim guard requires manual recovery'); }
        const alive = Number.isSafeInteger(owner?.pid) && owner.pid > 0 && livePID(owner.pid);
        throw fail('LOCKED', alive ? 'Notebook lock recovery is already in progress' : 'Stale notebook reclaim guard requires manual recovery');
      }
      await handle.writeFile(raw, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      // Fresh wx acquirers may win after a previous holder releases its lock.
      // Re-read the actual lock under the guard and verify its current PID.
      if (!await exists(file)) return;
      const previous = await jsonFile(file);
      if (previous?.version !== 1 || previous.libraryId !== libraryId || typeof previous.token !== 'string' ||
          !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || livePID(previous.pid)) {
        throw fail('LOCKED', 'Notebook directory is already in use or its lock is invalid');
      }
      await fs.unlink(file);
    } finally {
      await handle?.close();
      if (acquired) {
        try { if (await fs.readFile(guardFile, 'utf8') === raw) await fs.unlink(guardFile); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  async _release(lock) {
    if (!lock) return;
    try {
      await plainFile(lock.file);
      if (await fs.readFile(lock.file, 'utf8') === lock.raw) await fs.unlink(lock.file);
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'CORRUPT_STORAGE') return; }
    this._locks.delete(lock);
  }
  async _releaseAll() { for (const lock of [...this._locks]) await this._release(lock); }
  _generationRoot(active) { return path.join(active.root, 'generations', active.generation); }
  _recordPath(active, name, key) { return path.join(this._generationRoot(active), name, filename(key)); }
  async _secureActive() {
    if (!this._active) return;
    await this._managed(this._state.directory, this._state.libraryId, false);
    const root = this._generationRoot(this._active);
    await plainDirectory(root);
    for (const name of this.tables) {
      if (name === 'attachments' && this._active.missingAttachments) continue;
      await plainDirectory(path.join(root, name));
    }
    if (this.attachments && !this._active.missingAttachments) await plainDirectory(path.join(root, 'blobs'));
    await plainFile(this._active.lock.file);
    if (await fs.readFile(this._active.lock.file, 'utf8') !== this._active.lock.raw) throw fail('LOCKED', 'Notebook directory ownership lock changed');
  }
  async _stage(active, maps, libraryId, source = row => this._attachmentSource(row)) {
    const generations = path.join(active.root, 'generations');
    const staging = path.join(generations, '.stage-' + active.generation);
    await plainDirectory(generations);
    await fs.mkdir(staging, { mode: 0o700 });
    if (this.attachments) {
      await fs.mkdir(path.join(staging, 'blobs'), { mode: 0o700 });
      for (const row of maps.attachments.values()) await this.attachments.ensure(staging, row, () => source(row));
    }
    for (const name of this.tables) {
      const table = path.join(staging, name);
      await fs.mkdir(table, { mode: 0o700 });
      for (const [key, value] of maps[name]) await atomicJSON(path.join(table, filename(key)), { key, value: this._validated(name, key, value) });
    }
    await atomicJSON(path.join(staging, 'generation.json'), { format: FORMAT, version: 1, libraryId, generation: active.generation,
      ...(this.attachments ? { tables: [...this.tables] } : {}) });
    await fs.rename(staging, this._generationRoot(active));
    await syncDirectory(generations);
    // Verify the entire newly written generation before committing the pointer.
    await this._load(active, libraryId, true);
  }
  async _load(active, libraryId, verifyBlobs = false) {
    const root = this._generationRoot(active);
    await plainDirectory(root);
    const marker = await jsonFile(path.join(root, 'generation.json'));
    if (marker?.format !== FORMAT || marker.version !== 1 || marker.libraryId !== libraryId || marker.generation !== active.generation) throw fail('CORRUPT_STORAGE', 'Invalid notebook generation marker');
    if (marker.tables !== undefined && (!Array.isArray(marker.tables) || marker.tables.length !== this.tables.length ||
        marker.tables.some((name, index) => name !== this.tables[index]))) throw fail('CORRUPT_STORAGE', 'Unsupported notebook generation tables');
    // Only a historical generation with no tables declaration may omit the
    // ancillary table. Missing any of the original three remains corruption.
    const missingAttachments = Boolean(this.attachments && marker.tables === undefined);
    const allowed = new Set([...this.tables, 'generation.json', ...(this.attachments ? ['blobs'] : [])]);
    for (const entry of await fs.readdir(root)) if (!allowed.has(entry)) throw fail('CORRUPT_STORAGE', 'Unrecognized notebook generation entry');
    if (missingAttachments && (await exists(path.join(root, 'attachments')) || await exists(path.join(root, 'blobs')))) throw fail('CORRUPT_STORAGE', 'Undeclared attachment storage in historical generation');
    const maps = Object.fromEntries(this.tables.map(name => [name, new Map()]));
    for (const name of this.tables) {
      if (name === 'attachments' && missingAttachments) continue;
      const table = path.join(root, name);
      await plainDirectory(table);
      for (const entry of await fs.readdir(table)) {
        if (/^\.tmp-[0-9a-f-]+$/.test(entry)) { await plainFile(path.join(table, entry)); continue; }
        if (!/^[0-9a-f]{64}\.json$/.test(entry)) throw fail('CORRUPT_STORAGE', 'Unrecognized notebook record file');
        const record = await jsonFile(path.join(table, entry));
        if (!record || typeof record.key !== 'string' || filename(record.key) !== entry || maps[name].has(record.key)) throw fail('CORRUPT_STORAGE', 'Notebook record filename or identity mismatch');
        try { maps[name].set(record.key, this._validated(name, record.key, record.value)); }
        catch (error) { throw fail('CORRUPT_STORAGE', 'Invalid persisted notebook record', error); }
      }
    }
    if (this.attachments && !missingAttachments) {
      const blobs = path.join(root, 'blobs');
      await plainDirectory(blobs);
      for (const entry of await fs.readdir(blobs)) {
        if (!/^(?:[a-f0-9]{64}|\.tmp-[0-9a-f-]+)$/.test(entry)) throw fail('CORRUPT_STORAGE', 'Unrecognized attachment object file');
        await plainFile(path.join(blobs, entry));
      }
      // Cold starts validate metadata, regular paths and lengths without reading
      // binary contents. Full SHA-256 verification remains mandatory when staging
      // a migration and when a caller consumes an attachment stream to EOF.
      for (const row of maps.attachments.values()) {
        const descriptor = await this.attachments.directoryDescriptor(root, row);
        if (verifyBlobs) await this.attachments.verify(descriptor.data, row);
      }
    }
    active.missingAttachments = missingAttachments;
    return maps;
  }

  async _check(input) {
    if (input === '') return { ok: true, directory: '', mode: 'default', writable: true, exists: true, ownedState: 'default' };
    const canonical = await canonicalDirectory(input);
    const result = { ok: true, directory: canonical.directory, mode: 'directory', writable: false, exists: canonical.exists, ownedState: 'uninitialized' };
    const root = path.join(canonical.directory, MANAGED);
    if (await exists(root)) {
      try {
        await this._managed(canonical.directory, this._state.libraryId, false);
        result.ownedState = 'owned';
        if (await exists(path.join(root, '.reclaim.lock'))) return { ...result, code: 'LOCKED', locked: true };
        const lockFile = path.join(root, '.lock');
        if (await exists(lockFile)) {
          const lock = await jsonFile(lockFile);
          const ours = this._active?.root === root && await fs.readFile(lockFile, 'utf8') === this._active.lock.raw;
          if (!ours && livePID(lock.pid)) return { ...result, code: 'LOCKED', locked: true };
        }
        if (this._active?.root === root) await this._load(this._active, this._state.libraryId);
      } catch (error) { return { ...result, ownedState: error.code === 'FOREIGN_LIBRARY' ? 'foreign' : 'corrupt', code: error.code || 'INVALID_DIRECTORY' }; }
    }
    const probes = result.ownedState === 'owned' ? [root, path.join(root, 'generations'),
      ...(this._active?.root === root ? this.tables.filter(name => name !== 'attachments' || !this._active.missingAttachments)
         .map(name => path.join(this._generationRoot(this._active), name)) : []),
      ...(this._active?.root === root && this.attachments && !this._active.missingAttachments ? [path.join(this._generationRoot(this._active), 'blobs')] : [])] : [canonical.probe];
    for (const parent of probes) {
      const probe = path.join(parent, '.dsh-notebook-check-' + randomUUID());
      let handle, created = false;
      try { handle = await fs.open(probe, 'wx', 0o600); created = true; await handle.sync(); }
      catch (error) { return { ...result, code: error.code || 'NOT_WRITABLE' }; }
      finally { await handle?.close(); if (created) await fs.unlink(probe).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return { ...result, writable: true };
  }
  async _replaceNative(maps) {
    for (const name of this.tables) {
      const keys = [];
      for await (const [key] of await this.legacy[name].entries()) keys.push(key);
      for (const [key, value] of maps[name]) await this.legacy[name].put(key, clone(value));
      for (const key of keys) if (!maps[name].has(key)) await this.legacy[name].delete(key);
    }
  }
  async _assertCurrentPointer() {
    const stored = await this.controlTable.get(NOTE_STORAGE_CONTROL_KEY);
    const parsed = noteStorageControlSchema.safeParse(stored);
    if (!parsed.success || ['libraryId', 'revision', 'directory', 'generation'].some(key => parsed.data[key] !== this._state[key])) {
      throw fail('CONFLICT', 'Notebook storage pointer changed elsewhere. Restart or refresh before switching.');
    }
  }
  async _set(input, revision) {
    if (revision !== this._state.revision) throw fail('CONFLICT', 'Notebook storage settings changed. Refresh and retry.');
    await this._assertCurrentPointer();
    if (this._state.revision === Number.MAX_SAFE_INTEGER) throw fail('CONFLICT', 'Storage revision is exhausted');
    let directory = '';
    if (input) directory = (await canonicalDirectory(input, true)).directory;
    if (directory === this._state.directory) {
      if (this._active) { await this._secureActive(); await this._load(this._active, this._state.libraryId); }
      return this._status();
    }
    if (this.attachments && this._active) await this._secureActive();
    const snapshot = this._snapshot();
    const oldActive = this._active;
    let active = null, nativeBefore = null;
    try {
      if (directory) {
        const root = await this._managed(directory, this._state.libraryId, true);
        const lock = await this._lock(root, this._state.libraryId);
        active = { root, generation: randomUUID(), lock };
        await this._stage(active, snapshot, this._state.libraryId);
      } else {
        if (this.attachments) {
          await this._secureActive();
          for (const row of snapshot.attachments.values()) await this.attachments.restore(row, () => this._attachmentSource(row));
        }
        nativeBefore = await this._nativeSnapshot();
        await this._replaceNative(snapshot);
      }
      const state = noteStorageControlSchema.parse({ ...this._state, revision: revision + 1, directory,
        generation: active?.generation ?? '', updatedAt: new Date().toISOString() });
      await this._assertCurrentPointer();
      await this.controlTable.put(NOTE_STORAGE_CONTROL_KEY, clone(state));
      // Pointer commit is the migration's linearization point. Queued mutations
      // admitted during staging execute later against this new active route.
      this._state = state; this._active = active; this._maps = snapshot;
      await this._release(oldActive?.lock);
      return this._status();
    } catch (error) {
      if (nativeBefore) {
        try { await this._replaceNative(nativeBefore); }
        catch (rollback) { error.rollbackError = rollback; }
      }
      await this._release(active?.lock);
      throw error;
    }
  }
  close() {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this._closePromise = Promise.resolve(this._startPromise).catch(() => {}).then(() => this._queue)
      .then(async () => { await this._releaseAll(); this._closed = true; });
    return this._closePromise;
  }
}
