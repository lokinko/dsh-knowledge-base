// Pure note fields and persisted draft protocol; no storage or browser access.
export const NOTE_DRAFT_PREFIX = 'dsh.todo-manager.note-draft.v1:';
const CATEGORIES = new Set(['document', 'reading', 'code', 'journal']);
const CATEGORY_UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const validCategory = value => typeof value === 'string' && (CATEGORIES.has(value) || CATEGORY_UUID.test(value));
const FIELD_NAMES = ['title', 'content', 'category', 'tags', 'pinned', 'journalDate'];

function validDate(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function normalizeNoteFields(input, defaults = false) {
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
      !validCategory(fields.category) || !Array.isArray(fields.tags) ||
      fields.tags.length > 20 || fields.tags.some(tag => typeof tag !== 'string' || tag.length < 1 || tag.length > 40) ||
      new Set(fields.tags).size !== fields.tags.length ||
      typeof fields.pinned !== 'boolean' || !validDate(fields.journalDate)) {
    throw new TypeError('Invalid note fields');
  }
  return { ...fields, tags: [...fields.tags] };
}

export function noteFieldsEqual(a, b) {
  return a.title === b.title && a.content === b.content && a.category === b.category &&
    a.pinned === b.pinned && a.journalDate === b.journalDate &&
    a.tags.length === b.tags.length && a.tags.every((tag, index) => tag === b.tags[index]);
}

export function validateDraftIdentity(noteId, writerId, revision) {
  if (typeof noteId !== 'string' || !noteId || typeof writerId !== 'string' || !writerId ||
      !Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid draft identity or revision');
}

export function noteDraftKey(noteId, writerId) {
  return `${NOTE_DRAFT_PREFIX}${encodeURIComponent(noteId)}:${encodeURIComponent(writerId)}`;
}

export function cloneDraftRecord(record) {
  return record ? { ...record, fields: normalizeNoteFields(record.fields) } : null;
}

export function decodeLegacyDraft(key, raw) {
  try {
    const value = JSON.parse(raw);
    if (value.version !== 1) return null;
    validateDraftIdentity(value.noteId, value.writerId, value.baseRevision);
    if (key !== noteDraftKey(value.noteId, value.writerId) || typeof value.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.updatedAt))) return null;
    return { version: 1, noteId: value.noteId, writerId: value.writerId,
      baseRevision: value.baseRevision, fields: normalizeNoteFields(value.fields),
      updatedAt: value.updatedAt, key, raw, volatile: false };
  } catch {
    return null;
  }
}
