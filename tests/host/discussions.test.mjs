import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscussionSearch} from '../../src/host/discussions/store.js';
import {NotesStore} from '../../src/host/notes/store.js';
import {ContextSearch} from '../../src/host/search/context-search.js';
import {registerDiscussions, registerDiscussionAgent, discussionRecallInstruction} from '../../src/host/discussions/host.js';

const LIBRARY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOPIC = '33333333-3333-4333-8333-333333333333';
const ref = (sessionId = 'old', seq = 0) => ({kind: 'discussion', sessionId, seq});
const noteRef = {kind: 'note', atomId: 'fixture-note-atom'};
const codeIs = code => error => error?.code === code;
class Table {
  rows = new Map();
  get(id) { return structuredClone(this.rows.get(id)); }
  async *entries() { for (const entry of this.rows) yield structuredClone(entry); }
  async put(id, value) { this.rows.set(id, structuredClone(value)); }
  async delete(id) { this.rows.delete(id); }
}
function user(seq, text = 'cache transaction isolation', source = 'user') {
  return {seq, type: 'user/message', time: `2026-11-11T00:00:${String(seq).padStart(2, '0')}Z`, data: {source: {kind: source}, content: [{type: 'text', text}]}};
}
function assistant(seq, text = 'cache transaction isolation') {
  return {seq, type: 'assistant/message', time: '2026-11-11T00:00:00Z', data: {message: {content: [{type: 'reasoning', text: 'PRIVATE REASONING'}, {type: 'text', text}, {type: 'tool-call', name: 'PRIVATE TOOL', arguments: 'SECRET'}]}}};
}
function fixture(options = {}) {
  let libraryId = LIBRARY, initiator = 'current';
  const chats = new Table(), topics = new Table(), events = new Map(), surfaces = new Map();
  const queried = [], read = [], accessCalls = [], denied = new Set(), noteCalls = [];
  chats.rows.set('note', {noteId: 'note', sessionId: 'current', previousSessionIds: ['old'], updatedAt: '2026-11-11T01:00:00Z'});
  events.set('old', [user(0), assistant(1)]); events.set('current', [user(0, 'cache current secret')]);
  const currentRows = id => (events.get(id) || []).map(event => ({sessionId: id, seq: event.seq, type: event.type, time: event.time, surface: surfaces.get(`${id}:${event.seq}`) || 'current'}));
  const native = {
    onSearch: null, onRead: null,
    async searchEvents(request, exec) {
      queried.push(structuredClone(request));
      assert.deepEqual(request.filters, [{kind: 'type', values: ['user/message', 'assistant/message']}, {kind: 'surface', values: ['current']}]);
      await native.onSearch?.(request, exec);
      return {session: {id: request.sessionId}, items: currentRows(request.sessionId).map(row => ({...row, snippet: 'UNTRUSTED INDEX SNIPPET'})), hasMore: false};
    },
    async listEvents(id) { return currentRows(id); },
    async readEvent(request, signal) {
      read.push(structuredClone(request));
      assert.equal(request.before, 0); assert.equal(request.after, 0);
      signal?.throwIfAborted();
      const target = events.get(request.sessionId)?.find(event => event.seq === request.seq);
      await native.onRead?.(request);
      return {session: {id: request.sessionId}, target: structuredClone(target), events: []};
    },
  };
  const notes = {
    onRead: null,
    async execute(request) {
      noteCalls.push(structuredClone(request));
      if (request.action === 'search') return {ok: true, results: [{atomId: noteRef.atomId, title: 'Cache', snippet: 'cache transaction isolation', heading: 'Bounded windows'}]};
      if (request.atomId !== noteRef.atomId) throw Object.assign(new Error('stale'), {code: 'CONFLICT'});
      await notes.onRead?.(request);
      const text = 'cache transaction isolation 中文🙂'; const start = request.start || 0, end = Math.min(text.length, start + request.limit);
      return {ok: true, title: 'Cache', content: text.slice(start, end), nextStart: end < text.length ? end : null};
    },
  };
  let queryDependency = native, accessDependency = {async allows(target) {accessCalls.push(target); return !denied.has(target.id);}}, agentDependency = {requireInitiator() {return {id: initiator};}};
  const store = new DiscussionSearch({notesSearch: notes, chatTable: chats, topicTable: topics, getLibraryId: () => libraryId,
    sessionQuery: () => queryDependency, remoteAccess: () => accessDependency, agents: () => agentDependency, ...options});
  return {store, chats, topics, native, notes, events, surfaces, queried, read, accessCalls, denied, noteCalls,
    setLibrary: id => {libraryId = id;}, setInitiator: id => {initiator = id;}, setQuery: value => {queryDependency = value;},
    setAccess: value => {accessDependency = value;}, setAgents: value => {agentDependency = value;},
    search: (input = {}, options) => store.execute({action: 'search', query: 'cache transaction', ...input}, options),
  };
}

