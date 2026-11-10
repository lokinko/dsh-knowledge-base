import assert from 'node:assert/strict';
import test from 'node:test';
import { NoteNavigation } from './note-navigation.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const tokens = [];
  const navigation = new NoteNavigation(() => {
    const token = `session-${tokens.length + 1}`;
    tokens.push(token);
    return token;
  });
  return { navigation, tokens };
}

// Data records only: no elements, rendering, React, or browser emulation.
function sessionRegistry() {
  const sessions = new Map();
  return {
    sessions,
    observe(entry) {
      if (entry === null) return null;
      if (!sessions.has(entry.token)) {
        sessions.set(entry.token, { active: true, draft: entry.draft ?? '' });
      }
      return sessions.get(entry.token);
    },
    stop(token) {
      sessions.get(token).active = false;
    },
    edit(token, draft) {
      const session = sessions.get(token);
      assert.equal(session?.active, true, 'the displayed editor session is usable');
      session.draft = draft;
    },
  };
}

const noteA = Object.freeze({ id: 'A', title: 'Alpha', body: 'A body' });
const noteB = Object.freeze({ id: 'B', title: 'Beta', body: 'B body' });

function openA(navigation, extra = {}) {
  return navigation.open(navigation.begin(), { note: noteA, ...extra });
}

test('initial state and rejected actions never call the token factory', () => {
  const { navigation, tokens } = fixture();
  assert.equal(navigation.intent, 0);
  assert.equal(navigation.current, null);
  assert.equal(navigation.accepts(0), true);
  assert.equal(navigation.accepts('0'), false);
  assert.equal(navigation.replace(undefined, { note: noteA }), null);
  assert.equal(navigation.closeFrom(undefined), false);
  assert.equal(navigation.keepCurrent('A'), null);
  assert.equal(navigation.open(-1, { note: noteA }), null);
  const first = navigation.begin();
  const second = navigation.begin();
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(navigation.current, null);
  assert.equal(navigation.accepts(first), false);
  assert.equal(navigation.accepts(second), true);
  assert.deepEqual(tokens, []);
});

test('stale asynchronous navigation replies are ignored without allocating tokens', async () => {
  const { navigation, tokens } = fixture();
  const a = deferred();
  const b = deferred();
  const ticketA = navigation.begin();
  const resultA = a.promise.then((note) => navigation.open(ticketA, { note }));
  const ticketB = navigation.begin();
  const resultB = b.promise.then((note) => navigation.open(ticketB, { note }));
  b.resolve(noteB);
  const displayedB = await resultB;
  a.resolve(noteA);
  assert.equal(await resultA, null);
  assert.deepEqual(navigation.current, displayedB);
  assert.equal(navigation.current.note, noteB);
  assert.equal(tokens.length, 1);
});

test('accepted entries and returned wrappers do not expose mutable navigation state', () => {
  const { navigation, tokens } = fixture();
  const draft = Object.freeze({ title: 'Unsaved', body: 'Draft body' });
  const entry = Object.freeze({
    note: noteA,
    draft,
    focusTitle: true,
    trashedNote: noteB,
    token: 'caller token',
    intent: -1,
  });
  const ticket = navigation.begin();
  const opened = navigation.open(ticket, entry);
  assert.equal(opened.token, 'session-1');
  assert.equal(opened.intent, ticket);
  assert.equal(opened.note, noteA);
  assert.equal(opened.draft, draft);
  assert.equal(opened.trashedNote, noteB);
  assert.equal(entry.token, 'caller token');
  opened.token = 'tampered';
  opened.note = noteB;
  const snapshot = navigation.current;
  snapshot.intent = -100;
  delete snapshot.draft;
  assert.equal(navigation.current.token, 'session-1');
  assert.equal(navigation.current.note, noteA);
  assert.equal(navigation.current.intent, ticket);
  assert.equal(navigation.current.draft, draft);
  assert.notEqual(navigation.current, navigation.current);

  const orphan = Object.freeze({ reason: 'deleted' });
  const replacement = Object.freeze({ orphan, draft, focusTitle: false });
  const replaced = navigation.replace('session-1', replacement);
  assert.equal(replaced.orphan, orphan);
  assert.equal(replaced.draft, draft);
  assert.equal(replaced.focusTitle, false);
  assert.equal(replaced.intent, ticket);
  assert.equal(replaced.token, 'session-2');
  assert.equal('note' in replaced, false);
  replaced.token = 'tampered again';
  assert.equal(navigation.current.token, 'session-2');
  assert.deepEqual(replacement, { orphan, draft, focusTitle: false });
  assert.equal(tokens.length, 2);
});

