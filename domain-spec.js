import { z } from 'zod';
import { noteSchema, noteVersionSchema } from './notes-store.js';
import { chatBindingSchema } from './note-chats.js';
import { noteStorageControlSchema } from './note-storage.js';
import { attachmentSchema } from './attachment-schema.js';

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
    migration: { valueSchema: migrationReceiptSchema },
  },
};