test('automatic recall searches prior direct bindings, validates surface and strips all nontext content', async () => {
  const f = fixture(), result = await f.search();
  assert.equal(result.ok, true); assert.equal(result.libraryId, LIBRARY); assert.equal(result.discussionAvailable, true);
  assert.deepEqual(f.queried.map(request => request.sessionId), ['old']);
  assert.ok(result.results.some(hit => hit.reference.kind === 'note'));
  assert.equal(result.results.filter(hit => hit.reference.kind === 'discussion').length, 2);
  assert.ok(f.read.every(request => request.before === 0 && request.after === 0));
  assert.ok(f.accessCalls.every(target => target.kind === 'session' && target.id === 'old'));
  const output = JSON.stringify(result);
  assert.ok(!output.includes('PRIVATE')); assert.ok(!output.includes('UNTRUSTED INDEX')); assert.ok(!output.includes('current secret'));
  const exact = await f.store.execute({action: 'read', reference: ref('old', 1), limit: 20000});
  assert.equal(exact.content, 'cache transaction isolation'); assert.equal(exact.speaker, 'assistant');
});

test('UI has authenticated library scope but agents without an initiating bound session fail closed', async () => {
  const f = fixture(); f.setInitiator('unrelated');
  await assert.rejects(f.search(), codeIs('FORBIDDEN'));
  assert.equal(f.queried.length, 0); assert.equal(f.noteCalls.length, 0);
  const ui = await f.search({}, {interactive: true});
  assert.equal(ui.ok, true); assert.ok(f.queried.some(request => request.sessionId === 'current'));
  f.setAgents(undefined);
  await assert.rejects(f.search(), codeIs('NO_INITIATOR'));
  await assert.rejects(f.store.execute({action: 'current_topic'}, {interactive: true}), codeIs('INVALID_INPUT'));
});

test('initiators are captured before joining the queue, including previous note sessions and topic sessions', async () => {
  const f = fixture();
  f.topics.rows.set(TOPIC, {id: TOPIC, question: 'Why cache?', sessionId: 'topic-session', references: [noteRef], updatedAt: '2026-11-11T02:00:00Z'});
  f.setInitiator('topic-session');
  const first = f.store.execute({action: 'current_topic'});
  f.setInitiator('old');
  const second = f.store.execute({action: 'current_topic'});
  f.setInitiator('unbound');
  assert.equal((await first).topic.id, TOPIC); assert.equal((await second).topic, null);
  await assert.rejects(f.store.execute({action: 'current_topic'}), codeIs('FORBIDDEN'));
});

test('topic references do not authorize arbitrary sessions and a foreign topic cannot be targeted by agents', async () => {
  const f = fixture();
  f.topics.rows.set(TOPIC, {id: TOPIC, question: 'cache', sessionId: 'topic-session', references: [ref('foreign')], updatedAt: '2026-11-11T02:00:00Z'});
  f.events.set('foreign', [user(0, 'cache secret outside this library')]);
  await assert.rejects(f.store.execute({action: 'read', reference: ref('foreign')}), codeIs('FORBIDDEN'));
  await assert.rejects(f.store.validateReference(ref('foreign'), {libraryId: LIBRARY}), codeIs('FORBIDDEN'));
  await assert.rejects(f.search({topicId: TOPIC}), codeIs('FORBIDDEN'));
  const ui = await f.search({topicId: TOPIC}, {interactive: true});
  assert.ok(!ui.results.some(hit => hit.reference.sessionId === 'foreign'));
  assert.ok(!f.queried.some(request => request.sessionId === 'foreign'));
});

