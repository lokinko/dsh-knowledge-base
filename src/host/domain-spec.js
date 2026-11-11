import { z } from 'zod';
import { noteSchema, noteVersionSchema } from './notes/schema.js';
import { chatBindingSchema } from './coauthor/schema.js';
import { noteStorageControlSchema } from './storage/schema.js';
import { attachmentSchema } from './attachments/schema.js';
import { categoryTreeSchema } from './categories/schema.js';
import { topicSchema } from './topics/schema.js';

export const MIGRATION_RECEIPT_KEY = 'legacy-split-v1';
export const migrationReceiptSchema = z.object({
  status: z.enum(['pending', 'complete']),
  sourceDomain: z.literal('local_todo_manager'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.iso.datetime({ offset: true }),
}).strict();
export const noteAttachmentSchema = attachmentSchema.refine(row => row.ownerType === 'note', 'Expected a note attachment');
export const noteDomainSpec = {
  name: 'dsh_note', version: 1,
  tables: {
    notes: { valueSchema: noteSchema },
    note_versions: { valueSchema: noteVersionSchema },
    note_chats: { valueSchema: chatBindingSchema },
    note_storage: { valueSchema: noteStorageControlSchema },
    attachments: { valueSchema: noteAttachmentSchema },
    note_categories: { valueSchema: categoryTreeSchema },
    note_topics: { valueSchema: topicSchema },
    migration: { valueSchema: migrationReceiptSchema },
  },
};
