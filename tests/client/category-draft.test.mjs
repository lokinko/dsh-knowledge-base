import test from 'node:test';
import assert from 'node:assert/strict';
import {NoteDraftCache, NoteEditSession} from '../../src/client/notes/edit-session.js';

test('a custom category survives durable offline recovery and saves without changing raw content', async () => {
  const data = new Map();
  const storage = {get length() { return data.size; }, key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key)};
  const cache = new NoteDraftCache({storageGetter: () => storage});
  const category = '725746f0-9cb7-48e7-afdc-510c2e1f9de8';
  const content = '# 文稿🙂\r\n  exact raw text\t\r\n';
  const note = {id: 'note-category-recovery', title: '草稿', content: '', category: 'document', tags: [], pinned: false,
    journalDate: '', revision: 3, updatedAt: '2026-01-01T00:00:00.000Z', trashedAt: ''};
  const options = {cache, setTimer: () => 1, clearTimer() {}};
  const offline = new NoteEditSession({...options, note, writerId: 'offline-writer', save: async () => {throw new Error('offline');}});
  offline.change({category, content});
  await offline.pause();
  const recoveredCache = new NoteDraftCache({storageGetter: () => storage});
  const draft = recoveredCache.latest(note.id);
  assert.equal(draft.fields.category, category);
  assert.equal(draft.fields.content, content);
  let saved;
  const restored = new NoteEditSession({...options, cache: recoveredCache, note, draft, paused: true,
    writerId: 'recovered-writer', save: async payload => {
      saved = payload;
      return {ok: true, note: {id: note.id, revision: 4, updatedAt: '2026-01-02T00:00:00.000Z'}};
    }});
  restored.start();
  assert.throws(() => restored.change({category: 'invalid/category'}), /Invalid note fields/);
  assert.equal(restored.snapshot().fields.category, category);
  assert.equal(await restored.flush(), true);
  assert.equal(saved.category, category);
  assert.equal(saved.content, content);
  assert.equal(recoveredCache.records().length, 0);
  await restored.stop();
});
