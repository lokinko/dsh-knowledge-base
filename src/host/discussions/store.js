import {z} from 'zod';
import {referenceSchema, referenceKey} from '../topics/references.js';

const fail = (code, message) => Object.assign(new Error(message), {code});
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const actions = z.discriminatedUnion('action', [
  z.object({action: z.literal('search'), query: z.string().trim().min(1).max(1000),
    topicId: z.string().uuid().optional(), limit: z.number().int().min(1).max(40).default(12)}).strict(),
  z.object({action: z.literal('read'), reference: referenceSchema, start: integer.optional(),
    limit: z.number().int().min(1).max(20000).default(6000)}).strict(),
  z.object({action: z.literal('current_topic')}).strict(),
]);
const resolve = dependency => typeof dependency === 'function' ? dependency() : dependency;
const fold = text => String(text).normalize('NFKC').toLowerCase();
const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'what', 'how', 'please', 'can', 'you', 'are', 'was', 'our', 'your', '你好', '谢谢']);
function termsOf(query) {
  const terms = [];
  for (const match of fold(query).matchAll(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu)) {
    const word = match[0];
    if (stopWords.has(word)) continue;
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      if (chars.length > 1) for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1]);
    } else if (word.length >= 3) terms.push(word);
  }
  return [...new Set(terms)];
}
function relevance(text, query, terms, interactive) {
  const source = fold(text), phrase = fold(query);
  const matches = terms.filter(term => source.includes(term)).length;
  if (!interactive && !terms.length) return 0;
  if (source.includes(phrase)) return 2 + matches;
  if (interactive) return matches ? matches / Math.max(1, terms.length) : 0;
  if (!terms.length || matches < Math.min(2, terms.length)) return 0;
  return matches / terms.length >= .25 ? matches / terms.length : 0;
}
function safeWindow(text, start, limit) {
  if (start > text.length) throw fail('INVALID_INPUT', 'start exceeds the source length');
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start--;
  let end = Math.min(text.length, start + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  // A one-unit window cannot contain a surrogate pair; return both units to make progress.
  if (end === start && end < text.length) end = Math.min(text.length, start + 2);
  return {content: text.slice(start, end), start, nextStart: end < text.length ? end : null};
}
function snippet(text, query) {
  const index = fold(text).indexOf(fold(query));
  return safeWindow(text, index > 60 ? index - 60 : 0, 400).content;
}
function eventText(event) {
  let content, speaker;
  if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
    content = event.data.content; speaker = 'user';
  } else if (event?.type === 'assistant/message') {
    content = event.data?.message?.content; speaker = 'assistant';
  } else return null;
  if (!Array.isArray(content)) return null;
  const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  return text.trim() ? {text, speaker} : null;
}
async function rows(table) {
  const values = [];
  if (!table) return values;
  for await (const [, value] of await table.entries()) values.push(structuredClone(value));
  return values;
}
function observedSession(result, expected) {
  const id = result?.session?.id ?? result?.session?.sessionId;
  if (id !== expected) throw fail('FORBIDDEN', 'The observed session does not match this reference');
}

/** Read-only lexical retrieval. Only direct library bindings grant a session scope.
 * Topic references are evidence pointers and never confer access to other sessions.
 */
