import {createHash, randomUUID} from 'node:crypto';
import {apply} from '../../src/host/index.js';

/** Real Host services backed only by private memory fixtures. */
export async function createFixtureHost({discussions = false} = {}) {
  const tables = new Map(), routes = new Map(), tools = new Map(), effects = [], blobs = new Map();
  const events = new Map(), surfaces = new Map(), denied = new Set(), services = new Map();
  const sessionCreations = [], mutations = [], requests = [], queryCalls = [], readCalls = [], accessCalls = [];
  let initiator = 'fixture-session';
  const agents = {requireInitiator() { return {id: initiator}; }};
  const sessionController = {async create(input) {
    const sessionId = randomUUID();
    sessionCreations.push({sessionId, input: structuredClone(input)});
    events.set(sessionId, []);
    return {sessionId};
  }};
  const rows = id => (events.get(id) || []).map(event => ({sessionId: id, seq: event.seq, type: event.type, time: event.time, surface: surfaces.get(`${id}:${event.seq}`) || 'current'}));
  // This is only a lexical stand-in for the native query service. Real Host
  // binding, authorization, current-surface and source-role checks remain active.
  // Return noisy matching rows too, so the production aggregator must re-read
  // eligible messages instead of trusting an index snippet or filter request.
  const sessionQuery = {
    async searchEvents(request, {signal} = {}) {
      signal?.throwIfAborted();queryCalls.push(structuredClone(request));
      const query = String(request.query).normalize('NFKC').toLowerCase();
      const matching = new Set((events.get(request.sessionId) || []).filter(event => JSON.stringify(event.data).normalize('NFKC').toLowerCase().includes(query)).map(event => event.seq));
      return {session: {id: request.sessionId}, items: rows(request.sessionId).filter(row => matching.has(row.seq)).map(row => ({...row, snippet: 'UNTRUSTED FIXTURE INDEX SUMMARY'})), hasMore: false};
    },
    async listEvents(id) { return structuredClone(rows(id)); },
    async readEvent(request, signal) {
      signal?.throwIfAborted();readCalls.push(structuredClone(request));
      return {session: {id: request.sessionId}, target: structuredClone(events.get(request.sessionId)?.find(event => event.seq === request.seq)), events: []};
    },
  };
  const remoteAccess = {async allows(target) { accessCalls.push(structuredClone(target));return target.kind === 'session' && events.has(target.id) && !denied.has(target.id); }};
  services.set('agents', agents);services.set('sessionController', sessionController);
  if (discussions) { services.set('sessionQuery', sessionQuery);services.set('remoteAccess', remoteAccess); }
  const ctx = {
    get(name) { return services.get(name); },
    storageDomain: {async open(spec) {
      return {
        table(name) {
          if (!tables.has(name)) tables.set(name, new Map());
          const rows = tables.get(name);
          return {
            get: key => structuredClone(rows.get(key)),
            entries: () => structuredClone([...rows]),
            async put(key, value) { rows.set(key, spec.tables[name].valueSchema.parse(structuredClone(value)));mutations.push({table: name, action: 'put', key}); },
            async delete(key) { rows.delete(key);mutations.push({table: name, action: 'delete', key}); },
          };
        },
        async close() {},
      };
    }},
    attachments: {
      async saveFileStream({data, name, signal}) {
        const chunks = [];
        for await (const chunk of data) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
        const bytes = Buffer.concat(chunks), attachmentId = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
        blobs.set(attachmentId, bytes);
        return {attachmentId, name, bytes: bytes.length};
      },
      async *readFileStream(ref) { yield blobs.get(ref.attachmentId); },
      fileHostPath() { return undefined; },
    },
    connection: {fetch: {register(route) { routes.set(route.path, route); return () => routes.delete(route.path); }}},
    tools: {register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); }},
    effect(fn) { effects.push(fn()); },
    inject(keys, callback) { callback({...ctx,
      sessionController,
      agents,
      systemPrompt: {section() { return () => {}; }},
    }); },
  };
  await apply(ctx);
  const fixtures = [
    {title: '让想法慢慢成形', category: 'document', pinned: true, tags: ['随想', '写作'], content: '# 留住那些微小的想法\n\n不必急着把每个念头写成答案。先记下来，再在日后的阅读中，看见它们之间的联系。\n\n## 给自己留一点余地\n\n- [ ] 整理本周的阅读笔记\n- [x] 写下一个值得继续的问题\n\n> 好的记录，让下一次思考有迹可循。\n\n把零散的片段放在一起，让想法慢慢成形。'},
    {title: '玻璃的边界', category: 'reading', tags: ['设计', '阅读'], content: '真正的轻盈，来自清晰的层次。\n\n记录一段阅读：材质的表达，藏在光线经过边缘的地方。'},
    {title: '一个安静的工作台', category: 'document', tags: ['日常'], content: '把常用的东西放在触手可及的地方。其余的，留给空白。\n\n今天试着减少切换，完成一件有始有终的小事。'},
    {title: '异步任务的几个约定', category: 'code', tags: ['JavaScript'], content: '## 一个小例子\n\n```js\nconst result = await readNote(id);\nif (isCurrent(id)) render(result);\n```\n\n先确认上下文，再接收结果。'},
    {title: '十一月，留一点空白', category: 'journal', journalDate: '2026-11-10', tags: ['生活'], content: '窗边的光线慢慢移动。\n\n把今天读到的一句话、走过的一条路，以及还没想清楚的事，留在这里。'},
    {title: '读书时记下的句子', category: 'reading', tags: ['摘录'], content: '阅读不是收集答案，而是找到值得带走的问题。\n\n下一次回来，试着用自己的语言重新描述。'},
  ];
  const notes = [];
  for (const fields of fixtures) notes.push((await tools.get('manage_notes').execute({action: 'create', ...fields})).note);
  let discussionSeed = null;
  if (discussions) {
    const query = '青岚校验灯', originals = new Map(), bindings = [], sourceTexts = new Map();
    for (const [index, label] of ['A', 'B'].entries()) {
      const previous = await tools.get('manage_notes').execute({action: 'get', id: notes[index].id});
      const content = `# 私有笔记来源${label}\r\n\r\n${query}：笔记${label}的原始材料🙂。\r\n\r\n` + previous.note.content;
      notes[index] = (await tools.get('manage_notes').execute({action: 'update', id: notes[index].id, revision: previous.note.revision, content})).note;
      originals.set(notes[index].id, content);
      const started = await tools.get('manage_note_chat').execute({action: 'start', noteId: notes[index].id});
      if (!started.ok || !started.binding) throw new Error('Could not seed a private note discussion');
      const {sessionId} = started.binding;bindings.push(started.binding);
      const time = seq => `2026-11-11T01:00:${String(index * 10 + seq).padStart(2, '0')}Z`;
      const userText = `${query}：用户在讨论${label}提出的问题。\r\n原样保留🙂。`;
      const assistantText = `${query}：助手在讨论${label}给出的说明。\n第二段原文。`;
      sourceTexts.set(`${sessionId}:0`, userText);sourceTexts.set(`${sessionId}:1`, assistantText);
      events.set(sessionId, [
        {seq: 0, time: time(0), type: 'user/message', data: {source: {kind: 'user'}, content: [{type: 'text', text: userText}, {type: 'image', image: 'PRIVATE IMAGE PAYLOAD'}]}},
        {seq: 1, time: time(1), type: 'assistant/message', data: {message: {content: [{type: 'reasoning', text: query + ' PRIVATE REASONING'}, {type: 'text', text: assistantText.split('\n')[0]}, {type: 'tool-call', name: 'PRIVATE TOOL CALL'}, {type: 'text', text: '第二段原文。'}]}}},
        {seq: 2, time: time(2), type: 'user/message', data: {source: {kind: 'system'}, content: [{type: 'text', text: query + ' PRIVATE SYSTEM SOURCE'}]}},
        {seq: 3, time: time(3), type: 'tool/result', data: {content: [{type: 'text', text: query + ' PRIVATE TOOL RESULT'}]}},
        {seq: 4, time: time(4), type: 'assistant/message', data: {message: {content: [{type: 'reasoning', text: query + ' PRIVATE REASONING ONLY'}]}}},
        {seq: 5, time: time(5), type: 'user/message', data: {source: {kind: 'user'}, content: [{type: 'text', text: query + ' PRIVATE SHADOWED'}]}},
        {seq: 6, time: time(6), type: 'user/message', data: {source: {kind: 'user'}, content: [{type: 'text', text: query + ' PRIVATE LOG ONLY'}]}},
        {seq: 7, time: time(7), type: 'system/message', data: {text: query + ' PRIVATE SYSTEM MESSAGE'}},
        {seq: 8, time: time(8), type: 'event/ignored', data: {text: query + ' PRIVATE IGNORED EVENT'}},
      ]);
      surfaces.set(`${sessionId}:5`, 'shadowed');surfaces.set(`${sessionId}:6`, 'log-only');
    }
    discussionSeed = {query, originals, bindings, sourceTexts};
  }
  return {
    notes, discussionSeed, mutations, requests, sessionCreations,
    native: {events, surfaces, denied, services, queryCalls, readCalls, accessCalls, sessionQuery, setInitiator(id) { initiator = id; }},
    async api(path, input) {
      const route = routes.get('/api/dsh-note/' + path);
      if (!route) throw new Error('Unknown fixture route: ' + path);
      const response = await route.fetch(new Request('https://notebook.test/api/dsh-note/' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)}));
      const result = await response.json();
      if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || 'Fixture request failed'), {code: result.code, status: response.status});
      return result;
    },
    async tool(name, input) { return tools.get(name).execute(input); },
    async fetch(url, {method = 'GET', headers = {}, body} = {}) {
      const pathname = new URL(url).pathname, route = routes.get(pathname);
      requests.push({method, path: pathname});
      if (!route) return new Response('Not found', {status: 404});
      return route.fetch(new Request(url, {method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : {body})}));
    },
    async close() { for (const effect of effects.reverse()) await (await effect)?.(); },
  };
}