test('missing native authorization or query explicitly degrades to notes only and never bypasses read checks', async () => {
  const f = fixture(); f.setAccess(undefined);
  const result = await f.search();
  assert.equal(result.discussionAvailable, false); assert.equal(result.coverage.reason, 'authorization_unavailable');
  assert.deepEqual(result.results.map(hit => hit.reference.kind), ['note']); assert.equal(f.queried.length, 0);
  await assert.rejects(f.store.execute({action: 'read', reference: ref()}), codeIs('FORBIDDEN'));
  f.setAccess({allows: () => true}); f.setQuery(undefined);
  const second = await f.search(); assert.equal(second.discussionAvailable, false); assert.equal(second.coverage.reason, 'session_query_unavailable');
  assert.equal(second.results[0].reference.kind, 'note');
});

test('denied remote access yields no session messages even for an otherwise bound session', async () => {
  const f = fixture(); f.denied.add('old');
  const result = await f.search();
  assert.ok(result.results.every(hit => hit.reference.kind === 'note')); assert.equal(f.queried.length, 0);
  assert.equal(result.coverage.sessionsUnavailable, 1);
  await assert.rejects(f.store.validateReference(ref()), codeIs('FORBIDDEN'));
});

test('log-only, shadowed, system-source users and reasoning/tool/checkpoint events are never exposed', async () => {
  const f = fixture();
  f.events.set('old', [user(0), user(1), user(2, 'cache secret', 'system'), {seq: 3, type: 'tool/result', data: {content: [{type: 'text', text: 'cache tool secret'}]}},
    {seq: 4, type: 'assistant/message', data: {message: {content: [{type: 'reasoning', text: 'cache hidden reasoning'}]}}},
    {seq: 5, type: 'surface/checkpoint', data: {text: 'cache hidden checkpoint'}}]);
  f.surfaces.set('old:0', 'shadowed'); f.surfaces.set('old:1', 'log-only');
  const result = await f.search();
  assert.ok(result.results.every(hit => hit.reference.kind === 'note'));
  for (let seq = 0; seq < 6; seq++) await assert.rejects(f.store.execute({action: 'read', reference: ref('old', seq)}), codeIs('NOT_FOUND'));
});

test('reads recheck surface and library bindings after loading a message', async () => {
  const f = fixture(); f.native.onRead = () => f.surfaces.set('old:0', 'shadowed');
  await assert.rejects(f.store.execute({action: 'read', reference: ref()}), codeIs('NOT_FOUND'));
  f.native.onRead = () => {f.chats.rows.clear();}; f.surfaces.clear();
  await assert.rejects(f.store.execute({action: 'read', reference: ref()}), codeIs('FORBIDDEN'));
});

test('unexpected observed session identity is refused and cannot contribute a search hit', async () => {
  const f = fixture(); f.native.readEvent = async () => ({session: {id: 'foreign'}, target: user(0)});
  await assert.rejects(f.store.execute({action: 'read', reference: ref()}), codeIs('FORBIDDEN'));
  const result = await f.search(); assert.ok(result.results.every(hit => hit.reference.kind === 'note'));
});

test('library changes during async search or reference validation reject the entire response', async () => {
  const f = fixture(); f.native.onSearch = () => f.setLibrary(OTHER);
  await assert.rejects(f.search(), codeIs('CONFLICT'));
  const g = fixture(); g.notes.onRead = () => g.setLibrary(OTHER);
  await assert.rejects(g.store.validateReference(noteRef, {libraryId: LIBRARY}), codeIs('CONFLICT'));
  await assert.rejects(g.store.validateReference(noteRef, {libraryId: LIBRARY}), codeIs('CONFLICT'));
});

test('queued UI reads retain their admission library instead of silently retargeting a later library', async () => {
  const f = fixture();
  const admitted = f.search({}, {interactive: true});
  f.setLibrary(OTHER);
  await assert.rejects(admitted, codeIs('CONFLICT'));
  assert.equal(f.queried.length, 0); assert.equal(f.noteCalls.length, 0);
});