test('an A operation replaces A while preserving the pending B navigation ticket', async () => {
  const { navigation } = fixture();
  const a = openA(navigation);
  const operation = deferred();
  const fetchB = deferred();
  const operationResult = operation.promise.then((note) => navigation.replace(a.token, { note }));
  const ticketB = navigation.begin();
  const navigationResult = fetchB.promise.then((note) => navigation.open(ticketB, { note }));
  const updatedA = { ...noteA, title: 'Renamed A' };
  operation.resolve(updatedA);
  const replacement = await operationResult;
  assert.equal(replacement.note, updatedA);
  assert.notEqual(replacement.token, a.token);
  assert.equal(replacement.intent, ticketB);
  assert.equal(navigation.intent, ticketB);
  assert.equal(navigation.accepts(ticketB), true);
  fetchB.resolve(noteB);
  assert.equal((await navigationResult).note, noteB);
  assert.equal(navigation.current.note, noteB);
});

test('a failed B fetch leaves the fresh A replacement session usable', async () => {
  const { navigation, tokens } = fixture();
  const registry = sessionRegistry();
  const a = openA(navigation, { draft: 'A draft' });
  registry.observe(a);
  const operation = deferred();
  const fetchB = deferred();
  const ticketB = navigation.begin();
  const navigationResult = fetchB.promise.then(
    (note) => navigation.open(ticketB, { note }),
    () => null,
  );
  const operationResult = operation.promise.then((note) => {
    registry.stop(a.token);
    const replacement = navigation.replace(a.token, { note, draft: 'Recovered draft' });
    registry.observe(replacement);
    return replacement;
  });
  operation.resolve({ ...noteA, title: 'A operation completed' });
  const replacement = await operationResult;
  fetchB.reject(new Error('B fetch failed'));
  assert.equal(await navigationResult, null);
  assert.equal(navigation.current.note.id, 'A');
  assert.equal(navigation.current.token, replacement.token);
  assert.equal(registry.sessions.get(a.token).active, false);
  registry.edit(navigation.current.token, 'Continued editing A');
  assert.equal(registry.sessions.get(replacement.token).draft, 'Continued editing A');
  assert.equal(navigation.replace(a.token, { note: noteB }), null);
  assert.equal(navigation.replace(replacement.token, { note: noteA }).note.id, 'A');
  assert.equal(tokens.length, 3);
});

test('a late A operation cannot replace B after B is displayed', async () => {
  const { navigation, tokens } = fixture();
  const a = openA(navigation);
  const operation = deferred();
  const fetchB = deferred();
  const operationResult = operation.promise.then((note) => navigation.replace(a.token, { note }));
  const ticketB = navigation.begin();
  const navigationResult = fetchB.promise.then((note) => navigation.open(ticketB, { note }));
  fetchB.resolve(noteB);
  const b = await navigationResult;
  operation.resolve({ ...noteA, title: 'Too late' });
  assert.equal(await operationResult, null);
  assert.deepEqual(navigation.current, b);
  assert.equal(navigation.intent, ticketB);
  assert.equal(tokens.length, 2);
});

test('trashing A closes only A and preserves pending navigation to B', async () => {
  const { navigation, tokens } = fixture();
  const a = openA(navigation);
  const trashA = deferred();
  const fetchB = deferred();
  const trashResult = trashA.promise.then(() => navigation.closeFrom(a.token));
  const ticketB = navigation.begin();
  const navigationResult = fetchB.promise.then((note) => navigation.open(ticketB, { note }));
  trashA.resolve();
  assert.equal(await trashResult, true);
  assert.equal(navigation.current, null);
  assert.equal(navigation.intent, ticketB);
  assert.equal(navigation.accepts(ticketB), true);
  assert.equal(tokens.length, 1);
  fetchB.resolve(noteB);
  assert.equal((await navigationResult).note, noteB);
  assert.equal(navigation.closeFrom(a.token), false);
  assert.equal(navigation.current.note, noteB);
  assert.equal(tokens.length, 2);
});

test('a late A trash callback cannot close already displayed B', async () => {
  const { navigation } = fixture();
  const a = openA(navigation);
  const trashA = deferred();
  const trashResult = trashA.promise.then(() => navigation.closeFrom(a.token));
  const b = navigation.open(navigation.begin(), { note: noteB });
  trashA.resolve();
  assert.equal(await trashResult, false);
  assert.deepEqual(navigation.current, b);
});

