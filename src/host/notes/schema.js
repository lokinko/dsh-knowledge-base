import { z } from 'zod';
import { categoryIdSchema as categorySchema } from '../categories/schema.js';

const idSchema = z.string().uuid();
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const isoSchema = z.iso.datetime({ offset: true });
const calendarSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return value.slice(0, 4) !== '0000' && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Expected a real calendar date (YYYY-MM-DD)');
const tagsSchema = z.array(z.string().min(1).max(40)).max(20)
  .refine(tags => new Set(tags).size === tags.length, 'Tags must be unique');
const editableShape = {
  title: z.string().max(200),
  content: z.string(),
  category: categorySchema,
  tags: tagsSchema,
  pinned: z.boolean(),
  journalDate: z.union([z.literal(''), calendarSchema]),
};

// Defaults cover optional descriptive fields; identity and concurrency fields
// remain mandatory so malformed persisted records cannot be silently rewritten.
export const noteSchema = z.object({
  id: idSchema,
  title: editableShape.title.default('Untitled'),
  content: editableShape.content.default(''),
  category: categorySchema.default('document'),
  tags: tagsSchema.default([]),
  pinned: z.boolean().default(false),
  journalDate: editableShape.journalDate.default(''),
  trashedAt: z.union([z.literal(''), isoSchema]).default(''),
  createdAt: isoSchema,
  updatedAt: isoSchema,
  revision: revisionSchema,
});

export const noteVersionSchema = noteSchema.extend({
  versionId: z.string(),
  noteId: idSchema,
  savedAt: isoSchema,
}).refine(version => version.noteId === version.id &&
  version.versionId === `${version.noteId}:${version.revision}`, 'Invalid version identity');

const optionalEdits = Object.fromEntries(
  Object.entries(editableShape).map(([key, schema]) => [key, schema.optional()]),
);
const identity = { id: idSchema };
const writeIdentity = { ...identity, revision: revisionSchema };
const versionIdentity = { ...identity, versionId: z.string().min(1) };
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), query: z.string().optional(), category: categorySchema.optional(),
    includeDescendants: z.boolean().default(true),
    tag: z.string().min(1).max(40).optional(), pinnedOnly: z.boolean().optional(),
    trashed: z.boolean().default(false), offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50) }).strict(),
  z.object({ action: z.literal('get'), ...identity }).strict(),
  z.object({ action: z.literal('create'), ...optionalEdits }).strict(),
  z.object({ action: z.literal('journal'), date: calendarSchema }).strict(),
  z.object({ action: z.literal('update'), ...writeIdentity, ...optionalEdits }).strict(),
  z.object({ action: z.literal('trash'), ...writeIdentity }).strict(),
  z.object({ action: z.literal('restore'), ...writeIdentity }).strict(),
  z.object({ action: z.literal('checkpoint'), ...writeIdentity }).strict(),
  z.object({ action: z.literal('versions'), ...identity,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20) }).strict(),
  z.object({ action: z.literal('version'), ...versionIdentity }).strict(),
  z.object({ action: z.literal('restore_version'), ...writeIdentity,
    versionId: z.string().min(1) }).strict(),
]);


export {actionSchema as noteActionSchema, editableShape, isoSchema as noteTimeSchema};
