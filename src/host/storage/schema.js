import { z } from 'zod';

export const NOTE_STORAGE_CONTROL_KEY = 'state';
export const noteStorageControlSchema = z.object({
  libraryId: z.string().uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  directory: z.string(),
  generation: z.union([z.literal(''), z.string().uuid()]),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict().refine(value => Boolean(value.directory) === Boolean(value.generation), 'Invalid storage pointer');

