import { noteDomainSpec, noteAttachmentSchema, MIGRATION_RECEIPT_KEY } from './domain-spec.js';
import { AttachmentStore } from './attachments/store.js';
import { registerAttachments } from './attachments/host.js';
import { NoteStorage } from './storage/note-storage.js';
import { registerNoteStorage } from './storage/host.js';
import { ContextSearch } from './search/context-search.js';
import { registerContextSearch } from './search/host.js';
import { NoteEdits, registerNoteEdits } from './notes/edits.js';
import { NoteChats, registerNoteChats } from './coauthor/note-chats.js';
import { chatBindingSchema } from './coauthor/schema.js';
import { NotesStore } from './notes/store.js';
import { noteSchema, noteVersionSchema } from './notes/schema.js';
import { registerNotes } from './notes/host.js';
import { CategoryStore } from './categories/store.js';
import { categoryTreeSchema } from './categories/schema.js';
import { registerCategories } from './categories/host.js';
import { TopicStore } from './topics/store.js';
import { topicSchema } from './topics/schema.js';
import { registerTopics } from './topics/host.js';
import { DiscussionSearch } from './discussions/store.js';
import { registerDiscussions, registerDiscussionAgent } from './discussions/host.js';

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
      note_chats: domain.table('note_chats'), attachments: domain.table('attachments'),
      note_categories: domain.table('note_categories'), note_topics: domain.table('note_topics') },
      controlTable: domain.table('note_storage'), schemas: { notes: noteSchema, note_versions: noteVersionSchema,
        note_chats: chatBindingSchema, attachments: noteAttachmentSchema, note_categories: categoryTreeSchema, note_topics: topicSchema }, blobs });
    await storage.start();
    const categories = new CategoryStore(storage.table('note_categories'));
    const notes = new NotesStore(storage.table('notes'), storage.table('note_versions'), undefined, { categories });
    const attachments = new AttachmentStore({ storage, blobs, fixedOwnerType: 'note', basePath: '/api/dsh-note',
      resolveOwner: (_type, id) => storage.table('notes').get(id) });
    const search = new ContextSearch({ notes }), chats = new Set();
    const discussions = new DiscussionSearch({ notesSearch: search, chatTable: storage.table('note_chats'),
      topicTable: storage.table('note_topics'), getLibraryId: () => storage.libraryId,
      getNoteMetadata: id => storage.noteMetadata(id),
      sessionQuery: () => ctx.get?.('sessionQuery'), remoteAccess: () => ctx.get?.('remoteAccess'),
      agents: () => ctx.get?.('agents') });
    const topics = new TopicStore({ table: storage.table('note_topics'), getLibraryId: () => storage.libraryId,
      validateReference: (ref, options) => discussions.validateReference(ref, options) });
    ctx.effect(() => async () => {
      await attachments.close();
      await Promise.all([...chats].map(store => store.close()));
      await topics.close();
      await discussions.close?.();
      await search.queue; await notes.queue; await categories.queue;
      await storage.close(); await domain.close();
    });
    registerNotes(ctx, notes);
    registerCategories(ctx, categories);
    registerNoteStorage(ctx, storage);
    registerAttachments(ctx, attachments);
    registerContextSearch(ctx, search);
    registerTopics(ctx, topics);
    registerDiscussions(ctx, discussions);
    registerNoteEdits(ctx, new NoteEdits(notes));
    if (typeof ctx.inject === 'function') ctx.inject(['sessionController', 'agents', 'systemPrompt'], inner => {
      topics.setSessions(inner.sessionController);
      const chat = new NoteChats({ table: storage.table('note_chats'), notes,
        sessions: inner.sessionController, agents: inner.agents });
      chats.add(chat); registerNoteChats(inner, chat);
      registerDiscussionAgent(inner, discussions);
      inner.effect(() => () => { topics.setSessions(null); return chat.close().finally(() => chats.delete(chat)); });
    });
  } catch (error) {
    await storage?.close(); await domain.close(); throw error;
  }
}
