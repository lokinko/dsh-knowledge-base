import { noteDomainSpec, noteAttachmentSchema, MIGRATION_RECEIPT_KEY } from './domain-spec.js';
import { AttachmentStore } from './attachment-store.js';
import { registerAttachments } from './attachment-host.js';
import { NoteStorage } from './note-storage.js';
import { registerNoteStorage } from './note-storage-host.js';
import { ContextSearch } from './context-search.js';
import { registerContextSearch } from './context-search-host.js';
import { NoteEdits, registerNoteEdits } from './note-edits.js';
import { NoteChats, registerNoteChats, chatBindingSchema } from './note-chats.js';
import { NotesStore, noteSchema, noteVersionSchema } from './notes-store.js';
import { registerNotes } from './notes-host.js';

export const inject = ['storageDomain', 'connection', 'tools', 'attachments'];
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(noteDomainSpec);
  let storage;
  try {
    if ((await domain.table('migration').get(MIGRATION_RECEIPT_KEY))?.status === 'pending') {
      throw Object.assign(new Error('The note migration is incomplete. Finish migration before enabling this plugin.'), { code: 'MIGRATION_INCOMPLETE' });
    }
    const blobs = { save: input => ctx.attachments.saveFileStream(input),
      read: (ref, signal) => ctx.attachments.readFileStream(ref, signal), hostPath: ref => ctx.attachments.fileHostPath(ref) };
    storage = new NoteStorage({ legacy: { notes: domain.table('notes'), note_versions: domain.table('note_versions'),
      note_chats: domain.table('note_chats'), attachments: domain.table('attachments') },
      controlTable: domain.table('note_storage'), schemas: { notes: noteSchema, note_versions: noteVersionSchema,
        note_chats: chatBindingSchema, attachments: noteAttachmentSchema }, blobs });
    await storage.start();
    const notes = new NotesStore(storage.table('notes'), storage.table('note_versions'));
    const attachments = new AttachmentStore({ storage, blobs, fixedOwnerType: 'note', basePath: '/api/dsh-note',
      resolveOwner: (_type, id) => storage.table('notes').get(id) });
    const search = new ContextSearch({ notes }), chats = new Set();
    ctx.effect(() => async () => {
      await attachments.close();
      await Promise.all([...chats].map(store => store.close()));
      await search.queue; await notes.queue;
      await storage.close(); await domain.close();
    });
    registerNotes(ctx, notes);
    registerNoteStorage(ctx, storage);
    registerAttachments(ctx, attachments);
    registerContextSearch(ctx, search);
    registerNoteEdits(ctx, new NoteEdits(notes));
    if (typeof ctx.inject === 'function') ctx.inject(['sessionController', 'agents', 'systemPrompt'], inner => {
      const chat = new NoteChats({ table: storage.table('note_chats'), notes,
        sessions: inner.sessionController, agents: inner.agents });
      chats.add(chat); registerNoteChats(inner, chat);
      inner.effect(() => () => chat.close().finally(() => chats.delete(chat)));
    });
  } catch (error) {
    await storage?.close(); await domain.close(); throw error;
  }
}