test('explicit back clears the display and cancels pending navigation and operations', async () => {
  const { navigation, tokens } = fixture();
  const a = openA(navigation);
  const fetchB = deferred();
  const ticketB = navigation.begin();
  const navigationResult = fetchB.promise.then((note) => navigation.open(ticketB, { note }));
  assert.equal(navigation.back(), null);
  assert.equal(navigation.intent, ticketB + 1);
  assert.equal(navigation.current, null);
  assert.equal(navigation.accepts(ticketB), false);
  fetchB.resolve(noteB);
  assert.equal(await navigationResult, null);
  assert.equal(navigation.replace(a.token, { note: noteA }), null);
  assert.equal(navigation.closeFrom(a.token), false);
  assert.equal(navigation.back(), null);
  assert.equal(navigation.intent, ticketB + 2);
  assert.equal(tokens.length, 1);
});

test('clicking the current note keeps its token, draft, and session while cancelling B', async () => {
  const { navigation, tokens } = fixture();
  const registry = sessionRegistry();
  const draft = { title: 'Unsaved A', body: 'Keep this text' };
  const a = openA(navigation, { draft, focusTitle: true, trashedNote: noteB });
  const session = registry.observe(a);
  const fetchB = deferred();
  const ticketB = navigation.begin();
  const navigationResult = fetchB.promise.then((note) => navigation.open(ticketB, { note }));
  const kept = navigation.keepCurrent('A');
  assert.equal(kept.intent, ticketB + 1);
  assert.equal(navigation.intent, ticketB + 1);
  assert.equal(navigation.accepts(ticketB), false);
  assert.equal(kept.token, a.token);
  assert.equal(kept.note, noteA);
  assert.equal(kept.draft, draft);
  assert.equal(kept.focusTitle, true);
  assert.equal(kept.trashedNote, noteB);
  assert.equal(registry.observe(kept), session);
  kept.token = 'cannot mutate the stored token';
  assert.equal(navigation.current.token, a.token);
  fetchB.resolve(noteB);
  assert.equal(await navigationResult, null);
  registry.edit(a.token, 'Still editing the same session');
  assert.equal(registry.sessions.size, 1);
  assert.equal(tokens.length, 1);
});

test('keeping a different note has no counter, token, or pending-navigation effect', () => {
  const { navigation, tokens } = fixture();
  const a = openA(navigation);
  const ticketB = navigation.begin();
  assert.equal(navigation.keepCurrent('B'), null);
  assert.equal(navigation.intent, ticketB);
  assert.equal(navigation.accepts(ticketB), true);
  assert.deepEqual(navigation.current, a);
  assert.equal(tokens.length, 1);
});

test('cancellation keeps the complete displayed entry and creates no new sessions', async () => {
  const { navigation, tokens } = fixture();
  const registry = sessionRegistry();
  navigation.cancelPending();
  assert.equal(navigation.intent, 1);
  assert.equal(navigation.current, null);
  assert.equal(tokens.length, 0);
  const a = openA(navigation, { draft: 'Retain', focusTitle: true });
  const session = registry.observe(a);
  const fetchB = deferred();
  const ticketB = navigation.begin();
  const navigationResult = fetchB.promise.then((note) => navigation.open(ticketB, { note }));
  navigation.cancelPending();
  navigation.cancelPending();
  assert.equal(navigation.intent, ticketB + 2);
  assert.deepEqual(navigation.current, a);
  assert.equal(navigation.current.intent, a.intent);
  assert.equal(registry.observe(navigation.current), session);
  fetchB.resolve(noteB);
  assert.equal(await navigationResult, null);
  registry.edit(a.token, 'Editing survives cancellation');
  assert.equal(registry.sessions.size, 1);
  assert.equal(tokens.length, 1);
});

test('orphan entries cannot match keepCurrent through a missing note id', () => {
  const { navigation, tokens } = fixture();
  const orphan = navigation.open(navigation.begin(), { orphan: { body: 'Recovered body' } });
  const intent = navigation.intent;
  assert.equal(navigation.keepCurrent(undefined), null);
  assert.equal(navigation.keepCurrent('A'), null);
  assert.equal(navigation.intent, intent);
  assert.deepEqual(navigation.current, orphan);
  assert.equal(tokens.length, 1);
});

test('the default token factory generates fresh UUIDs on accepted open and replace', () => {
  const navigation = new NoteNavigation();
  const a = openA(navigation);
  const replacement = navigation.replace(a.token, { note: noteA });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(a.token, uuid);
  assert.match(replacement.token, uuid);
  assert.notEqual(a.token, replacement.token);
});
