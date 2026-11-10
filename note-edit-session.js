// Pure draft persistence and edit coordination. No storage or browser globals are
// accessed until a cache method or a session constructor is called.
const PREFIX = 'dsh.todo-manager.note-draft.v1:';
const CATEGORIES = new Set(['document', 'reading', 'code', 'journal']);
const FIELD_NAMES = ['title', 'content', 'category', 'tags', 'pinned', 'journalDate'];

function validDate(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function fieldsOf(input, defaults = false) {
  if (!input || typeof input !== 'object') throw new TypeError('Note fields are required');
  const fields = Object.fromEntries(FIELD_NAMES.map(name => [name, input[name]]));
  if (defaults) {
    fields.title ??= '';
    fields.content ??= '';
    fields.category ??= 'document';
    fields.tags ??= [];
    fields.pinned ??= false;
    fields.journalDate ??= '';
  }
  if (typeof fields.content !== 'string' ||
      typeof fields.title !== 'string' || fields.title.length > 200 ||
      !CATEGORIES.has(fields.category) || !Array.isArray(fields.tags) ||
      fields.tags.length > 20 || fields.tags.some(tag => typeof tag !== 'string' || tag.length < 1 || tag.length > 40) ||
      new Set(fields.tags).size !== fields.tags.length ||
      typeof fields.pinned !== 'boolean' || !validDate(fields.journalDate)) {
    throw new TypeError('Invalid note fields');
  }
  return { ...fields, tags: [...fields.tags] };
}

function sameFields(a, b) {
  return a.title === b.title && a.content === b.content && a.category === b.category &&
    a.pinned === b.pinned && a.journalDate === b.journalDate &&
    a.tags.length === b.tags.length && a.tags.every((tag, index) => tag === b.tags[index]);
}

function identity(noteId, writerId, revision) {
  if (typeof noteId !== 'string' || !noteId || typeof writerId !== 'string' || !writerId ||
      !Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid draft identity or revision');
}

function keyOf(noteId, writerId) {
  return `${PREFIX}${encodeURIComponent(noteId)}:${encodeURIComponent(writerId)}`;
}

function cloneRecord(record) {
  return record ? { ...record, fields: fieldsOf(record.fields) } : null;
}

function decode(key, raw) {
  try {
    const value = JSON.parse(raw);
    if (value.version !== 1) return null;
    identity(value.noteId, value.writerId, value.baseRevision);
    if (key !== keyOf(value.noteId, value.writerId) || typeof value.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.updatedAt))) return null;
    return { version: 1, noteId: value.noteId, writerId: value.writerId,
      baseRevision: value.baseRevision, fields: fieldsOf(value.fields),
      updatedAt: value.updatedAt, key, raw, volatile: false };
  } catch {
    return null;
  }
}

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

function errorInfo(error) {
  return { message: error?.message || String(error), ...(error?.code ? { code: error.code } : {}) };
}