test('note reads delegate bounded exact offsets and validate references without entering TopicStore queues', async () => {
  const f = fixture();
  const result = await f.store.execute({action: 'read', reference: {...noteRef, label: 'My selected note'}, start: 6, limit: 5});
  assert.equal(result.content, 'trans'); assert.equal(result.nextStart, 11); assert.equal(result.reference.label, 'My selected note');
  assert.deepEqual(await f.store.validateReference(noteRef, {libraryId: LIBRARY}), noteRef);
  assert.equal(f.noteCalls.at(-1).limit, 1);
  await assert.rejects(f.store.validateReference({kind: 'note', atomId: 'stale'}), codeIs('CONFLICT'));
});

test('bounded discussion windows preserve UTF-16 pairs and nextStart covers the exact source', async () => {
  const f = fixture(), text = 'A🙂中文\r\nB🙂tail'; f.events.set('old', [user(0, text)]);
  let start = 0, collected = '';
  do {
    const result = await f.store.execute({action: 'read', reference: ref(), start, limit: 3});
    assert.ok(!/[\uD800-\uDBFF]$/.test(result.content)); assert.ok(!/^[\uDC00-\uDFFF]/.test(result.content));
    collected += result.content; start = result.nextStart;
  } while (start !== null);
  assert.equal(collected, text);
  await assert.rejects(f.store.execute({action: 'read', reference: ref(), start: 100}), codeIs('INVALID_INPUT'));
});

test('automatic recall ignores low-signal noise, caps at six and two hits per session; interactive search is broader', async () => {
  const f = fixture(); f.events.set('old', Array.from({length: 10}, (_, i) => user(i, 'cache transaction isolation')));
  const result = await f.search(); assert.equal(result.results.filter(hit => hit.reference.kind === 'discussion').length, 2); assert.ok(result.results.length <= 6);
  const manual = await f.search({limit: 40}, {interactive: true}); assert.ok(manual.results.length > result.results.length);
  const weak = await f.search({query: 'the'}); assert.equal(weak.results.length, 0);
  const overlap = await f.search({query: 'cache different unrelated vocabulary'}); assert.equal(overlap.results.length, 0);
});