export class DiscussionSearch {
  constructor({notesSearch, chatTable, topicTable, getLibraryId, getNoteMetadata, sessionQuery, remoteAccess, agents,
    budgets = {automatic: 10000, interactive: 30000}, setTimer = setTimeout, clearTimer = clearTimeout}) {
    if (!notesSearch?.execute || typeof getLibraryId !== 'function') throw new TypeError('Notes search and library identity are required');
    Object.assign(this, {notesSearch, chatTable, topicTable, getLibraryId, getNoteMetadata, sessionQuery, remoteAccess, agents});
    this.queue = Promise.resolve();
    this.closed = false;
    this.pendingValidation = new Set();
    this.pendingRequests = new Set();
    this.budgets = budgets;
    this.setTimer = (...args) => Reflect.apply(setTimer, globalThis, args);
    this.clearTimer = (...args) => Reflect.apply(clearTimer, globalThis, args);
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.allSettled([this.queue, ...this.pendingValidation, ...this.pendingRequests]).then(() => {});
    return this.closePromise;
  }
  captureInitiator() {
    try {
      const id = resolve(this.agents)?.requireInitiator()?.id;
      if (typeof id === 'string' && id) return id;
    } catch {}
    throw fail('NO_INITIATOR', 'Discussion recall requires an initiating conversation');
  }
  execute(input, options = {}) {
    if (this.closed) return Promise.reject(fail('CLOSED', 'Discussion retrieval is closing'));
    options = {...options};
    let request, initiatorId, libraryAtAdmission;
    try {
      request = actions.parse(structuredClone(input));
      initiatorId = options.initiatorId;
      if (!options.interactive && !initiatorId) initiatorId = this.captureInitiator();
      if (request.action === 'current_topic' && options.interactive) throw fail('INVALID_INPUT', 'current_topic is available to conversation tools');
      // Capture before joining the queue: a later route switch cannot retarget an admitted read.
      libraryAtAdmission = Promise.resolve(options.libraryId ?? this.getLibraryId());
      libraryAtAdmission.catch(() => {});
    } catch (error) { return Promise.reject(error); }
    // This bounds request waiting, not index speed: cold native index/reconcile
    // latency has not been benchmarked and no warm-up performance is promised.
    const callerSignal = options.signal;
    const deadline = new AbortController();
    const milliseconds = options.interactive ? this.budgets.interactive : this.budgets.automatic;
    const timer = this.setTimer(() => deadline.abort(fail('TIMEOUT', 'Discussion retrieval exceeded its time budget')), milliseconds);
    options.signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    const progress = {notes: []};
    const work = this.queue.then(async () => {
      options.signal.throwIfAborted();
      const scope = await this.scope(await libraryAtAdmission);
      this.authorizeInitiator(scope, initiatorId);
      const context = {...options, initiatorId, scope, progress};
      if (request.action === 'current_topic') {
        const topic = scope.topics.find(topic => topic.sessionId === initiatorId) ?? null;
        this.authorizeInitiator(await this.scope(scope.libraryId), initiatorId);
        return {ok: true, libraryId: scope.libraryId, topic};
      }
      if (request.action === 'read') return this.read(request, context);
      return this.search(request, context);
    });
    // The original work stays owned by the queue even if a provider ignores abort.
    // close() waits for it; no timed-out native work is detached or silently discarded.
    this.queue = work.catch(() => {});
    let onAbort;
    const bounded = new Promise((yes, no) => {
      onAbort = () => no(options.signal.reason || fail('ABORTED', 'Discussion retrieval cancelled'));
      options.signal.addEventListener('abort', onAbort, {once: true});
      work.then(yes, no);
      if (options.signal.aborted) onAbort();
    }).catch(async error => {
      callerSignal?.throwIfAborted();
      if (!deadline.signal.aborted || request.action !== 'search') throw error;
      const scope = await this.scope(await libraryAtAdmission);
      this.authorizeInitiator(scope, initiatorId);
      callerSignal?.throwIfAborted();
      return {ok: true, libraryId: scope.libraryId, results: progress.notes, discussionAvailable: false,
        coverage: {mode: 'lexical', timedOut: true, reason: 'timeout', budgetMs: milliseconds, truncated: true}};
    }).finally(() => {
      this.clearTimer(timer);
      options.signal.removeEventListener('abort', onAbort);
    });
    this.pendingRequests.add(bounded);
    void bounded.finally(() => this.pendingRequests.delete(bounded)).catch(() => {});
    return bounded;
  }
  async assertLibrary(libraryId) {
    if (await this.getLibraryId() !== libraryId) throw fail('CONFLICT', 'Notebook library changed. Repeat the request in the current library.');
  }
  async scope(expectedLibraryId) {
    const libraryId = z.string().uuid().parse(await this.getLibraryId());
    if (expectedLibraryId !== undefined && expectedLibraryId !== libraryId) throw fail('CONFLICT', 'Notebook library changed');
    const chats = await rows(this.chatTable), topics = await rows(this.topicTable);
    await this.assertLibrary(libraryId);
    const sessions = new Map();
    const add = (id, row, title) => {
      if (typeof id !== 'string' || !id) return;
      const previous = sessions.get(id);
      const updatedAt = row.updatedAt || row.createdAt || '';
      if (!previous || updatedAt > previous.updatedAt) sessions.set(id, {sessionId: id, title, updatedAt});
    };
    for (const chat of chats) {
      if (chat.libraryId && chat.libraryId !== libraryId) continue;
      // Production supplies the validated storage projection; never load/clone a note body here.
      let title = chat.title || 'Note discussion';
      if (this.getNoteMetadata) {
        const note = await this.getNoteMetadata(chat.noteId);
        await this.assertLibrary(libraryId);
        if (!note || note.trashedAt || note.id !== chat.noteId) continue;
        title = note.title || 'Untitled note';
      }
      add(chat.sessionId, chat, title);
      for (const id of chat.previousSessionIds || []) add(id, chat, title);
    }
    const currentTopics = topics.filter(topic => !topic.libraryId || topic.libraryId === libraryId)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    for (const topic of currentTopics) add(topic.sessionId, topic, topic.question || 'Question discussion');
    return {libraryId, sessions, topics: currentTopics};
  }
  authorizeInitiator(scope, initiatorId) {
    if (initiatorId !== undefined && !scope.sessions.has(initiatorId)) throw fail('FORBIDDEN', 'This conversation is outside the current notebook library');
  }
  async sessionAccess(sessionId, context) {
    const current = await this.scope(context.scope.libraryId);
    this.authorizeInitiator(current, context.initiatorId);
    context.signal?.throwIfAborted();
    const binding = current.sessions.get(sessionId);
    if (!binding) throw fail('FORBIDDEN', 'Discussion is outside the current notebook library');
    const access = resolve(this.remoteAccess);
    if (!access?.allows || !await access.allows({kind: 'session', id: sessionId})) throw fail('FORBIDDEN', 'Discussion access is unavailable or denied');
    await this.assertLibrary(current.libraryId);
    context.signal?.throwIfAborted();
    return binding;
  }
  async visibleEvent(reference, context) {
    context.signal?.throwIfAborted();
    const binding = await this.sessionAccess(reference.sessionId, context);
    const query = resolve(this.sessionQuery);
    if (!query?.readEvent || (!query.listEvents && !query.readSurface)) throw fail('DISCUSSIONS_UNAVAILABLE', 'Current-surface discussion reading is unavailable');
    let event;
    if (query.listEvents) {
      const visible = await query.listEvents(reference.sessionId);
      context.signal?.throwIfAborted();
      if (!visible.some(row => row.sessionId === reference.sessionId && row.seq === reference.seq && row.surface === 'current')) throw fail('NOT_FOUND', 'This message is no longer on the current conversation surface');
      const result = await query.readEvent({sessionId: reference.sessionId, seq: reference.seq, before: 0, after: 0}, context.signal);
      context.signal?.throwIfAborted();
      observedSession(result, reference.sessionId);
      event = result.target;
      const fresh = await query.listEvents(reference.sessionId);
      if (!fresh.some(row => row.sessionId === reference.sessionId && row.seq === reference.seq && row.surface === 'current')) throw fail('NOT_FOUND', 'This message is no longer on the current conversation surface');
    } else {
      const surface = await query.readSurface(reference.sessionId);
      observedSession(surface, reference.sessionId);
      event = surface.events.find(event => event.seq === reference.seq);
    }
    if (event?.seq !== reference.seq) throw fail('NOT_FOUND', 'Discussion message not found');
    const extracted = eventText(event);
    if (!extracted) throw fail('NOT_FOUND', 'This event has no eligible user or assistant text');
    await this.sessionAccess(reference.sessionId, context);
    context.signal?.throwIfAborted();
    return {...extracted, time: event.time, title: binding.title};
  }
  validateReference(input, options = {}) {
    if (this.closed) return Promise.reject(fail('CLOSED', 'Discussion retrieval is closing'));
    const work = this.validateAdmittedReference(input, {...options});
    this.pendingValidation.add(work);
    void work.finally(() => this.pendingValidation.delete(work)).catch(() => {});
    return work;
  }
  async validateAdmittedReference(input, options) {
    const reference = referenceSchema.parse(structuredClone(input));
    const scope = await this.scope(options.libraryId);
    this.authorizeInitiator(scope, options.initiatorId);
    const context = {...options, scope};
    if (reference.kind === 'note') await this.notesSearch.execute({action: 'read', atomId: reference.atomId, limit: 1});
    else await this.visibleEvent(reference, context);
    await this.assertLibrary(scope.libraryId);
    return reference;
  }
  async read(request, context) {
    const reference = request.reference;
    if (reference.kind === 'note') {
      const result = await this.notesSearch.execute({action: 'read', atomId: reference.atomId,
        ...(request.start === undefined ? {} : {start: request.start}), limit: request.limit});
      this.authorizeInitiator(await this.scope(context.scope.libraryId), context.initiatorId);
      return {ok: true, libraryId: context.scope.libraryId, content: result.content, title: result.title,
        reference, nextStart: result.nextStart ?? null};
    }
    const event = await this.visibleEvent(reference, context);
    const window = safeWindow(event.text, request.start ?? 0, request.limit);
    return {ok: true, libraryId: context.scope.libraryId, ...window, speaker: event.speaker,
      title: event.title, time: event.time, reference};
  }
  async search(request, context) {
    const {scope, interactive = false, initiatorId, signal} = context;
    const terms = termsOf(request.query), cap = interactive ? request.limit : Math.min(6, request.limit);
    const topic = request.topicId ? scope.topics.find(topic => topic.id === request.topicId) : null;
    if (request.topicId && (!topic || (!interactive && topic.sessionId !== initiatorId))) throw fail('FORBIDDEN', 'Question is outside this conversation');
    const selected = new Set((topic?.references || []).map(referenceKey));
    const sessions = [...scope.sessions.values()].filter(row => interactive || row.sessionId !== initiatorId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
    const examined = sessions.slice(0, interactive ? 64 : 24);
    const examinedIds = new Set(examined.map(row => row.sessionId));
    const candidates = new Map();
    const add = (result, text, selectedReference = false) => {
      const score = relevance(text, request.query, terms, interactive);
      if (!score) return;
      const key = referenceKey(result.reference);
      candidates.set(key, {...result, score: score + (selectedReference || selected.has(key) ? 10 : 0)});
      if (result.reference.kind === 'note' && context.progress) context.progress.notes = [...candidates.values()]
        .filter(candidate => candidate.reference.kind === 'note').sort((a, b) => b.score - a.score).slice(0, cap)
        .map(({score, ...candidate}) => candidate);
      return true;
    };
    const notes = await this.notesSearch.execute({action: 'search', query: request.query, limit: 40, snippetLimit: 400});
    signal?.throwIfAborted();
    for (const note of notes.results || []) add({id: `note:${note.atomId}`, title: note.title,
      snippet: note.snippet, heading: note.heading, reference: {kind: 'note', atomId: note.atomId}}, `${note.title || ''}\n${note.snippet || ''}`);
    for (const reference of topic?.references || []) {
      signal?.throwIfAborted();
      if (reference.kind === 'discussion' && !examinedIds.has(reference.sessionId)) continue;
      try {
        const result = await this.read({reference, limit: 400}, context);
        add({id: referenceKey(reference), title: result.title || reference.label || topic.question,
          snippet: result.content, speaker: result.speaker, time: result.time, reference}, `${result.title || ''}\n${result.content}`, true);
      } catch (error) { await this.assertLibrary(scope.libraryId); if (signal?.aborted) throw error; }
    }
    const query = resolve(this.sessionQuery), access = resolve(this.remoteAccess);
    const discussionAvailable = Boolean(query?.searchEvents && query?.readEvent && (query?.listEvents || query?.readSurface) && access?.allows);
    let searched = 0, unavailable = 0, partialPages = 0;
    if (discussionAvailable) for (const session of examined) {
      signal?.throwIfAborted();
      try {
        await this.sessionAccess(session.sessionId, context);
        const page = await query.searchEvents({sessionId: session.sessionId, query: request.query,
          filters: [{kind: 'type', values: ['user/message', 'assistant/message']}, {kind: 'surface', values: ['current']}], limit: interactive ? 40 : 12}, {signal});
        observedSession(page, session.sessionId);
        searched++;
        if (page.hasMore) partialPages++;
        let sessionHits = 0;
        const perSessionBudget = interactive ? Math.min(request.limit, 8) : 2;
        for (const [itemIndex, item] of (page.items || []).entries()) {
          if (item.sessionId !== session.sessionId || item.surface !== 'current' || !['user/message', 'assistant/message'].includes(item.type)) continue;
          const reference = {kind: 'discussion', sessionId: session.sessionId, seq: item.seq};
          if (!Number.isSafeInteger(reference.seq) || reference.seq < 0) continue;
          try {
            const event = await this.visibleEvent(reference, context);
            if (add({id: referenceKey(reference), title: event.title, snippet: snippet(event.text, request.query),
              speaker: event.speaker, time: event.time, reference}, event.text) && ++sessionHits === perSessionBudget) {
              if (!page.hasMore && itemIndex + 1 < page.items.length) partialPages++;
              break;
            }
          } catch (error) { await this.assertLibrary(scope.libraryId); if (signal?.aborted) throw error; }
        }
      } catch (error) {
        await this.assertLibrary(scope.libraryId);
        if (signal?.aborted) throw error;
        unavailable++;
      }
    }
    const freshScope = await this.scope(scope.libraryId);
    this.authorizeInitiator(freshScope, initiatorId);
    const perSession = new Map(), results = [];
    for (const candidate of [...candidates.values()].sort((a, b) => b.score - a.score || String(b.time || '').localeCompare(String(a.time || '')) || a.id.localeCompare(b.id))) {
      if (candidate.reference.kind === 'discussion' && !freshScope.sessions.has(candidate.reference.sessionId)) continue;
      if (candidate.reference.kind === 'discussion' && !interactive) {
        const id = candidate.reference.sessionId, count = perSession.get(id) || 0;
        if (count === 2) continue;
        perSession.set(id, count + 1);
      }
      const {score, ...result} = candidate;
      results.push(result);
      if (results.length === cap) break;
    }
    signal?.throwIfAborted();
    return {ok: true, libraryId: scope.libraryId, results, discussionAvailable,
      coverage: {mode: 'lexical', sessionsBound: sessions.length, sessionsConsidered: examined.length, sessionsSearched: searched,
        sessionsUnavailable: unavailable, partialEventPages: partialPages,
        truncated: examined.length < sessions.length || partialPages > 0 || candidates.size > results.length,
        ...(!discussionAvailable ? {reason: !access?.allows ? 'authorization_unavailable' : 'session_query_unavailable'} : {})}};
  }
}