/** Serializes revision-checked saves while keeping the latest raw text local. */
export class NoteEditSession {
  constructor({ note, draft, cache, save, delay = 900, paused = false,
    writerId = globalThis.crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    identity(note?.id, writerId, note?.revision);
    if (!cache || typeof save !== 'function') throw new TypeError('Cache and save are required');
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError('Invalid debounce delay');
    this._noteId = note.id;
    this._writerId = writerId;
    this._cache = cache;
    this._save = save;
    this._delay = delay;
    // Host timer functions can require their global receiver. Calling a stored
    // raw function as a session method instead supplies this NoteEditSession.
    this._setTimer = (...args) => Reflect.apply(setTimer, globalThis, args);
    this._clearTimer = (...args) => Reflect.apply(clearTimer, globalThis, args);
    this._timer = null;
    this._listeners = new Set();
    this._records = new Map();
    this._inFlight = null;
    this._pausePromise = null;
    this._paused = paused;
    this._stopped = false;
    this._abandoned = false;
    this._generation = 0;
    this._savedGeneration = 0;
    this._fields = fieldsOf(note, true);
    this._baseRevision = note.revision;
    this._updatedAt = note.updatedAt ?? null;
    this._status = 'saved';
    this._cacheDurable = true;
    this._error = null;
    this._conflict = null;
    if (draft) {
      if (draft.noteId !== note.id) throw new TypeError('Draft belongs to another note');
      identity(draft.noteId, draft.writerId, draft.baseRevision);
      this._fields = fieldsOf(draft.fields);
      this._baseRevision = draft.baseRevision;
      this._generation = 1;
      this._records.set(draft.key, cloneRecord(draft));
      this._cacheDurable = !draft.volatile;
      this._status = this._cacheDurable ? 'pending' : 'cache-error';
      if (draft.baseRevision !== note.revision) {
        this._conflict = { baseRevision: draft.baseRevision, serverRevision: note.revision,
          message: 'The recovered draft is based on an older server revision' };
        this._status = 'conflict';
      }
    }
    if (!paused) this.start();
  }

  get noteId() { return this._noteId; }

  /** Activate deferred autosave after the editor has mounted. */
  start() {
    if (this._stopped || this._abandoned) return this.snapshot();
    this._paused = false;
    this._pausePromise = null;
    // A recovered source belongs to another session. Secure our own copy before
    // scheduling, even for conflicts, so its owner cannot discard our only draft.
    const needsOwnedCopy = this._generation !== this._savedGeneration &&
      ![...this._records.values()].some(record => record.writerId === this._writerId);
    if (needsOwnedCopy) {
      this._persist();
      if (!this._conflict && !this._inFlight) this._status = this._cacheDurable ? 'pending' : 'cache-error';
    }
    // Repeated effect setup must not extend an existing debounce deadline.
    if (this._timer === null) this._schedule();
    if (needsOwnedCopy) this._notify();
    return this.snapshot();
  }

  snapshot() {
    return { fields: fieldsOf(this._fields), baseRevision: this._baseRevision,
      status: this._status, dirty: this._generation !== this._savedGeneration,
      cacheDurable: this._cacheDurable, error: this._error ? { ...this._error } : null,
      updatedAt: this._updatedAt, conflict: this._conflict ? { ...this._conflict } : null };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
    if (!this._stopped) this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    for (const listener of [...this._listeners]) listener(this.snapshot());
  }

  _cancelTimer() {
    if (this._timer !== null) this._clearTimer(this._timer);
    this._timer = null;
  }

  _schedule() {
    this._cancelTimer();
    if (this._paused || this._stopped || this._abandoned || this._conflict || this._inFlight || !this.snapshot().dirty) return;
    this._timer = this._setTimer(() => {
      this._timer = null;
      void this.flush();
    }, this._delay);
  }

  _persist() {
    const record = this._cache.write({ noteId: this._noteId, writerId: this._writerId,
      baseRevision: this._baseRevision, fields: this._fields });
    this._records.set(record.key, record);
    this._cacheDurable = !record.volatile;
    if (!this._cacheDurable) this._error = { message: 'Draft is held in memory; local storage write failed' };
  }

  change(patch) {
    if (this._stopped) throw new Error('This edit session has stopped');
    const next = fieldsOf({ ...this._fields, ...patch });
    if (sameFields(next, this._fields)) return this.snapshot();
    this._fields = next;
    this._generation += 1;
    this._error = null;
    // This synchronous write happens before any subscriber sees the new text.
    this._persist();
    if (!this._conflict) this._status = this._cacheDurable ? 'pending' : 'cache-error';
    this._schedule();
    this._notify();
    return this.snapshot();
  }

  /**
   * Apply a newer full server note without replacing the session. Matching local
   * edits can be acknowledged only outside an active save; while a save is in
   * flight we conservatively retain the draft and expose a conflict instead.
   * Returns false for ignored/conflicting/trashed notes; invalid input throws.
   */
  receiveRemote(note) {
    identity(note?.id, this._writerId, note?.revision);
    if (note.id !== this._noteId) throw new TypeError('Remote note belongs to another session');
    const fields = fieldsOf(note);
    if (note.updatedAt != null && (typeof note.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(note.updatedAt)))) throw new TypeError('Invalid note updatedAt');
    if (this._stopped || this._abandoned || note.trashed === true || Boolean(note.trashedAt)) return false;
    const knownConflictRevision = this._conflict?.serverRevision;
    if (note.revision <= this._baseRevision ||
        (Number.isSafeInteger(knownConflictRevision) && note.revision < knownConflictRevision)) return false;
    const dirty = this._generation !== this._savedGeneration;
    if (dirty && (this._inFlight || !sameFields(fields, this._fields))) {
      this._cancelTimer();
      const message = 'The note changed remotely while local edits are unsaved';
      this._conflict = { baseRevision: this._baseRevision, serverRevision: note.revision, message };
      this._error = { code: 'CONFLICT', message };
      this._status = 'conflict';
      this._notify();
      return false;
    }
    this._cancelTimer();
    this._fields = fields;
    this._baseRevision = note.revision;
    this._updatedAt = note.updatedAt ?? this._updatedAt;
    this._savedGeneration = this._generation;
    this._status = 'saved';
    this._cacheDurable = true;
    this._error = null;
    this._conflict = null;
    // Remote equality acknowledges only the exact snapshots held by this
    // session; a source tab's newer raw record must remain recoverable.
    for (const record of this._records.values()) this._cache.remove(record);
    this._records.clear();
    this._notify();
    return true;
  }

