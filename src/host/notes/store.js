import { randomUUID } from 'node:crypto';
import { noteSchema, noteVersionSchema, noteActionSchema as actionSchema, editableShape, noteTimeSchema as isoSchema } from './schema.js';
export { noteSchema, noteVersionSchema } from './schema.js';

import { defaultCategoryTree } from '../categories/schema.js';
const clone = value => structuredClone(value);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const noteOrder = (a, b) => Number(b.pinned) - Number(a.pinned) ||
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || compareText(a.id, b.id);
const versionOrder = (a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) ||
  b.revision - a.revision || compareText(a.versionId, b.versionId);
function metadata(note) {
  const { content, ...rest } = note;
  return { ...rest, excerpt: content.slice(0, 160), contentLength: content.length };
}
function versionMetadata(version) {
  return { versionId: version.versionId, noteId: version.noteId, title: version.title,
    revision: version.revision, savedAt: version.savedAt,
    contentLength: version.content.length, excerpt: version.content.slice(0, 160) };
}
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
async function tableValues(table, schema) {
  const values = [];
  for await (const [, value] of await table.entries()) values.push(schema.parse(clone(value)));
  return values;
}

/** Pure storage adapter. Supply separate notes and versions tables, never todo tables.
 * get/entries may be synchronous or asynchronous; put/delete are awaited.
 * The queue protects concurrency within this instance (not across processes).
 */
export class NotesStore {
  constructor(notesTable, versionsTable, clock = () => new Date().toISOString(), options = {}) {
    this.categories = options.categories;
    this.notesTable = notesTable;
    this.versionsTable = versionsTable;
    this.clock = clock;
    this.queue = Promise.resolve();
  }

  execute(input) {
    let request;
    try { request = clone(input); } catch (error) { return Promise.reject(error); }
    // Reserve the category read now, so prior category writes finish first and
    // later category writes cannot overtake this request. Categories never wait
    // on the notes queue, avoiding a cross-store queue dependency cycle.
    const tree = this.categories ? this.categories.snapshot() : Promise.resolve(defaultCategoryTree());
    tree.catch(() => {});
    const work = this.queue.then(async () => this.perform(actionSchema.parse(request), await tree)).then(clone);
    this.queue = work.catch(() => {});
    return work;
  }

  /** Internal retrieval snapshot, admitted to the same queue as execute().
   * Earlier writes finish before enumeration; later writes wait until every
   * record has been validated and detached. This boundary is per store instance,
   * just like execute(), and does not coordinate external table writers.
   */
  searchSnapshot() {
    const work = this.queue.then(() => tableValues(this.notesTable, noteSchema));
    this.queue = work.catch(() => {});
    return work;
  }

  now() { return isoSchema.parse(this.clock()); }

  async note(id, revision) {
    const value = await this.notesTable.get(id);
    if (value === undefined || value === null) throw failure('NOT_FOUND', 'Note not found');
    const note = noteSchema.parse(clone(value));
    if (revision !== undefined && revision !== note.revision) {
      throw failure('CONFLICT', 'Note changed elsewhere. Refresh and retry.');
    }
    return note;
  }

  async save(note) {
    const validated = noteSchema.parse(note);
    await this.notesTable.put(validated.id, clone(validated));
    return { ok: true, note: metadata(validated) };
  }

  async history(id) {
    return (await tableValues(this.versionsTable, noteVersionSchema))
      .filter(version => version.noteId === id).sort(versionOrder);
  }

  async snapshot(note, force, savedAt) {
    const versionId = `${note.id}:${note.revision}`;
    const existing = await this.versionsTable.get(versionId);
    if (existing !== undefined && existing !== null) return noteVersionSchema.parse(clone(existing));
    const history = await this.history(note.id);
    if (!force && history.length && Date.parse(savedAt) - Date.parse(history[0].savedAt) < 300000) {
      return null;
    }
    const version = noteVersionSchema.parse({ ...clone(note), versionId, noteId: note.id, savedAt });
    // A history failure must never overwrite the current note. Persist and prune
    // before the caller can commit its note mutation; no cross-table transaction is assumed.
    await this.versionsTable.put(versionId, clone(version));
    const retained = [...history, version].sort((a, b) => b.revision - a.revision);
    for (const old of retained.slice(50)) await this.versionsTable.delete(old.versionId);
    return version;
  }

  async savedVersion(id, versionId) {
    const value = await this.versionsTable.get(versionId);
    if (value === undefined || value === null) throw failure('NOT_FOUND', 'Version not found');
    const version = noteVersionSchema.parse(clone(value));
    if (version.noteId !== id) throw failure('NOT_FOUND', 'Version not found');
    return version;
  }

