import { z } from 'zod';

const noteIdSchema = z.string().uuid();
const sessionIdSchema = z.string().min(1);
const isoSchema = z.iso.datetime({ offset: true });
export const chatBindingSchema = z.object({
  noteId: noteIdSchema,
  sessionId: sessionIdSchema,
  previousSessionIds: z.array(sessionIdSchema).optional(),
  createdAt: isoSchema,
  updatedAt: isoSchema,
}).strict();

const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), noteId: noteIdSchema }).strict(),
  z.object({ action: z.literal('start'), noteId: noteIdSchema, newSession: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('current') }).strict(),
]);

export {actions as noteChatActionSchema, sessionIdSchema, isoSchema as chatTimeSchema};
