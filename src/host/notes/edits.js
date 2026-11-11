import { z } from 'zod';

const identity = {
  id: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), ...identity,
    oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('append'), ...identity, text: z.string() }).strict(),
]);
const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['replace', 'append'] },
    id: { type: 'string', format: 'uuid' },
    revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
      description: 'Current note revision from manage_notes.' },
    oldText: { type: 'string', minLength: 1, description: 'Replace only: exact nonempty source to match.' },
    newText: { type: 'string', description: 'Replace only: exact replacement; empty deletes.' },
    replaceAll: { type: 'boolean', default: false,
      description: 'Replace all nonoverlapping matches; otherwise require a unique match.' },
    text: { type: 'string', description: 'Append only: exact text at EOF, including any desired newline.' },
  },
  required: ['action', 'id', 'revision'],
  additionalProperties: false,
};
const failure = (code, message) => Object.assign(new Error(message), { code });
const json = (value, status = 200) => Response.json(value,
  { status, headers: { 'Cache-Control': 'no-store' } });

/** Literal edits share NotesStore's revision checks, history, and write queue.
 * The final compare-and-swap rejects a writer arriving after the initial read.
 */
export class NoteEdits {
  constructor(notesStore) { this.notesStore = notesStore; }

  async execute(input) {
    const request = inputSchema.parse(input);
    const { note } = await this.notesStore.execute({ action: 'get', id: request.id });
    if (request.revision !== note.revision) {
      throw failure('CONFLICT', 'Note changed elsewhere. Refresh and retry.');
    }
    let content;
    let replacementCount = 0;
    if (request.action === 'append') {
      content = note.content + request.text;
    } else {
      const start = note.content.indexOf(request.oldText);
      if (start === -1) throw failure('NO_MATCH', 'oldText was not found. Read the current source and retry.');
      if (!request.replaceAll) {
        if (note.content.indexOf(request.oldText, start + 1) !== -1) {
          throw failure('AMBIGUOUS_MATCH', 'oldText occurs more than once. Include more context or set replaceAll.');
        }
        content = note.content.slice(0, start) + request.newText + note.content.slice(start + request.oldText.length);
        replacementCount = 1;
      } else {
        content = note.content.replaceAll(request.oldText, () => {
          replacementCount++;
          return request.newText;
        });
      }
    }
    if (content !== note.content) {
      if (note.trashedAt) throw failure('TRASHED', 'Restore this note from trash before editing it');
      await this.notesStore.execute({ action: 'checkpoint', id: note.id, revision: request.revision });
    }
    const result = await this.notesStore.execute({ action: 'update', id: note.id,
      revision: note.revision, content });
    return { ...result, replacementCount };
  }
}

export function registerNoteEdits(ctx, edits) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-note/note-edits', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      try {
        if (request.method !== 'POST') throw new Error('Unsupported request method');
        return json(await edits.execute(JSON.parse(await request.text())));
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'INVALID_REQUEST';
        return json({ ok: false, error: error instanceof Error ? error.message : String(error), code },
          code === 'CONFLICT' ? 409 : code === 'NOT_FOUND' ? 404 : 400);
      }
    },
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'edit_note',
    description: 'Apply a literal replacement or append to a Markdown note. Read the source with manage_notes first. Conflicts preserve the current note; read it again before retrying. Returns metadata and replacementCount (0 for append); each change checkpoints the previous revision.',
    parameters,
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; },
    },
    execute(input) { return edits.execute(input); },
  }));
}
