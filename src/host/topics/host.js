function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

const MAX_REQUEST_BYTES = 1024 * 1024;
async function readInput(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Expected a JSON request body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        // A failing producer cancellation must not change the size rejection.
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error('Request exceeds 1 MiB'), { code: 'REQUEST_TOO_LARGE' });
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error?.code === 'REQUEST_TOO_LARGE') throw error;
    throw Object.assign(new Error('Invalid UTF-8 JSON request body'), { code: 'INVALID_REQUEST' });
  } finally { reader.releaseLock(); }
}

/** Uses the existing authenticated connection router. Topic mutations remain
 * explicit UI requests; this registration exposes no agent mutation tools.
 */
export function registerTopics(ctx, store) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-note/topics', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      if (request.method !== 'POST') return json({ ok: false, code: 'INVALID_REQUEST', error: 'Use POST' }, 405);
      try {
        return json(await store.execute(await readInput(request)));
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'INVALID_REQUEST';
        const status = code === 'REQUEST_TOO_LARGE' ? 413 : code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' || code === 'CLOSED' ? 409 :
          code === 'UNAVAILABLE' ? 503 : code === 'SESSION_CREATE_FAILED' ? 502 : 400;
        return json({ ok: false, code, error: error instanceof Error ? error.message : String(error) }, status);
      }
    },
  }));
}
