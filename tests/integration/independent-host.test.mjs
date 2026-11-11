import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { apply } from '../../src/host/index.js';
import { noteDomainSpec, MIGRATION_RECEIPT_KEY } from '../../src/host/domain-spec.js';

async function fixture(t, pending = false) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-note-independent-'));
  const tables = new Map(), routes = new Map(), tools = new Map(), effects = [], opens = [], reads = [];
  let closed = 0, saves = 0;
  const ambient = new AsyncLocalStorage(), services = new Map(), sections = new Map(), lifecycle = [];
  const sessions = { calls: [], rows: new Map(), deletes: [], gate: null, entered: null,
    async create(input) {
      assert.deepEqual(input, {}, 'Native coauthoring starts blank without prompts or messages');
      this.calls.push(structuredClone(input));
      this.entered?.resolve();
      if (this.gate) await this.gate.promise;
      const sessionId = randomUUID();
      this.rows.set(sessionId, { id: sessionId, events: [] });
      return { sessionId };
    },
    async delete(id) { this.deletes.push(id); this.rows.delete(id); },
  };
  const agents = { requireInitiator() {
    const initiator = ambient.getStore();
    if (!initiator) throw new Error('No initiating conversation');
    return initiator;
  } };
  services.set('agents', agents);
  services.set('sessionController', sessions);
  services.set('remoteAccess', { async allows(target) { return target.kind === 'session' && sessions.rows.has(target.id); } });
  const enableQuery = () => services.set('sessionQuery', {
    async listEvents(id) { return (sessions.rows.get(id)?.events || []).map(event =>
      ({ sessionId: id, seq: event.seq, type: event.type, time: event.time, surface: 'current' })); },
    async readEvent({ sessionId, seq, before, after }) {
      assert.equal(before, 0); assert.equal(after, 0);
      return { session: { id: sessionId }, target: structuredClone(sessions.rows.get(sessionId)?.events.find(event => event.seq === seq)) };
    },
    async searchEvents({ sessionId, filters }) {
      assert.deepEqual(filters, [{ kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] }]);
      return { session: { id: sessionId }, items: await services.get('sessionQuery').listEvents(sessionId), hasMore: false };
    },
  });
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
  const ctx = { attachments, get: name => services.get(name),
    storageDomain: { async open(spec) {
      assert.equal(spec.name, 'dsh_note', 'No legacy or task domain is permitted'); opens.push(spec.name);
      assert.deepEqual(Object.keys(spec.tables), ['notes', 'note_versions', 'note_chats', 'note_storage', 'attachments', 'note_categories', 'note_topics', 'migration']);
      return { table(name) {
        assert.ok(spec.tables[name]); if (!tables.has(name)) tables.set(name, new Map()); const rows = tables.get(name);
        if (pending && name === 'migration') rows.set(MIGRATION_RECEIPT_KEY, { status: 'pending', sourceDomain: 'local_todo_manager', digest: 'a'.repeat(64), at: '2026-11-09T00:00:00Z' });
        return { get: id => { reads.push(name); return structuredClone(rows.get(id)); }, entries: () => structuredClone([...rows]),
          async put(id, row) {
            assert.equal(closed, 0, 'Admitted writes drain before closing the native domain');
            lifecycle.push('put:' + name);
            rows.set(id, spec.tables[name].valueSchema.parse(structuredClone(row)));
          }, async delete(id) {
            assert.equal(closed, 0); lifecycle.push('delete:' + name); rows.delete(id);
          } };
      }, async close() { lifecycle.push('domain:close'); closed++; } };
    } },
    connection: { fetch: { register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    effect(fn) { effects.push(fn()); },
    inject(keys, callback) { assert.deepEqual(keys, ['sessionController', 'agents', 'systemPrompt']); callback({ ...ctx,
      sessionController: sessions, agents,
      systemPrompt: { section(section) {
        assert.ok(['dsh-note.note-coauthor', 'dsh-note.discussion-recall'].includes(section.name));
        assert.equal(sections.has(section.name), false);
        assert.equal(section.text.includes('search_user_context'), false);
        assert.doesNotMatch(section.text, /\b(?:manage_todos|search_todos|search_user_context)\b/);
        if (section.name === 'dsh-note.note-coauthor') assert.match(section.text, /\bsearch_notes\b/);
        else { assert.match(section.text, /\bsearch_note_discussions\b/); assert.match(section.text, /This tool only searches and reads/); }
        sections.set(section.name, section); return () => sections.delete(section.name);
      } },
    }); },
  };
  let disposing;
  const dispose = () => disposing ??= (async () => {
    for (const effect of effects.toReversed()) await (await effect)?.();
    assert.equal(routes.size, 0); assert.equal(tools.size, 0); assert.equal(sections.size, 0);
  })();
  t.after(async () => {
    await dispose();
    const absolute = path.resolve(temp); assert.ok(path.basename(absolute).startsWith('dsh-note-independent-')); assert.equal(path.dirname(absolute), await fs.realpath(os.tmpdir()));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const tool = (name, input) => { assert.ok(tools.has(name), name); return tools.get(name).execute(input); };
  const as = (sessionId, operation) => ambient.run({ id: sessionId }, operation);
  const http = async (route, input) => {
    const response = await routes.get('/api/dsh-note/' + route).fetch(new Request('http://fixture/api/dsh-note/' + route,
      { method: 'POST', body: JSON.stringify(input) }));
    return { status: response.status, value: await response.json() };
  };
  return { ctx, temp, opens, reads, routes, tools, tables, tool, services, sections, sessions, enableQuery, as, http, dispose, lifecycle,
    get closed() { return closed; }, get saves() { return saves; } };
}

test('note host alone opens one note domain and registers no task or combined tools/routes', async t => {
  const f = await fixture(t); await apply(f.ctx);
  assert.deepEqual(f.opens, ['dsh_note']);
  assert.deepEqual([...f.tools.keys()].sort(), ['manage_notes', 'manage_note_categories', 'manage_note_storage', 'manage_note_attachments', 'manage_note_chat', 'edit_note', 'search_notes', 'search_note_discussions'].sort());
  assert.ok([...f.routes.keys()].every(route => route.startsWith('/api/dsh-note/')));
  assert.equal(noteDomainSpec.tables.tasks, undefined);
  const defaults = await f.tool('manage_note_categories', { action: 'list' });
  assert.equal(defaults.tree.revision, 0);
  assert.equal(f.tables.get('note_categories').size, 0, 'Opening a legacy library must not persist default categories');
  const response = await f.routes.get('/api/dsh-note/categories').fetch(new Request('http://fixture/api/dsh-note/categories', {
    method: 'POST', body: JSON.stringify({action: 'create', revision: 0, name: '独立分类', parentId: 'reading'}),
  }));
  assert.equal(response.status, 200);
  const tree = (await response.json()).tree;
  assert.deepEqual((await f.tool('manage_note_categories', {action: 'list'})).tree, tree);
  const category = tree.items.find(item => item.name === '独立分类').id;
  assert.equal(f.tables.get('note_categories').size, 1);
  const created = (await f.tool('manage_notes', { action: 'create', category, title: 'Independent note', content: '# 独立笔记\r\nExact 原始正文' })).note;
  assert.deepEqual((await f.tool('manage_notes', {action: 'list', category: 'reading'})).notes.map(note => note.id), [created.id]);
  assert.equal((await f.tool('manage_notes', {action: 'list', category: 'reading', includeDescendants: false})).total, 0);
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

test('HTTP-created questions select real sources, enforce CAS, reuse blank native sessions and never rewrite formal notes', async t => {
  const f = await fixture(t); await apply(f.ctx);
  const note = (await f.tool('manage_notes', { action: 'create', title: 'Cache source', content: '# Cache\r\ncache transaction isolation 原始正文' })).note;
  const sourceBinding = (await f.tool('manage_note_chat', { action: 'start', noteId: note.id })).binding;
  f.sessions.rows.get(sourceBinding.sessionId).events.push({ seq: 0, type: 'user/message', time: '2026-11-11T00:00:00Z',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'cache transaction isolation prior discussion' }] } });
  const beforeNotes = structuredClone(f.tables.get('notes')), beforeVersions = structuredClone(f.tables.get('note_versions'));
  assert.equal(f.services.has('sessionQuery'), false);
  const notesOnly = await f.as(sourceBinding.sessionId, () => f.tool('search_note_discussions', { action: 'search', query: 'cache transaction' }));
  assert.equal(notesOnly.discussionAvailable, false);
  assert.equal(notesOnly.coverage.reason, 'session_query_unavailable');
  assert.ok(notesOnly.results.length);
  assert.ok(notesOnly.results.every(row => row.reference.kind === 'note'));
  assert.deepEqual([...f.sections.keys()].sort(), ['dsh-note.note-coauthor', 'dsh-note.discussion-recall'].sort());
  assert.deepEqual(f.tools.get('search_note_discussions').parameters.properties.action.enum, ['search', 'read', 'current_topic']);
  assert.equal(f.tools.get('search_note_discussions').isConcurrencySafe(), true);
  assert.equal(f.tools.has('manage_topics'), false);
  assert.equal(f.tools.has('manage_note_topics'), false);
  assert.equal(f.tables.get('note_topics').size, 0, 'Read-only recall must not create questions automatically');

  f.enableQuery();
  const search = await f.http('discussions', { action: 'search', query: 'cache transaction' });
  assert.equal(search.status, 200);
  assert.equal(search.value.discussionAvailable, true);
  const noteRef = search.value.results.find(row => row.reference.kind === 'note').reference;
  const discussionRef = search.value.results.find(row => row.reference.kind === 'discussion').reference;
  assert.deepEqual(discussionRef, { kind: 'discussion', sessionId: sourceBinding.sessionId, seq: 0 });
  const read = await f.http('discussions', { action: 'read', reference: discussionRef });
  assert.equal(read.status, 200);
  assert.equal(read.value.content, 'cache transaction isolation prior discussion');
  const libraryId = search.value.libraryId;
  const created = await f.http('topics', { action: 'create', libraryId, question: 'Why does cache transaction isolation matter?' });
  assert.equal(created.status, 200);
  const topic = created.value.topic;
  assert.deepEqual(topic.references, []);
  assert.equal(created.value.binding, null);
  assert.equal((await f.http('topics', { action: 'get', id: topic.id, libraryId })).value.topic.id, topic.id);
  const selected = await f.http('topics', { action: 'update', id: topic.id, libraryId, revision: 1,
    references: [discussionRef, noteRef], question: 'How do these selected sources connect?' });
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.value.topic.references, [discussionRef, noteRef]);
  assert.equal(selected.value.topic.revision, 2);
  const stale = await f.http('topics', { action: 'update', id: topic.id, libraryId, revision: 1, references: [] });
  assert.equal(stale.status, 409);
  assert.equal(stale.value.code, 'CONFLICT');
  const list = await f.http('topics', { action: 'list' });
  assert.equal(list.value.total, 1);
  assert.equal(list.value.topics[0].referenceCount, 2);
  assert.equal(Object.hasOwn(list.value.topics[0], 'references'), false);
  const sessionCount = f.sessions.calls.length;
  const started = await Promise.all([0, 1].map(() => f.http('topics', { action: 'start', id: topic.id, libraryId })));
  assert.ok(started.every(result => result.status === 200));
  assert.deepEqual(started[0].value, started[1].value);
  assert.equal(f.sessions.calls.length, sessionCount + 1);
  assert.deepEqual(f.sessions.calls.at(-1), {});
  const binding = started[0].value.binding;
  assert.equal(binding.topicId, topic.id);
  assert.deepEqual(f.sessions.rows.get(binding.sessionId).events, [], 'Native topic session has no automatic first message');

  const captured = f.as(binding.sessionId, () => f.tool('search_note_discussions', { action: 'current_topic' }));
  const noteContext = f.as(sourceBinding.sessionId, () => f.tool('search_note_discussions', { action: 'current_topic' }));
  const unrelated = f.as('not-library-bound', () => f.tool('search_note_discussions', { action: 'current_topic' }));
  assert.equal((await captured).topic.id, topic.id);
  assert.equal((await noteContext).topic, null);
  await assert.rejects(unrelated, { code: 'FORBIDDEN' });
  await assert.rejects(f.tool('search_note_discussions', { action: 'current_topic' }), { code: 'NO_INITIATOR' });
  const forbiddenMutation = await f.http('discussions', { action: 'current_topic' });
  assert.equal(forbiddenMutation.status, 400, 'Conversation-only lookup cannot be forged through HTTP');

  const deleted = await f.http('topics', { action: 'delete', id: topic.id, libraryId, revision: 3 });
  assert.equal(deleted.status, 200);
  assert.equal((await f.http('topics', { action: 'get', id: topic.id, libraryId })).status, 404);
  assert.equal(f.tables.get('note_topics').size, 0);
  assert.equal(f.sessions.rows.has(binding.sessionId), true, 'Deleting a topic never deletes its native Session');
  assert.deepEqual(f.sessions.deletes, []);
  assert.deepEqual(f.tables.get('notes'), beforeNotes);
  assert.deepEqual(f.tables.get('note_versions'), beforeVersions);
  assert.equal(f.tables.has('tasks'), false);
  assert.equal(f.tables.has('todos'), false);
});

test('apply shutdown drains an admitted topic start before closing native tables', async t => {
  const f = await fixture(t); await apply(f.ctx);
  const created = await f.http('topics', { action: 'create', libraryId: (await f.http('topics', { action: 'list' })).value.libraryId,
    question: 'A user-created question before shutdown' });
  let enter, release;
  f.sessions.entered = { resolve: () => enter() };
  const entered = new Promise(resolve => { enter = resolve; });
  f.sessions.gate = { promise: new Promise(resolve => { release = resolve; }) };
  const starting = f.http('topics', { action: 'start', id: created.value.topic.id, libraryId: created.value.libraryId });
  await entered;
  const closing = f.dispose();
  await new Promise(setImmediate);
  assert.equal(f.closed, 0, 'Native domain cannot close while the admitted topic write is pending');
  release();
  const result = await starting;
  assert.equal(result.status, 200);
  await closing;
  assert.equal(f.closed, 1);
  assert.equal(f.tables.get('note_topics').get(created.value.topic.id).sessionId, result.value.binding.sessionId);
  assert.ok(f.lifecycle.lastIndexOf('put:note_topics') < f.lifecycle.indexOf('domain:close'));
  assert.equal(f.routes.size + f.tools.size + f.sections.size, 0);
});

test('pending note migration closes domain and prevents any business route or table access', async t => {
  const f = await fixture(t, true); await assert.rejects(apply(f.ctx), { code: 'MIGRATION_INCOMPLETE' });
  assert.equal(f.closed, 1); assert.deepEqual(f.reads, ['migration']); assert.equal(f.routes.size, 0); assert.equal(f.tools.size, 0);
});
