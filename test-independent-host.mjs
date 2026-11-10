import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { apply } from './index.source.js';
import { noteDomainSpec, MIGRATION_RECEIPT_KEY } from './domain-spec.js';

async function fixture(t, pending = false) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-note-independent-'));
  const tables = new Map(), routes = new Map(), tools = new Map(), effects = [], opens = [], reads = [];
  let closed = 0, saves = 0;
  const object = ref => { assert.match(ref.attachmentId, /^sha256:[a-f0-9]{64}$/); return path.join(temp, ref.attachmentId.slice(7)); };
  const attachments = {
    async saveFileStream({ data, name = '', signal }) {
      const temporary = path.join(temp, 'tmp-' + randomUUID()), handle = await fs.open(temporary, 'wx'), hash = createHash('sha256'); let bytes = 0;
      try { for await (const chunk of data) { signal?.throwIfAborted(); hash.update(chunk); bytes += chunk.length; await handle.writeFile(chunk); } await handle.sync(); }
      finally { await handle.close(); }
      const digest = hash.digest('hex'); await fs.rename(temporary, path.join(temp, digest)); saves++;
      return { attachmentId: 'sha256:' + digest, name, bytes };
    },
    async *readFileStream(ref, signal) {
      const handle = await fs.open(object(ref), 'r');
      try { while (true) { signal?.throwIfAborted(); const bytes = Buffer.allocUnsafe(65536), part = await handle.read(bytes, 0, bytes.length, null); if (!part.bytesRead) break; yield bytes.subarray(0, part.bytesRead); } }
      finally { await handle.close(); }
    },
    fileHostPath: object,
  };
  const ctx = { attachments,
    storageDomain: { async open(spec) {
      assert.equal(spec.name, 'dsh_note', 'No legacy or task domain is permitted'); opens.push(spec.name);
      assert.deepEqual(Object.keys(spec.tables), ['notes', 'note_versions', 'note_chats', 'note_storage', 'attachments', 'migration']);
      return { table(name) {
        assert.ok(spec.tables[name]); if (!tables.has(name)) tables.set(name, new Map()); const rows = tables.get(name);
        if (pending && name === 'migration') rows.set(MIGRATION_RECEIPT_KEY, { status: 'pending', sourceDomain: 'local_todo_manager', digest: 'a'.repeat(64), at: '2026-11-09T00:00:00Z' });
        return { get: id => { reads.push(name); return structuredClone(rows.get(id)); }, entries: () => structuredClone([...rows]),
          async put(id, row) { rows.set(id, spec.tables[name].valueSchema.parse(structuredClone(row))); }, async delete(id) { rows.delete(id); } };
      }, async close() { closed++; } };
    } },
    connection: { fetch: { register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    effect(fn) { effects.push(fn()); },
    inject(keys, callback) { assert.deepEqual(keys, ['sessionController', 'agents', 'systemPrompt']); callback({ ...ctx,
      sessionController: { async create() { return { sessionId: randomUUID() }; } }, agents: { requireInitiator() { return { id: 'fixture' }; } },
      systemPrompt: { section(section) { assert.ok(section.text.includes('search_notes')); assert.equal(section.text.includes('search_user_context'), false); return () => {}; } },
    }); },
  };
  t.after(async () => {
    for (const effect of effects.reverse()) await (await effect)?.();
    assert.equal(routes.size, 0); assert.equal(tools.size, 0);
    const absolute = path.resolve(temp); assert.ok(path.basename(absolute).startsWith('dsh-note-independent-')); assert.equal(path.dirname(absolute), await fs.realpath(os.tmpdir()));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const tool = (name, input) => { assert.ok(tools.has(name), name); return tools.get(name).execute(input); };
  return { ctx, temp, opens, reads, routes, tools, tables, tool, get closed() { return closed; }, get saves() { return saves; } };
}

test('note host alone opens one note domain and registers no task or combined tools/routes', async t => {
  const f = await fixture(t); await apply(f.ctx);
  assert.deepEqual(f.opens, ['dsh_note']);
  assert.deepEqual([...f.tools.keys()].sort(), ['manage_notes', 'manage_note_storage', 'manage_note_attachments', 'manage_note_chat', 'edit_note', 'search_notes'].sort());
  assert.ok([...f.routes.keys()].every(route => route.startsWith('/api/dsh-note/')));
  assert.equal(noteDomainSpec.tables.tasks, undefined);
  const created = (await f.tool('manage_notes', { action: 'create', title: 'Independent note', content: '# 独立笔记\r\nExact 原始正文' })).note;
  const found = await f.tool('search_notes', { action: 'search', query: '原始正文' }); assert.ok(found.results.length);
  assert.ok(found.results.every(row => row.ref.source === 'note'));
  assert.ok((await f.tool('search_notes', { action: 'read', atomId: found.results[0].atomId })).content.includes('原始正文'));
  await assert.rejects(f.tool('search_notes', { action: 'search', query: 'x', source: 'task' }), { code: 'INVALID_INPUT' });
  assert.equal((await f.tool('manage_notes', { action: 'get', id: created.id })).note.content, '# 独立笔记\r\nExact 原始正文');
});

test('note-only attachments keep file identity through directory migration and reject task scope', async t => {
  const f = await fixture(t); await apply(f.ctx);
  const note = (await f.tool('manage_notes', { action: 'create', title: 'Attachment owner' })).note;
  const upload = async ownerType => {
    const params = new URLSearchParams({ ownerId: note.id, name: 'same.pdf', ...(ownerType ? { ownerType } : {}) });
    return f.routes.get('/api/dsh-note/attachment-upload').fetch(new Request('http://fixture/api/dsh-note/attachment-upload?' + params, { method: 'POST', body: '%PDF-1.7\r\nExact\0binary' }));
  };
  const wrong = await upload('task'); assert.equal(wrong.status, 400); assert.equal(f.saves, 0);
  const response = await upload(); assert.equal(response.status, 200); const row = (await response.json()).attachment;
  assert.equal(row.ownerType, 'note'); assert.ok(row.url.startsWith('/api/dsh-note/attachment-file'));
  assert.equal(f.tools.get('manage_note_attachments').parameters.properties.ownerType, undefined);
  assert.equal((await f.tool('manage_note_attachments', { action: 'list', ownerId: note.id })).total, 1);
  await assert.rejects(f.tool('manage_note_attachments', { action: 'list', ownerType: 'task', ownerId: note.id }), { code: 'INVALID_REQUEST' });
  let status = await f.tool('manage_note_storage', { action: 'status' });
  status = await f.tool('manage_note_storage', { action: 'set', directory: path.join(f.temp, 'notes-directory'), revision: status.revision });
  const download = () => f.routes.get('/api/dsh-note/attachment-file').fetch(new Request('http://fixture' + row.url));
  assert.equal(await (await download()).text(), '%PDF-1.7\r\nExact\0binary');
  await f.tool('manage_note_attachments', { action: 'remove', ownerId: note.id, id: row.id, revision: 1 });
  assert.equal((await f.tool('manage_note_attachments', { action: 'list', ownerId: note.id })).total, 0);
  await f.tool('manage_note_storage', { action: 'set', directory: '', revision: status.revision });
  assert.equal(await (await download()).text(), '%PDF-1.7\r\nExact\0binary');
});

test('pending note migration closes domain and prevents any business route or table access', async t => {
  const f = await fixture(t, true); await assert.rejects(apply(f.ctx), { code: 'MIGRATION_INCOMPLETE' });
  assert.equal(f.closed, 1); assert.deepEqual(f.reads, ['migration']); assert.equal(f.routes.size, 0); assert.equal(f.tools.size, 0);
});
