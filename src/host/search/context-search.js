import { createHash } from 'node:crypto';

const SOURCES = ['note'];
const fail = (code, message) => Object.assign(new Error(message), { code });
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
const fold = text => String(text).normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
const integer = (value, fallback, max, name, min = 1) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('INVALID_INPUT', `${name} must be ${min}–${max}`);
  return value;
};
function tokens(text) {
  const found = [];
  for (const match of fold(text).matchAll(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu)) {
    const word = match[0];
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) found.push(word);
      else for (let i = 0; i < chars.length - 1; i++) found.push(chars[i] + chars[i + 1]);
    } else found.push(word);
  }
  return [...new Set(found)];
}
function safeEnd(text, start, end) {
  if (end < text.length && end - start > 1 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1;
  return end;
}

/** Contiguous UTF-16 offsets. Retains one descriptor per chunk, never per line.
 * ATX headings and paragraphs guide boundaries; fenced code suppresses headings.
 */
function chunks(text) {
  if (!text.length) return [{ start: 0, end: 0, heading: '' }];
  const result = [];
  let start = 0, heading = '', chunkHeading = '', fence = null;
  const emit = end => {
    while (end - start > 3000) {
      const cut = safeEnd(text, start, start + 2400);
      result.push({ start, end: cut, heading: chunkHeading });
      start = cut;
    }
    if (end > start) { result.push({ start, end, heading: chunkHeading }); start = end; }
    chunkHeading = heading;
  };
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const offset = match.index, end = offset + line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    const title = !fence && /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n)?$/.exec(line);
    if (title) {
      emit(offset);
      heading = title[1].trim().slice(0, 300);
      chunkHeading = heading;
    }
    if (marker) {
      if (!fence && !(marker[1][0] === '`' && marker[2].includes('`'))) fence = marker[1];
      else if (fence && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
    // Huge lines/code are split immediately; small lines are streamed without allocation per line.
    while (end - start > 3000) {
      const cut = safeEnd(text, start, start + 2400);
      result.push({ start, end: cut, heading: chunkHeading }); start = cut;
    }
    if (!fence && !line.trim() && end - start >= 1800) emit(end);
  }
  emit(text.length);
  return result;
}
const encode = ref => `ctx1:${encodeURIComponent(JSON.stringify(ref))}`;
function decode(atomId) {
  if (typeof atomId !== 'string' || !atomId.startsWith('ctx1:') || atomId.length > 4000) throw fail('INVALID_INPUT', 'Invalid atomId');
  try { return JSON.parse(decodeURIComponent(atomId.slice(5))); } catch { throw fail('INVALID_INPUT', 'Invalid atomId'); }
}
function metadata(record) {
  return { title: record.title || '', category: record.category || 'document', tags: [...(record.tags || [])],
    completed: false, ...(record.trashedAt ? { trashedAt: record.trashedAt } : {}) };
}
function makeAtoms(record, source, field, text) {
  const fingerprint = hash(text);
  const bounds = chunks(text);
  return bounds.map(bound => {
    const ref = { source, id: record.id, field,
      revision: record.revision, updatedAt: record.updatedAt, fingerprint, start: bound.start, end: bound.end };
    const meta = { ...metadata(record), heading: bound.heading };
    return { ref, atomId: encode(ref), ...meta, text, fields: [fold(meta.title), fold(meta.tags.join(' ')), fold(meta.heading), fold(text.slice(bound.start, bound.end))] };
  });
}
function visible(atom, input) {
  return (!input.source || input.source === atom.ref.source) && (!input.documentId || input.documentId === atom.ref.id) &&
    (input.includeTrashed === true || !atom.trashedAt);
}
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_INPUT', 'Expected an object');
  if (input.source !== undefined && !SOURCES.includes(input.source)) throw fail('INVALID_INPUT', 'Invalid source');
  if (input.documentId !== undefined && (typeof input.documentId !== 'string' || input.documentId.length > 200)) throw fail('INVALID_INPUT', 'Invalid documentId');
  for (const key of ['includeTrashed']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw fail('INVALID_INPUT', `Invalid ${key}`);
}

/** Derived, in-process retrieval view. The injected stores remain authoritative.
 * No storage domains, writes, embeddings, or automatic context injection.
 */
export class ContextSearch {
  constructor({ notes }) {
    if (!notes?.execute || !notes?.searchSnapshot) throw new TypeError('Supply a NotesStore instance with searchSnapshot()');
    this.notes = notes; this.cache = new Map(); this.queue = Promise.resolve();
  }
  execute(input) {
    const request = structuredClone(input);
    const work = this.queue.then(() => {
      validateInput(request);
      if (request.action === 'search') return this.search(request);
      if (request.action === 'read') return this.read(request);
      throw fail('INVALID_INPUT', 'Expected search or read action');
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async currentAtoms(input) {
    const atoms = [], seen = new Set();
    let records;
    if (input.documentId) {
      try { records = [(await this.notes.execute({ action: 'get', id: input.documentId })).note]; }
      catch (error) {
        // documentId is a free string filter in the search API. A value that
        // cannot be a NotesStore ID still means no match, as in a full scan.
        const invalidId = error?.name === 'ZodError' && error.issues?.length &&
          error.issues.every(issue => issue.path.length === 1 && issue.path[0] === 'id');
        if (error.code !== 'NOT_FOUND' && !invalidId) throw error;
        this.cache.delete(`note:${input.documentId}`);
        return [];
      }
    } else {
      // One queue admission captures active and trashed notes together. No
      // paginated list/get sequence can mix records across intervening writes.
      records = await this.notes.searchSnapshot();
    }
    for (const record of records) {
      const key = `note:${record.id}`;
      seen.add(key);
      const stamp = JSON.stringify([record.revision, record.updatedAt, hash(record.content),
        record.title, record.category, record.tags, record.trashedAt]);
      let entry = this.cache.get(key);
      if (entry?.stamp !== stamp) {
        entry = { stamp, atoms: makeAtoms(record, 'note', 'content', record.content) };
        this.cache.set(key, entry);
      }
      atoms.push(...entry.atoms);
    }
    // A targeted read says nothing about other cached documents. Only a full
    // snapshot can prove a cached record has disappeared.
    if (!input.documentId) {
      for (const key of this.cache.keys()) if (key.startsWith('note:') && !seen.has(key)) this.cache.delete(key);
    }
    return atoms.filter(atom => visible(atom, input));
  }
  async search(input) {
    validateInput(input);
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1000) throw fail('INVALID_INPUT', 'query needs 1–1000 characters');
    const limit = integer(input.limit, 12, 40, 'limit');
    const snippetLimit = integer(input.snippetLimit, 400, 600, 'snippetLimit');
    const terms = tokens(input.query), phrase = fold(input.query.trim());
    const atoms = await this.currentAtoms(input), frequencies = new Map(terms.map(term => [term, 0]));
    const candidates = [];
    for (const atom of atoms) {
      const counts = terms.map(term => atom.fields.map(field => {
        let count = 0, position = 0;
        while (count < 20 && (position = field.indexOf(term, position)) !== -1) { count++; position += term.length; }
        return count;
      }));
      counts.forEach((fields, i) => { if (fields.some(Boolean)) frequencies.set(terms[i], frequencies.get(terms[i]) + 1); });
      if (counts.some(fields => fields.some(Boolean)) || atom.fields.some(field => field.includes(phrase))) candidates.push({ atom, counts });
    }
    for (const candidate of candidates) {
      const { atom, counts } = candidate;
      let score = 0, matched = 0;
      counts.forEach((fields, i) => {
        if (!fields.some(Boolean)) return;
        matched++;
        const idf = Math.log(1 + (atoms.length - frequencies.get(terms[i]) + 0.5) / (frequencies.get(terms[i]) + 0.5));
        fields.forEach((tf, j) => { if (tf) score += [4, 5, 3, 1][j] * idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * Math.max(1, atom.fields[j].length) / (j === 3 ? 2400 : 100))); });
      });
      score *= terms.length ? 0.3 + 0.7 * matched / terms.length : 1;
      atom.fields.forEach((field, j) => { if (field.includes(phrase)) score += [4, 5, 3, 2][j]; });
      candidate.score = score;
    }
    candidates.sort((a, b) => b.score - a.score || a.atom.atomId.localeCompare(b.atom.atomId));
    const results = candidates.slice(0, limit).map(({ atom, score }) => {
      const { ref, atomId, title, category, tags, heading, completed, trashedAt } = atom;
      const body = atom.text.slice(ref.start, ref.end);
      // Search normalized text, but extract snippets from the original source offsets.
      let position = body.toLowerCase().indexOf(input.query.trim().toLowerCase());
      if (position < 0) position = Math.max(0, ...terms.map(term => body.toLowerCase().indexOf(term)).filter(pos => pos >= 0).slice(0, 1));
      const start = ref.start + Math.max(0, position - 80), end = safeEnd(atom.text, start, Math.min(ref.end, start + snippetLimit));
      return { atomId, ref: { ...ref }, title, category, tags: [...tags], heading, completed,
        ...(trashedAt ? { trashedAt } : {}),
        score: Math.round(score * 1000) / 1000, snippet: atom.text.slice(start, end), snippetStart: start, snippetEnd: end };
    });
    return { ok: true, mode: 'lexical', results, total: candidates.length, truncated: candidates.length > results.length, limit };
  }
  async read(input) {
    validateInput(input);
    const ref = input.atomId ? decode(input.atomId) : structuredClone(input.ref);
    if (!ref || !SOURCES.includes(ref.source) || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw fail('INVALID_INPUT', 'Supply atomId or revision-aware ref');
    let record;
    try { ({ note: record } = await this.notes.execute({ action: 'get', id: ref.id })); }
    catch (error) { if (error.code === 'NOT_FOUND') throw fail('MISSING', 'Note no longer exists'); throw error; }
    if (record.trashedAt && !input.includeTrashed) throw fail('TRASHED', 'Set includeTrashed to read a trashed note');
    if (ref.field !== 'content') throw fail('INVALID_INPUT', 'Invalid note field');
    const text = record.content || '';
    if (record.revision !== ref.revision || (ref.updatedAt !== undefined && record.updatedAt !== ref.updatedAt) || (ref.fingerprint !== undefined && hash(text) !== ref.fingerprint)) throw fail('CONFLICT', 'Source changed; search again for a current reference');
    integer(ref.start, 0, text.length, 'ref.start', 0);
    integer(ref.end, text.length, text.length, 'ref.end', 0);
    if (ref.start === undefined || ref.end === undefined || ref.start > ref.end) throw fail('INVALID_INPUT', 'Invalid source offsets');
    const start = integer(input.start, ref.start, ref.end, 'start', ref.start);
    const limit = integer(input.limit, 6000, 20000, 'limit');
    const end = safeEnd(text, start, Math.min(ref.end, start + limit));
    const nextRef = end < ref.end ? { ...ref, start: end } : null;
    return { ok: true, atomId: encode(ref), ref, ...metadata(record), content: text.slice(start, end),
      start, end, sourceLength: text.length, atomEnd: ref.end, truncated: end < ref.end,
      nextStart: nextRef ? end : null, nextRef, ...(nextRef ? { nextAtomId: encode(nextRef) } : {}) };
  }
}
