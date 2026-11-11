export const contextSearchToolSchema = {
  name: 'search_notes',
  description: 'Search Markdown notes by lexical relevance. Results have bounded snippets and source references; read an atomId for exact current source text.',
  parameters: {
    type: 'object', properties: {
      action: { type: 'string', enum: ['search', 'read'] },
      query: { type: 'string', minLength: 1, maxLength: 1000, description: 'Required for search; Unicode words and Chinese substrings.' },
      source: { type: 'string', enum: ['note'], description: 'Optional note source filter.' },
      documentId: { type: 'string', maxLength: 200, description: 'Optional note ID filter.' },
      includeTrashed: { type: 'boolean', default: false, description: 'Allow searching or reading trashed notes.' },
      atomId: { type: 'string', maxLength: 4000, description: 'Required for read; copy from search or nextAtomId.' },
      start: { type: 'integer', minimum: 0, description: 'Read absolute UTF-16 source offset within this atom; defaults to its start.' },
      limit: { type: 'integer', minimum: 1, maximum: 20000, description: 'Search result count: default 12, max 40. Read characters: default 6000, max 20000.' },
      snippetLimit: { type: 'integer', minimum: 1, maximum: 600, default: 400, description: 'Search snippet character limit.' },
    }, required: ['action'], additionalProperties: false,
  },
};

/** One operation for authenticated UI requests and agent tools; no store/domain ownership. */
export function registerContextSearch(ctx, search) {
  const execute = input => search.execute(input);
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-note/context', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      try {
        if (request.method !== 'POST') return Response.json({ ok: false, code: 'INVALID_INPUT', error: 'Use POST' }, { status: 405 });
        // Small inputs only; consume incrementally instead of buffering an unbounded request.
        const reader = request.body?.getReader();
        let raw = '', bytes = 0;
        const decoder = new TextDecoder();
        if (reader) {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 32768) { await reader.cancel(); return Response.json({ ok: false, code: 'INVALID_INPUT', error: 'Request exceeds 32 KiB' }, { status: 413 }); }
              raw += decoder.decode(value, { stream: true });
            }
            raw += decoder.decode();
          } finally { reader.releaseLock(); }
        }
        return Response.json(await execute(JSON.parse(raw)), { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        const code = error?.code || 'INVALID_INPUT';
        return Response.json({ ok: false, code, error: error?.message || String(error) },
          { status: code === 'CONFLICT' ? 409 : code === 'MISSING' ? 404 : 400, headers: { 'Cache-Control': 'no-store' } });
      }
    },
  }));
  ctx.effect(() => ctx.tools.register({
    ...contextSearchToolSchema,
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } },
    isConcurrencySafe: () => true,
    execute,
  }));
}