test('automatic search inspects only the 24 most recent bound sessions and excludes its initiator', async () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) {
    const id = `session-${String(i).padStart(2, '0')}`;
    f.chats.rows.set(id, {sessionId: id, updatedAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`});
    f.events.set(id, [user(0)]);
  }
  const result = await f.search();
  assert.equal(f.queried.length, 24); assert.ok(!f.queried.some(request => request.sessionId === 'current'));
  assert.ok(!f.queried.some(request => request.sessionId === 'session-00'));
  assert.equal(result.coverage.truncated, true); assert.equal(result.coverage.mode, 'lexical'); assert.ok(result.results.length <= 6);
});

test('matching current-topic selected sources are prioritized but unrelated references are still rejected', async () => {
  const f = fixture();
  f.topics.rows.set(TOPIC, {id: TOPIC, question: 'Cache question', sessionId: 'current', references: [ref('old', 1), ref('foreign'), noteRef]});
  const result = await f.search({topicId: TOPIC});
  assert.deepEqual(result.results[0].reference, ref('old', 1));
  assert.ok(result.results.every(hit => hit.reference.sessionId !== 'foreign'));
  const current = await f.store.execute({action: 'current_topic'}); assert.equal(current.topic.question, 'Cache question');
});

test('a stale selected note reference does not prevent fresh lexical recall for that topic', async () => {
  const f = fixture();
  f.topics.rows.set(TOPIC, {id: TOPIC, question: 'Cache question', sessionId: 'current', references: [{kind: 'note', atomId: 'stale'}]});
  const result = await f.search({topicId: TOPIC});
  assert.equal(result.ok, true); assert.ok(result.results.some(hit => hit.reference.kind === 'discussion'));
  assert.ok(result.results.every(hit => hit.reference.atomId !== 'stale'));
});

test('current-surface fallback accepts only the observed matching session and eligible messages', async () => {
  const f = fixture(); const native = {...f.native}; delete native.listEvents;
  native.readSurface = async id => ({session: {id}, events: f.events.get(id)}); f.setQuery(native);
  const result = await f.store.execute({action: 'read', reference: ref()}); assert.equal(result.speaker, 'user');
  native.readSurface = async () => ({session: {id: 'foreign'}, events: f.events.get('old')});
  await assert.rejects(f.store.execute({action: 'read', reference: ref()}), codeIs('FORBIDDEN'));
});

test('invalid fields and unbounded windows fail without note or native work; cancellation propagates', async () => {
  const f = fixture();
  for (const input of [{action: 'search', query: ''}, {action: 'search', query: 'x'.repeat(1001)}, {action: 'search', query: 'cache', limit: 41},
    {action: 'read', reference: ref(), limit: 20001}, {action: 'read', reference: ref(), start: -1}, {action: 'read', reference: {...ref(), seq: 1.5}},
    {action: 'search', query: 'cache', interactive: true}]) await assert.rejects(f.store.execute(input));
  assert.equal(f.noteCalls.length, 0); assert.equal(f.queried.length, 0);
  const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
  await assert.rejects(f.search({}, {signal: controller.signal}), /fixture cancelled/);
});

test('actual ContextSearch note references keep exact source windows and reject stale revisions', async () => {
  const notes = new NotesStore(new Table(), new Table());
  const content = '# Cache\r\n\r\ncache transaction isolation 中文🙂';
  const created = await notes.execute({action: 'create', title: 'Cache design', content});
  const chats = new Table(); chats.rows.set(created.note.id, {sessionId: 'current'});
  const store = new DiscussionSearch({notesSearch: new ContextSearch({notes}), chatTable: chats, topicTable: new Table(), getLibraryId: () => LIBRARY,
    agents: {requireInitiator: () => ({id: 'current'})}});
  const hits = await store.execute({action: 'search', query: 'cache transaction'});
  assert.equal(hits.discussionAvailable, false); assert.ok(hits.results.length > 0);
  const reference = hits.results[0].reference;
  assert.equal(reference.kind, 'note'); assert.deepEqual(await store.validateReference(reference, {libraryId: LIBRARY}), reference);
  const exact = await store.execute({action: 'read', reference, limit: 20000}); assert.equal(exact.content, content);
  await notes.execute({action: 'update', id: created.note.id, revision: created.note.revision, content: 'changed'});
  await assert.rejects(store.execute({action: 'read', reference}), codeIs('CONFLICT'));
});

test('missing surface verification explicitly degrades and library/initiator revocation also protects note-only reads', async () => {
  const f = fixture(), native = {...f.native}; delete native.listEvents;
  f.setQuery(native);
  const result = await f.search(); assert.equal(result.discussionAvailable, false);
  await assert.rejects(f.store.execute({action: 'read', reference: ref()}), codeIs('DISCUSSIONS_UNAVAILABLE'));
  f.notes.onRead = () => f.chats.rows.clear();
  await assert.rejects(f.store.execute({action: 'read', reference: noteRef}), codeIs('FORBIDDEN'));
});

test('selected sources do not expand the automatic 24-session budget; skipped event pages are disclosed', async () => {
  const f = fixture();
  for (let i = 0; i < 25; i++) f.chats.rows.set(`recent-${i}`, {sessionId: `recent-${i}`, updatedAt: '2026-12-01T00:00:00Z'});
  f.topics.rows.set(TOPIC, {id: TOPIC, question: 'Cache', sessionId: 'current', references: [ref('old')]});
  await f.search({topicId: TOPIC});
  assert.ok(!f.read.some(request => request.sessionId === 'old')); assert.equal(f.queried.length, 24);
  const g = fixture(); g.events.set('old', Array.from({length: 10}, (_, i) => user(i)));
  const result = await g.search(); assert.equal(g.read.length, 2); assert.equal(result.coverage.partialEventPages, 1); assert.equal(result.coverage.truncated, true);
});

test('close synchronously gates new work and drains native reads plus concurrent source validation', async () => {
  const f = fixture();
  let release, entered, count = 0;
  const gate = new Promise(resolve => {release = resolve;});
  const bothEntered = new Promise(resolve => {entered = resolve;});
  f.native.onRead = async () => {if (++count === 2) entered(); await gate;};
  const reading = f.store.execute({action: 'read', reference: ref()});
  const validation = f.store.validateReference(ref(), {libraryId: LIBRARY});
  await bothEntered;
  let finished = false;
  const closing = f.store.close(); closing.then(() => {finished = true;});
  assert.equal(f.store.close(), closing);
  await assert.rejects(f.search(), codeIs('CLOSED'));
  await assert.rejects(f.store.validateReference(noteRef), codeIs('CLOSED'));
  assert.equal(finished, false);
  release(); await reading; await validation; await closing;
  assert.equal(finished, true); assert.equal(f.store.pendingValidation.size, 0);
});

test('recycled or deleted parent notes revoke current and historical conversation sources and initiators', async () => {
  let metadata = {id: 'note', title: 'Active source', trashedAt: ''};
  const f = fixture({getNoteMetadata: id => id === 'note' ? metadata : null});
  const active = await f.search(); assert.ok(active.results.some(hit => hit.reference.kind === 'discussion'));
  for (const unavailable of [{...metadata, trashedAt: '2026-11-11T00:00:00Z'}, null]) {
    metadata = unavailable; f.queried.length = 0;
    const manual = await f.search({}, {interactive: true});
    assert.ok(manual.results.every(hit => hit.reference.kind === 'note')); assert.equal(f.queried.length, 0);
    await assert.rejects(f.search(), codeIs('FORBIDDEN'));
    f.setInitiator('old'); await assert.rejects(f.search(), codeIs('FORBIDDEN')); f.setInitiator('current');
    await assert.rejects(f.store.execute({action: 'read', reference: ref()}), codeIs('FORBIDDEN'));
    await assert.rejects(f.store.validateReference(ref(), {libraryId: LIBRARY}), codeIs('FORBIDDEN'));
  }
  await f.store.close();
});

test('active note discussion titles come from the lightweight projection without full note reads', async () => {
  const ids = [];
  const f = fixture({getNoteMetadata: id => {ids.push(id); return {id, title: '真实笔记标题', trashedAt: ''};}});
  const result = await f.search();
  const messages = result.results.filter(hit => hit.reference.kind === 'discussion');
  assert.equal(messages.length, 2); assert.ok(messages.every(hit => hit.title === '真实笔记标题'));
  const exact = await f.store.execute({action: 'read', reference: ref()}); assert.equal(exact.title, '真实笔记标题');
  assert.ok(ids.every(id => id === 'note'));
  assert.ok(f.noteCalls.every(call => call.action === 'search')); // no NotesStore.get or whole-body retrieval
  await f.store.close();
});

test('library switches while awaiting the note projection fail before exposing either library', async () => {
  const f = fixture();
  f.store.getNoteMetadata = async id => {f.setLibrary(OTHER); return {id, title: 'Do not expose', trashedAt: ''};};
  await assert.rejects(f.search({}, {interactive: true}), codeIs('CONFLICT'));
  assert.equal(f.noteCalls.length, 0); assert.equal(f.queried.length, 0);
  await f.store.close();
});

function controlledBudget(store) {
  let next = 0;
  const timers = new Map(), seen = [];
  store.setTimer = (callback, milliseconds) => {const id = ++next; timers.set(id, callback); seen.push({id, milliseconds}); return id;};
  store.clearTimer = id => timers.delete(id);
  return {timers, seen, expire(id) {const callback = timers.get(id); assert.ok(callback); timers.delete(id); callback();}};
}

test('automatic timeout aborts native work and returns only ready note candidates with explicit coverage', async () => {
  const f = fixture(), clock = controlledBudget(f.store);
  let entered, nativeSignal;
  const started = new Promise(resolve => {entered = resolve;});
  f.native.onSearch = async (_request, exec) => {
    nativeSignal = exec.signal; entered();
    await new Promise((_yes, no) => exec.signal.addEventListener('abort', () => no(exec.signal.reason), {once: true}));
  };
  const searching = f.search(); await started;
  assert.equal(clock.seen[0].milliseconds, 10000);
  clock.expire(clock.seen[0].id);
  const result = await searching;
  assert.equal(nativeSignal.aborted, true);
  assert.equal(result.discussionAvailable, false); assert.equal(result.coverage.timedOut, true); assert.equal(result.coverage.reason, 'timeout');
  assert.ok(result.results.length > 0); assert.ok(result.results.every(hit => hit.reference.kind === 'note'));
  await f.store.close(); assert.equal(clock.timers.size, 0);
});

test('queue waiting consumes the same budget, and providers ignoring abort remain owned until close drains them', async () => {
  const f = fixture(), clock = controlledBudget(f.store);
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;}), held = new Promise(resolve => {release = resolve;});
  f.native.onSearch = async () => {entered(); await held;};
  const first = f.search(); await started;
  const second = f.search();
  clock.expire(clock.seen[1].id);
  const queued = await second;
  assert.deepEqual(queued.results, []); assert.equal(queued.coverage.timedOut, true); assert.equal(f.noteCalls.length, 1);
  clock.expire(clock.seen[0].id);
  const timedOut = await first; assert.ok(timedOut.results.every(hit => hit.reference.kind === 'note'));
  let closed = false;
  const closing = f.store.close().then(() => {closed = true;});
  await Promise.resolve(); assert.equal(closed, false);
  release(); await closing;
  assert.equal(closed, true); assert.equal(f.queried.length, 1); assert.equal(f.store.pendingRequests.size, 0); assert.equal(clock.timers.size, 0);
});

test('manual searches have a 30-second budget and user cancellation never turns into a timeout success', async () => {
  const f = fixture(), clock = controlledBudget(f.store);
  let entered, signal;
  const started = new Promise(resolve => {entered = resolve;});
  f.native.onSearch = async (_request, exec) => {
    signal = exec.signal; entered();
    await new Promise((_yes, no) => exec.signal.addEventListener('abort', () => no(exec.signal.reason), {once: true}));
  };
  const caller = new AbortController();
  const searching = f.search({}, {interactive: true, signal: caller.signal}); await started;
  assert.equal(clock.seen[0].milliseconds, 30000); assert.notEqual(signal, caller.signal);
  const cancellation = Object.assign(new Error('User cancelled recall'), {code: 'USER_CANCELLED'});
  caller.abort(cancellation);
  await assert.rejects(searching, error => error === cancellation);
  assert.equal(signal.aborted, true); assert.equal(clock.timers.size, 0);
  await f.store.close();
});

test('timeout fallback still rejects changed libraries and does not return cross-library note candidates', async () => {
  const f = fixture(), clock = controlledBudget(f.store);
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;}), held = new Promise(resolve => {release = resolve;});
  f.native.onSearch = async () => {entered(); await held;};
  const searching = f.search(); await started;
  f.setLibrary(OTHER); clock.expire(clock.seen[0].id);
  await assert.rejects(searching, codeIs('CONFLICT'));
  release(); await f.store.close();
});

function registration(store) {
  const routes = new Map(), tools = new Map(), prompts = [], cleanups = [];
  const ctx = {effect(fn) {cleanups.push(fn());}, connection: {fetch: {register(route) {routes.set(route.path, route); return () => routes.delete(route.path);}}},
    tools: {register(tool) {tools.set(tool.name, tool); return () => tools.delete(tool.name);}},
    systemPrompt: {section(section) {prompts.push(section); return () => prompts.splice(prompts.indexOf(section), 1);}}};
  registerDiscussions(ctx, store); registerDiscussionAgent(ctx, store);
  return {routes, tools, prompts, async close() {for (const cleanup of cleanups.reverse()) await cleanup?.();}};
}
test('HTTP and agent adapters keep their scopes separate, bound streamed inputs and own cleanup', async () => {
  const f = fixture(), registered = registration(f.store), route = registered.routes.get('/api/dsh-note/discussions');
  const post = value => route.fetch(new Request('http://fixture/api/dsh-note/discussions', {method: 'POST', body: JSON.stringify(value)}));
  f.setAgents(undefined);
  assert.equal((await post({action: 'search', query: 'cache'})).status, 200);
  assert.equal((await post({action: 'current_topic'})).status, 400);
  const tool = registered.tools.get('search_note_discussions');
  await assert.rejects(tool.execute({action: 'search', query: 'cache'}), codeIs('NO_INITIATOR'));
  assert.equal((await post({action: 'read', reference: ref('foreign')})).status, 403);
  assert.equal((await route.fetch(new Request('http://fixture', {method: 'POST', body: 'x'.repeat(32769)}))).status, 413);
  assert.equal((await route.fetch(new Request('http://fixture', {method: 'POST', body: '{'}))).status, 400);
  assert.equal(registered.prompts[0].text, discussionRecallInstruction);
  assert.match(discussionRecallInstruction, /do not force a search every turn/);
  assert.match(discussionRecallInstruction, /Do not proactively organize/);
  await registered.close(); assert.equal(registered.routes.size, 0); assert.equal(registered.tools.size, 0); assert.equal(registered.prompts.length, 0);
});
