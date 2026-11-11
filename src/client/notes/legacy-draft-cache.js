import {NOTE_DRAFT_PREFIX as PREFIX,normalizeNoteFields as fieldsOf,validateDraftIdentity as identity,noteDraftKey as keyOf,cloneDraftRecord as cloneRecord,decodeLegacyDraft as decode} from './draft-record.js';

/** Keep one instance outside the editor so failed writes survive editor remounts. */
export class NoteDraftCache {
  constructor({ storageGetter = () => globalThis.localStorage } = {}) {
    this._storageGetter = storageGetter;
    this._memory = new Map();
    this._failed = new Map();
    this._lastWriteTime = 0;
    // A remotely saved record must not reappear in this instance if removal was
    // temporarily blocked. Cleanup is retried only with the original raw guard.
    this._removed = new Map();
  }

  _storage() {
    const storage = this._storageGetter();
    if (!storage) throw new Error('Draft storage is unavailable');
    return storage;
  }

  records() {
    const found = new Map();
    try {
      const storage = this._storage();
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (typeof key === 'string' && key.startsWith(PREFIX)) keys.push(key);
      }
      const inaccessible = new Set();
      let entryError;
      for (const key of keys) {
        // One malformed or inaccessible entry must not hide the other drafts.
        let raw;
        try { raw = storage.getItem(key); } catch (error) {
          inaccessible.add(key);
          entryError ??= error;
          continue;
        }
        if (this._removed.get(key)?.has(raw)) {
          try { storage.removeItem(key); this._removed.delete(key); } catch { /* retry next read */ }
          continue;
        }
        this._removed.delete(key);
        const record = decode(key, raw);
        if (record) found.set(key, record);
      }
      // Successful reads are authoritative for previously durable local writes.
      for (const [key, record] of this._memory) {
        if (this._failed.has(key)) continue;
        if (inaccessible.has(key)) found.set(key, { ...record, volatile: true });
        else if (found.has(key)) this._memory.set(key, found.get(key));
        else this._memory.delete(key);
      }
      if (entryError && !found.size && !this._failed.size) throw entryError;
    } catch (error) {
      if (!this._memory.size) throw error;
      for (const [key, record] of this._memory) found.set(key, { ...record, volatile: true });
    }
    // An unsuccessful newer write takes precedence over the old durable value.
    for (const [key, record] of this._failed) found.set(key, record);
    return [...found.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) ||
      a.key.localeCompare(b.key)).map(cloneRecord);
  }

  latest(noteId) {
    return this.records().filter(record => record.noteId === noteId).at(-1) ?? null;
  }

  write({ noteId, writerId, baseRevision, fields }) {
    identity(noteId, writerId, baseRevision);
    const normalized = fieldsOf(fields);
    this._lastWriteTime = Math.max(Date.now(), this._lastWriteTime + 1);
    const value = { version: 1, noteId, writerId, baseRevision,
      fields: normalized, updatedAt: new Date(this._lastWriteTime).toISOString() };
    const key = keyOf(noteId, writerId);
    const raw = JSON.stringify(value);
    const record = { ...value, key, raw, volatile: false };
    try {
      this._storage().setItem(key, raw);
      this._failed.delete(key);
      this._removed.delete(key);
    } catch {
      record.volatile = true;
      this._failed.set(key, record);
    }
    this._memory.set(key, record);
    return cloneRecord(record);
  }

  pending(noteId, writerId) {
    return cloneRecord(this._failed.get(keyOf(noteId, writerId)));
  }

  /** Remove only this exact snapshot, even when another tab reused its key. */
  remove(record) {
    if (!record || typeof record.key !== 'string' || !record.key.startsWith(PREFIX) ||
        typeof record.raw !== 'string') return false;
    for (const map of [this._memory, this._failed]) {
      if (map.get(record.key)?.raw === record.raw) map.delete(record.key);
    }
    const removed = this._removed.get(record.key) ?? new Set();
    removed.add(record.raw);
    this._removed.set(record.key, removed);
    try {
      const storage = this._storage();
      const raw = storage.getItem(record.key);
      if (raw === record.raw) storage.removeItem(record.key);
      removed.delete(record.raw);
      if (raw === null || raw === record.raw || !removed.size) this._removed.delete(record.key);
      return raw === null || raw === record.raw;
    } catch {
      return false;
    }
  }
}
