const categoryId = { type: 'string', description: 'Builtin document/reading/code/journal ID or custom category UUID.' };
const parameters = {
  type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'create', 'update', 'move'] },
    revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
      description: 'Current tree revision, required for every write; obtain from list.' },
    id: { ...categoryId, description: 'Category ID required for update and move.' },
    name: { type: 'string', maxLength: 80, description: 'Name for create or update. Empty resets a builtin label to its translated default.' },
    parentId: { anyOf: [categoryId, { type: 'null' }], description: 'Destination parent; null or omitted means root.' },
    beforeId: { anyOf: [categoryId, { type: 'null' }], description: 'Move before this destination sibling; null or omitted appends.' },
  }, required: ['action'], additionalProperties: false,
};
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
export function registerCategories(ctx, store) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-note/categories', methods: ['GET', 'POST'], requestBody: 'streaming',
    async fetch(request) {
      try {
        if (request.method === 'GET') return json(await store.execute({ action: 'list' }));
        if (request.method !== 'POST') throw new Error('Unsupported request method');
        return json(await store.execute(JSON.parse(await request.text())));
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'INVALID_REQUEST';
        return json({ ok: false, error: error instanceof Error ? error.message : String(error), code },
          code === 'CONFLICT' ? 409 : code === 'NOT_FOUND' ? 404 : 400);
      }
    },
  }));
  ctx.effect(() => ctx.tools.register({ name: 'manage_note_categories',
    description: 'List, create, rename and move note categories. Moves support hierarchy and sibling ordering, up to 8 levels. Writes require the current tree revision; category IDs remain stable.',
    parameters,
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } },
    execute(input) { return store.execute(input); },
  }));
}
