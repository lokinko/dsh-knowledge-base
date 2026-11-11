import { z } from 'zod';

const actions = ['list', 'get', 'create', 'journal', 'update', 'trash', 'restore',
  'checkpoint', 'versions', 'version', 'restore_version'];
const contentWindowSchema = z.object({
  contentOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  contentLimit: z.number().int().min(1).max(50000).default(16000),
});
const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: actions },
    id: { type: 'string', format: 'uuid', description: 'Note ID; required except for list, create and journal.' },
    revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
      description: 'Current revision required for update, trash, restore, checkpoint and restore_version.' },
    title: { type: 'string', maxLength: 200, description: 'Create/update title; defaults to Untitled on create.' },
    content: { type: 'string', description: 'Exact Markdown for create/update. Omit on update to preserve.' },
    category: { type: 'string', description: 'Builtin document/reading/code/journal ID or a custom category UUID from manage_note_categories. Defaults to document on create.' },
    includeDescendants: { type: 'boolean', description: 'List category filter includes descendants by default; false selects only notes directly in that category.' },
    tags: { type: 'array', maxItems: 20, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 40 },
      description: 'Replacement tags for create/update; defaults to [] on create.' },
    pinned: { type: 'boolean', description: 'Create/update pin; defaults to false on create.' },
    journalDate: { type: 'string', maxLength: 10, pattern: '^(?:|[0-9]{4}-[0-9]{2}-[0-9]{2})$',
      description: 'Create/update calendar date YYYY-MM-DD or empty string.' },
    date: { type: 'string', minLength: 10, maxLength: 10, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
      description: 'Required calendar date for journal; returns the existing active journal for that date or creates one.' },
    versionId: { type: 'string', minLength: 1, maxLength: 64, description: 'Required for version and restore_version; obtain from versions.' },
    query: { type: 'string', maxLength: 200000, description: 'List search across title, Markdown and tags; case-insensitive.' },
    tag: { type: 'string', minLength: 1, maxLength: 40, description: 'Exact tag filter for list.' },
    pinnedOnly: { type: 'boolean', description: 'List pinned notes only; defaults to false.' },
    trashed: { type: 'boolean', description: 'List trash instead of active notes; defaults to false.' },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0,
      description: 'List/versions pagination offset.' },
    limit: { type: 'integer', minimum: 1, maximum: 100,
      description: 'List page size defaults to 50, maximum 100; versions defaults to 20, maximum 50.' },
    contentOffset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0,
      description: 'Get/version only: Markdown character offset. Continue at nextContentOffset until null.' },
    contentLimit: { type: 'integer', minimum: 1, maximum: 50000, default: 16000,
      description: 'Get/version only: maximum Markdown characters returned.' },
  },
  required: ['action'],
  additionalProperties: false,
};

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function executeTool(store, input) {
  if (input?.action !== 'get' && input?.action !== 'version') return store.execute(input);
  const { contentOffset, contentLimit, ...request } = input;
  const window = contentWindowSchema.parse({ contentOffset, contentLimit });
  const result = await store.execute(request);
  const key = input.action === 'get' ? 'note' : 'version';
  const record = result[key];
  const contentLength = record.content.length;
  const end = Math.min(contentLength, window.contentOffset + window.contentLimit);
  return { ...result, [key]: { ...record,
    content: record.content.slice(window.contentOffset, end),
    contentLength, contentOffset: window.contentOffset,
    nextContentOffset: end < contentLength ? end : null,
  } };
}

/** Register with the existing authenticated Connection router and tool registry.
 * The caller owns the store and its queue/domain lifetime.
 */
export function registerNotes(ctx, store) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-note/notes',
    methods: ['GET', 'POST'],
    requestBody: 'streaming',
    async fetch(request) {
      try {
        if (request.method === 'GET') return json(await store.execute({ action: 'list' }));
        if (request.method !== 'POST') throw new Error('Unsupported request method');
        const raw = await request.text();
        return json(await store.execute(JSON.parse(raw)));
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'INVALID_REQUEST';
        return json({ ok: false, error: error instanceof Error ? error.message : String(error), code },
          code === 'CONFLICT' ? 409 : code === 'NOT_FOUND' ? 404 : 400);
      }
    },
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'manage_notes',
    description: 'Manage Markdown notes: list metadata, read content, and organize categories, tags and pins. Writes return metadata; edits use optimistic revisions. Trash and history restores are reversible; get/version reads return chunks.',
    parameters,
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; },
    },
    execute(input) { return executeTool(store, input); },
  }));
}
