// Group only the current server page; counts are never presented as whole-library totals.
export function groupLibraryNotes(notes, view = 'all') {
  if (!notes.length) return [];
  if (view === 'trash') return [{key: 'trash', label: 'nbTrash', notes: [...notes]}];
  if (view === 'pinned') return [{key: 'pinned', label: 'nbPinnedSection', notes: [...notes]}];
  const pinned = [], recent = [];
  for (const note of notes) (note.pinned ? pinned : recent).push(note);
  return [
    {key: 'pinned', label: 'nbPinnedSection', notes: pinned},
    {key: 'recent', label: 'nbRecentSection', notes: recent},
  ].filter(section => section.notes.length);
}