  async perform(input, tree) {
    const { action } = input;
    const byId = new Map(tree.items.map(item => [item.id, item]));
    const requireCategory = id => {
      if (!byId.has(id)) throw failure('NOT_FOUND', 'Category not found');
    };
    const lineage = id => {
      const result = [];
      let item = byId.get(id);
      while (item) { result.push(item.id); item = byId.get(item.parentId); }
      return result;
    };
    if ((action === 'create' || action === 'update') && input.category !== undefined) requireCategory(input.category);
    if (action === 'list') {
      const all = await tableValues(this.notesTable, noteSchema);
      const counts = { all: 0, document: 0, reading: 0, code: 0, journal: 0, trash: 0 };
      for (const item of tree.items) counts[item.id] = 0;
      for (const note of all) {
        if (note.trashedAt) counts.trash++;
        else {
          counts.all++;
          // Unknown UUIDs in imported/history records remain readable.
          // There is no category deletion, so normal writes always have a lineage.
          for (const id of lineage(note.category)) counts[id]++;
        }
      }
      const query = input.query?.toLowerCase();
      const matching = all.filter(note => Boolean(note.trashedAt) === input.trashed &&
        (!input.category || (input.includeDescendants ? lineage(note.category).includes(input.category) ||
          note.category === input.category : note.category === input.category)) &&
        (!input.tag || note.tags.includes(input.tag)) && (!input.pinnedOnly || note.pinned) &&
        (!query || [note.title, note.content, ...note.tags].some(value => value.toLowerCase().includes(query))))
        .sort(noteOrder);
      return { ok: true, notes: matching.slice(input.offset, input.offset + input.limit).map(metadata),
        total: matching.length, offset: input.offset, limit: input.limit, counts };
    }
    if (action === 'create' || action === 'journal') {
      if (action === 'journal') {
        const existing = (await tableValues(this.notesTable, noteSchema)).filter(note =>
          !note.trashedAt && note.category === 'journal' && note.journalDate === input.date).sort(noteOrder)[0];
        if (existing) return { ok: true, note: metadata(existing) };
      }
      const now = this.now();
      const fields = action === 'journal'
        ? { title: input.date, content: `# ${input.date}\n\n`, category: 'journal', journalDate: input.date }
        : Object.fromEntries(Object.keys(editableShape).filter(key => input[key] !== undefined).map(key => [key, input[key]]));
      return this.save(noteSchema.parse({ ...fields, id: randomUUID(), createdAt: now, updatedAt: now, revision: 1 }));
    }
    const note = await this.note(input.id, input.revision);
    if (action === 'get') return { ok: true, note };
    if (action === 'versions') {
      const history = await this.history(note.id);
      return { ok: true, versions: history.slice(input.offset, input.offset + input.limit).map(versionMetadata),
        total: history.length, offset: input.offset, limit: input.limit };
    }
    if (action === 'version') return { ok: true, version: await this.savedVersion(note.id, input.versionId) };
    if (action === 'checkpoint') {
      return { ok: true, version: versionMetadata(await this.snapshot(note, true, this.now())) };
    }
    if ((action === 'update' || action === 'restore_version') && note.trashedAt) {
      throw failure('TRASHED', 'Restore this note from trash before editing it');
    }
    if (action === 'update') {
      const edits = Object.fromEntries(Object.keys(editableShape)
        .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
      const changed = Object.keys(edits).some(key => JSON.stringify(note[key]) !== JSON.stringify(edits[key]));
      if (!changed) return { ok: true, note: metadata(note) };
      const now = this.now();
      // Validate the complete candidate before writing history (including revision overflow).
      const next = noteSchema.parse({ ...note, ...edits, updatedAt: now, revision: note.revision + 1 });
      if (next.title !== note.title || next.content !== note.content) await this.snapshot(note, false, now);
      return this.save(next);
    }
    if (action === 'restore_version') {
      const version = await this.savedVersion(note.id, input.versionId);
      const now = this.now();
      const next = noteSchema.parse({ ...note, title: version.title, content: version.content,
        updatedAt: now, revision: note.revision + 1 });
      await this.snapshot(note, true, now);
      return this.save(next);
    }
    if (action === 'trash' || action === 'restore') {
      if (Boolean(note.trashedAt) === (action === 'trash')) return { ok: true, note: metadata(note) };
      const now = this.now();
      const next = noteSchema.parse({ ...note, trashedAt: action === 'trash' ? now : '',
        updatedAt: now, revision: note.revision + 1 });
      if (action === 'trash') await this.snapshot(note, true, now);
      return this.save(next);
    }
    throw new Error('Unknown action');
  }
}
