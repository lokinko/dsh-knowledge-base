import {normalizeNoteFields as fieldsOf,validateDraftIdentity as identity,noteDraftKey as keyOf,cloneDraftRecord as cloneRecord,noteFieldsEqual as sameFields} from './draft-record.js';

// Keep the original import path compatible with existing consumers.
export {NoteDraftCache} from './legacy-draft-cache.js';
export {normalizeNoteFields,validateDraftIdentity,noteDraftKey,decodeLegacyDraft,cloneDraftRecord} from './draft-record.js';

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
    this._cachePending = false;
    this._cacheGeneration = null;
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
      this._cachePending = !!draft.pending;
      if (draft.writerId === this._writerId) this._cacheGeneration = { raw: draft.raw, generation: this._generation };
      this._status = this._cacheDurable || this._cachePending ? 'pending' : 'cache-error';
      if (draft.baseRevision !== note.revision) {
        this._conflict = { baseRevision: draft.baseRevision, serverRevision: note.revision,
          message: 'The recovered draft is based on an older server revision' };
        this._status = 'conflict';
      }
    }
    // A paused editor must not be retained by the application-wide cache.
    this._detachCache = null;
    if (!paused) this.start();
  }

  _receiveCache(record) {
    const captured = this._cacheGeneration;
    if (this._paused || this._stopped || this._abandoned || !captured || this._generation === this._savedGeneration ||
        captured.generation !== this._generation || record?.raw !== captured.raw ||
        record.noteId !== this._noteId || record.writerId !== this._writerId ||
        this._records.get(record.key)?.raw !== record.raw) return;
    const held = this._records.get(record.key);
    if (this._cacheDurable === !record.volatile && this._cachePending === !!record.pending && held.error === record.error) return;
    this._records.set(record.key, cloneRecord(record));
    this._cacheDurable = !record.volatile;
    this._cachePending = !!record.pending;
    // A local commit may improve durability while preserving a remote conflict
    // or offline request error. It must never acknowledge server-side saving.
    if (!this._conflict && !['offline', 'saving'].includes(this._status)) {
      this._status = this._cacheDurable || this._cachePending ? 'pending' : 'cache-error';
      this._error = this._cacheDurable || this._cachePending ? null : { message: record.error || 'Draft persistence failed; the draft remains in memory' };
    }
    this._notify();
  }

  get noteId() { return this._noteId; }

  /** Activate deferred autosave after the editor has mounted. */
  start() {
    if (this._stopped || this._abandoned) return this.snapshot();
    this._paused = false;
    this._pausePromise = null;
    const attach = !this._detachCache && typeof this._cache.subscribe === 'function';
    if (attach) this._detachCache = this._cache.subscribe(record => this._receiveCache(record));
    // A recovered source belongs to another session. Secure our own copy before
    // scheduling, even for conflicts, so its owner cannot discard our only draft.
    const needsOwnedCopy = this._generation !== this._savedGeneration &&
      ![...this._records.values()].some(record => record.writerId === this._writerId);
    if (needsOwnedCopy) {
      this._persist();
      if (!this._conflict && !this._inFlight) this._status = this._cacheDurable || this._cachePending ? 'pending' : 'cache-error';
    }
    // A transaction can finish while the editor is paused and unsubscribed.
    // Read only on reattachment, and accept only the exact owned generation.
    if (attach && this._cacheGeneration) {
      try {
        const current = this._cache.records().find(record => record.key === keyOf(this._noteId, this._writerId));
        if (current) this._receiveCache(current);
      } catch { /* Preserve truthful pending/failed state when recovery is unavailable. */ }
    }
    // Repeated effect setup must not extend an existing debounce deadline.
    if (this._timer === null) this._schedule();
    if (needsOwnedCopy) this._notify();
    return this.snapshot();
  }

  snapshot() {
    return { fields: fieldsOf(this._fields), baseRevision: this._baseRevision,
      status: this._status, dirty: this._generation !== this._savedGeneration,
      cacheDurable: this._cacheDurable, cachePending: this._cachePending, error: this._error ? { ...this._error } : null,
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
    this._cachePending = !!record.pending;
    this._cacheGeneration = { raw: record.raw, generation: this._generation };
    if (!this._cacheDurable && !this._cachePending) this._error = { message: record.error || 'Draft is held in memory; local storage write failed' };
  }

  change(patch) {
    if (this._stopped) throw new Error('This edit session has stopped');
    const next = fieldsOf({ ...this._fields, ...patch });
    if (sameFields(next, this._fields)) return this.snapshot();
    this._fields = next;
    this._generation += 1;
    this._error = null;
    // The cache accepts the exact text before subscribers run. Async caches
    // expose pending durability until their transaction commits.
    this._persist();
    if (!this._conflict) this._status = this._cacheDurable || this._cachePending ? 'pending' : 'cache-error';
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
    this._cachePending = false;
    this._cacheGeneration = null;
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
          this._status = this._cacheDurable || this._cachePending ? 'pending' : 'cache-error';
        } else {
          this._cacheDurable = true;
          this._cachePending = false;
          this._cacheGeneration = null;
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
   * Temporarily detach autosave and the global cache listener without retiring
   * the session. The caller owns UI subscriptions; start() reattaches the cache
   * listener and reconciles missed durability after effect setup runs again.
   * Repeated cleanup shares one drain and never loops on a failed save.
   */
  pause() {
    if (this._stopped || this._abandoned) return Promise.resolve(false);
    this._paused = true;
    this._detachCache?.();
    this._detachCache = null;
    this._cancelTimer();
    this._pausePromise ??= this.flush();
    return this._pausePromise;
  }

  /** Unmount: detach subscribers, cancel debounce, and drain accepted edits once. */
  stop() {
    this._stopped = true;
    this._detachCache?.();
    this._detachCache = null;
    this._listeners.clear();
    this._cancelTimer();
    return this.flush();
  }

  /** Explicitly discard only this session's captured drafts after copy/reload. */
  abandon() {
    this._abandoned = true;
    this._detachCache?.();
    this._detachCache = null;
    this._stopped = true;
    this._listeners.clear();
    this._cancelTimer();
    let removed = true;
    for (const record of this._records.values()) removed = this._cache.remove(record) && removed;
    this._records.clear();
    return removed;
  }
}
