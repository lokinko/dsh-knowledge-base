import { z } from 'zod';
import { referenceSchema, uniqueReferences } from './references.js';

const uuidSchema = z.string().uuid();
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sessionSchema = z.string().min(1);
const questionSchema = z.string().trim().min(1).max(500);
const isoSchema = z.iso.datetime({ offset: true });
const referencesSchema = z.array(referenceSchema).max(100);
export const topicSchema = z.object({
  id: uuidSchema, question: questionSchema, revision: revisionSchema,
  references: referencesSchema.refine(items => uniqueReferences(items).length === items.length, 'Duplicate topic references'),
  sessionId: sessionSchema.optional(), createdAt: isoSchema, updatedAt: isoSchema,
}).strict();
const writeIdentity = { libraryId: uuidSchema };
const existingIdentity = { id: uuidSchema, revision: revisionSchema };
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), libraryId: uuidSchema.optional() }).strict(),
  z.object({ action: z.literal('get'), id: uuidSchema, libraryId: uuidSchema.optional() }).strict(),
  z.object({ action: z.literal('create'), ...writeIdentity, revision: z.literal(0).optional(),
    question: questionSchema, references: referencesSchema.default([]) }).strict(),
  z.object({ action: z.literal('update'), ...writeIdentity, ...existingIdentity,
    question: questionSchema.optional(), references: referencesSchema.optional() }).strict(),
  z.object({ action: z.literal('delete'), ...writeIdentity, ...existingIdentity }).strict(),
  z.object({ action: z.literal('start'), ...writeIdentity, id: uuidSchema, revision: revisionSchema.optional() }).strict(),
]);

export {actions as topicActionSchema, uuidSchema as topicIdSchema, sessionSchema as topicSessionSchema, isoSchema as topicTimeSchema};
