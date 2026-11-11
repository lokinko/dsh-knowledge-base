import test from 'node:test';
import assert from 'node:assert/strict';
import {groupLibraryNotes} from '../../src/client/studio/sections.js';

test('collection sections preserve server order without duplicating or mutating page records', () => {
  const notes = Object.freeze([
    Object.freeze({id: 'p2', pinned: true}), Object.freeze({id: 'n3'}),
    Object.freeze({id: 'p1', pinned: true}), Object.freeze({id: 'n2', pinned: false}),
  ]);
  const sections = groupLibraryNotes(notes);
  assert.deepEqual(sections.map(section => [section.key, section.notes.map(note => note.id)]), [
    ['pinned', ['p2', 'p1']], ['recent', ['n3', 'n2']],
  ]);
  assert.equal(new Set(sections.flatMap(section => section.notes)).size, notes.length);
  assert.deepEqual(notes.map(note => note.id), ['p2', 'n3', 'p1', 'n2']);
});

test('empty, pinned and trash pages expose only their actual records and section labels', () => {
  assert.deepEqual(groupLibraryNotes([]), []);
  const page = [{id: 'one', pinned: true}];
  assert.deepEqual(groupLibraryNotes(page, 'trash').map(section => section.key), ['trash']);
  assert.deepEqual(groupLibraryNotes(page, 'pinned').map(section => section.key), ['pinned']);
  assert.equal(groupLibraryNotes(page, 'reading')[0].notes[0], page[0]);
});