  flush() {
    this._cancelTimer();
    if (this._inFlight) return this._inFlight;
    if (this._conflict || this._abandoned) return Promise.resolve(false);
    if (!this.snapshot().dirty) return Promise.resolve(true);
    // Install the shared promise before running save or notifying subscribers,
    // including when save itself throws synchronously or listeners call flush.
    const work = Promise.resolve().then(() => this._drain());
    this._inFlight = work.finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  async _drain() {
    while (!this._abandoned && !this._conflict && this._generation !== this._savedGeneration) {
      const generation = this._generation;
      const submittedRecords = [...this._records.values()];
      const payload = { action: 'update', id: this._noteId, revision: this._baseRevision,
        ...fieldsOf(this._fields) };
      this._status = 'saving';
      this._notify();
      if (this._abandoned || this._conflict) return false;
      try {
        const result = await this._save(payload);
        if (!result?.ok || !result.note || !Number.isSafeInteger(result.note.revision) ||
            result.note.revision < payload.revision ||
            (result.note.id !== undefined && result.note.id !== this._noteId)) {
          throw new Error('Save returned invalid note metadata');
        }
        if (this._abandoned || this._conflict) return false;
        this._baseRevision = result.note.revision;
        this._updatedAt = result.note.updatedAt ?? this._updatedAt;
        this._savedGeneration = generation;
        this._error = null;
        for (const record of submittedRecords) {
          this._cache.remove(record);
          if (this._records.get(record.key)?.raw === record.raw) this._records.delete(record.key);
        }
        if (this._generation !== generation) {
          // Rebase the newest draft only after the preceding write succeeds.
          this._persist();
          this._status = this._cacheDurable ? 'pending' : 'cache-error';
        } else {
          this._cacheDurable = true;
          this._status = 'saved';
        }
        this._notify();
      } catch (error) {
        if (this._abandoned || this._conflict) return false;
        this._error = errorInfo(error);
        if (error?.code === 'CONFLICT') {
          this._conflict = { baseRevision: this._baseRevision,
            serverRevision: error.note?.revision ?? error.revision ?? null,
            message: this._error.message };
          this._status = 'conflict';
        } else {
          this._status = 'offline';
        }
        this._notify();
        return false;
      }
    }
    return !this._abandoned && !this._conflict;
  }

  /**
   * Temporarily detach autosave without retiring the session. The caller owns
   * subscriptions; start() can resume this instance after effect setup runs again.
   * Repeated cleanup shares one drain and never loops on a failed save.
   */
  pause() {
    if (this._stopped || this._abandoned) return Promise.resolve(false);
    this._paused = true;
    this._cancelTimer();
    this._pausePromise ??= this.flush();
    return this._pausePromise;
  }

  /** Unmount: detach subscribers, cancel debounce, and drain accepted edits once. */
  stop() {
    this._stopped = true;
    this._listeners.clear();
    this._cancelTimer();
    return this.flush();
  }

  /** Explicitly discard only this session's captured drafts after copy/reload. */
  abandon() {
    this._abandoned = true;
    this._stopped = true;
    this._listeners.clear();
    this._cancelTimer();
    let removed = true;
    for (const record of this._records.values()) removed = this._cache.remove(record) && removed;
    this._records.clear();
    return removed;
  }
}
