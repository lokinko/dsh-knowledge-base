import { z } from 'zod';

const sessionSchema = z.string().min(1);
export const referenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('note'), atomId: z.string().min(1).max(4000), label: z.string().max(300).optional() }).strict(),
  z.object({ kind: z.literal('discussion'), sessionId: sessionSchema,
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), label: z.string().max(300).optional() }).strict(),
]);
export function referenceKey(reference) {
  return reference.kind === 'note' ? `note:${reference.atomId}` : `discussion:${reference.sessionId}:${reference.seq}`;
}
function uniqueReferences(references) {
  const seen = new Set();
  return references.filter(reference => {
    const key = referenceKey(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export {uniqueReferences};
