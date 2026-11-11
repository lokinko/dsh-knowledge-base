import { randomUUID } from 'node:crypto';
import { topicSchema, topicActionSchema as actions, topicIdSchema as uuidSchema, topicSessionSchema as sessionSchema, topicTimeSchema as isoSchema } from './schema.js';
import { referenceKey, uniqueReferences } from './references.js';
export { topicSchema } from './schema.js';
export { referenceSchema, referenceKey } from './references.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);

function binding(topic) {
  return topic.sessionId ? { topicId: topic.id, sessionId: topic.sessionId,
    createdAt: topic.createdAt, updatedAt: topic.updatedAt } : null;
}
function metadata(topic) {
  const { references, ...rest } = topic;
  return { ...rest, referenceCount: references.length };
}

/** User-created questions share one queue. Table mutations also carry libraryId
 * so the storage queue can reject a route change at the actual write boundary.
 * Failed session persistence keeps a candidate for retries within this instance.
 */
export class TopicStore {
  constructor({ table, getLibraryId, sessions, validateReference, clock = () => new Date().toISOString(), uuid = randomUUID }) {
    if (!table || typeof getLibraryId !== 'function') throw new TypeError('Topic table and getLibraryId are required');
    this.table = table;
    this.getLibraryId = getLibraryId;
    this.sessions = sessions;
    this.validateReference = validateReference;
    this.clock = clock;
    this.uuid = uuid;
    this.queue = Promise.resolve();
    this.pending = new Map();
    this.closed = false;
  }
  setSessions(sessions) { this.sessions = sessions; }
  execute(input) {
    if (this.closed) return Promise.reject(fail('CLOSED', 'Topic workspace is closed'));
    let request, libraryId;
    try {
      request = actions.parse(clone(input));
      libraryId = uuidSchema.parse(this.getLibraryId());
    } catch (error) { return Promise.reject(error); }
    const work = this.queue.then(async () => {
      this.assertLibrary(libraryId);
      if (request.libraryId !== undefined && request.libraryId !== libraryId) {
        throw fail('CONFLICT', 'Notebook library changed. Reload the topic workspace.');
      }
      return this.perform(request, libraryId);
    }).then(value => { this.assertLibrary(libraryId); return clone(value); });
    this.queue = work.catch(() => {});
    return work;
  }
  close() { this.closed = true; return this.queue; }
  assertLibrary(libraryId) {
    const current = uuidSchema.parse(this.getLibraryId());
    for (const [id, candidate] of this.pending) if (candidate.libraryId !== current) this.pending.delete(id);
    if (current !== libraryId) throw fail('CONFLICT', 'Notebook library changed. Reload the topic workspace.');
  }
  async checked(operation, libraryId) {
    try { return await operation; }
    finally { this.assertLibrary(libraryId); }
  }
  async read(id, libraryId, revision) {
    const value = await this.checked(this.table.get(id), libraryId);
    this.assertLibrary(libraryId);
    if (value == null) {
      this.pending.delete(id);
      throw fail('NOT_FOUND', 'Topic not found');
    }
    const topic = topicSchema.parse(clone(value));
    if (topic.id !== id) throw fail('INVALID_RECORD', 'Topic key does not match its identity');
    if (revision !== undefined && topic.revision !== revision) throw fail('CONFLICT', 'Topic changed. Reload and retry.');
    return topic;
  }
  async validateNewReferences(references, previous, libraryId) {
    const old = new Set(previous.map(referenceKey));
    for (const reference of references) {
      if (old.has(referenceKey(reference)) || !this.validateReference) continue;
      const valid = await this.checked(this.validateReference(clone(reference), { libraryId }), libraryId);
      this.assertLibrary(libraryId);
      if (valid === false) throw fail('INVALID_REFERENCE', 'The selected reference is unavailable');
    }
  }
  result(topic, libraryId) { return { ok: true, libraryId, topic, binding: binding(topic) }; }
  async save(topic, libraryId) {
    this.assertLibrary(libraryId);
    await this.checked(this.table.put(topic.id, clone(topic), { libraryId }), libraryId);
    this.assertLibrary(libraryId);
    return this.result(topic, libraryId);
  }
  async perform(input, libraryId) {
    if (input.action === 'list') {
      const topics = [];
      const entries = await this.checked(this.table.entries(), libraryId);
      this.assertLibrary(libraryId);
      try {
        for await (const [key, value] of entries) {
          this.assertLibrary(libraryId);
          const topic = topicSchema.parse(clone(value));
          if (key !== topic.id) throw fail('INVALID_RECORD', 'Topic key does not match its identity');
          topics.push(topic);
        }
      } finally { this.assertLibrary(libraryId); }
      topics.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
      return { ok: true, libraryId, topics: topics.map(metadata), total: topics.length };
    }
    if (input.action === 'create') {
      const references = uniqueReferences(input.references);
      await this.validateNewReferences(references, [], libraryId);
      this.assertLibrary(libraryId);
      const id = uuidSchema.parse(this.uuid());
      const existing = await this.checked(this.table.get(id), libraryId);
      this.assertLibrary(libraryId);
      if (existing != null) throw fail('CONFLICT', 'Topic identity already exists');
      const now = isoSchema.parse(this.clock());
      return this.save(topicSchema.parse({ id, question: input.question, references,
        revision: 1, createdAt: now, updatedAt: now }), libraryId);
    }
    const topic = await this.read(input.id, libraryId, input.revision);
    this.assertLibrary(libraryId);
    if (input.action === 'get') return this.result(topic, libraryId);
    if (input.action === 'delete') {
      this.assertLibrary(libraryId);
      await this.checked(this.table.delete(topic.id, { libraryId }), libraryId);
      this.assertLibrary(libraryId);
      this.pending.delete(topic.id);
      return { ok: true, libraryId, id: topic.id, deleted: true };
    }
    if (input.action === 'update') {
      const references = input.references === undefined ? topic.references : uniqueReferences(input.references);
      await this.validateNewReferences(references, topic.references, libraryId);
      this.assertLibrary(libraryId);
      await this.read(topic.id, libraryId, topic.revision);
      this.assertLibrary(libraryId);
      const fields = { question: input.question ?? topic.question, references };
      if (fields.question === topic.question && JSON.stringify(references) === JSON.stringify(topic.references)) return this.result(topic, libraryId);
      return this.save(topicSchema.parse({ ...topic, ...fields,
        revision: topic.revision + 1, updatedAt: this.clock() }), libraryId);
    }
    return this.start(topic, libraryId);
  }
  async start(topic, libraryId) {
    if (topic.sessionId) { this.pending.delete(topic.id); return this.result(topic, libraryId); }
    if (topic.revision === Number.MAX_SAFE_INTEGER) throw fail('CONFLICT', 'Topic revision is exhausted');
    let candidate = this.pending.get(topic.id);
    if (!candidate) {
      const sessions = typeof this.sessions === 'function' ? this.sessions() : this.sessions;
      if (typeof sessions?.create !== 'function') throw fail('UNAVAILABLE', 'Native conversations are unavailable');
      let created;
      try { created = await this.checked(sessions.create({}), libraryId); this.assertLibrary(libraryId); }
      catch (error) {
        if (error.code === 'CONFLICT') throw error;
        throw fail('SESSION_CREATE_FAILED', 'Could not create a native conversation');
      }
      const parsed = sessionSchema.safeParse(created?.sessionId);
      if (!parsed.success) throw fail('SESSION_CREATE_FAILED', 'Native conversation returned an invalid identity');
      candidate = { libraryId, sessionId: parsed.data };
      this.pending.set(topic.id, candidate);
    }
    // A topic may be removed or changed by another consumer while session
    // creation is awaiting. Recheck existence and revision before persistence.
    const current = await this.read(topic.id, libraryId, topic.revision);
    this.assertLibrary(libraryId);
    if (current.sessionId) { this.pending.delete(topic.id); return this.result(current, libraryId); }
    const next = topicSchema.parse({ ...current, sessionId: candidate.sessionId,
      revision: current.revision + 1, updatedAt: this.clock() });
    const result = await this.save(next, libraryId);
    this.assertLibrary(libraryId);
    this.pending.delete(topic.id);
    return result;
  }
}
