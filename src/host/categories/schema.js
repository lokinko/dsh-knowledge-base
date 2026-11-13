import { z } from 'zod';

export const builtinCategories = ['document', 'reading', 'code', 'journal'];
export const categoryIdSchema = z.union([z.enum(builtinCategories), z.string().uuid()]);
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nameSchema = z.string().trim().max(80);
const itemSchema = z.object({ id: categoryIdSchema, name: nameSchema,
  parentId: categoryIdSchema.nullable(), order: z.number().int().nonnegative() }).strict();

function validateTree(tree, ctx) {
  const issue = message => ctx.addIssue({ code: 'custom', message });
  const byId = new Map(tree.items.map(item => [item.id, item]));
  if (byId.size !== tree.items.length) issue('Duplicate category IDs');
  const redirects=new Map((tree.redirects||[]).map(item=>[item.id,item.targetId]));
  if(redirects.size!==(tree.redirects||[]).length)issue('Duplicate deleted category IDs');
  for(const [id,targetId] of redirects)if(byId.has(id)||!byId.has(targetId))issue('Invalid deleted category redirect');
  for (const id of builtinCategories) if (!byId.has(id)&&!redirects.has(id)) issue('Missing builtin category');
  const names = new Set();
  const orders = new Map();
  for (const item of tree.items) {
    if (!builtinCategories.includes(item.id) && !item.name) issue('Custom category name cannot be empty');
    if (item.parentId !== null && !byId.has(item.parentId)) issue('Category parent does not exist');
    if (item.name && !builtinCategories.includes(item.id)) {
      const key = JSON.stringify([item.parentId, item.name]);
      if (names.has(key)) issue('Duplicate sibling category name');
      names.add(key);
    }
    const siblings = orders.get(item.parentId) || [];
    siblings.push(item.order);
    orders.set(item.parentId, siblings);
    let current = item;
    const visited = new Set();
    let depth = 0;
    while (current) {
      if (visited.has(current.id)) { issue('Category cycle'); break; }
      visited.add(current.id);
      if (++depth > 8) { issue('Category depth exceeds 8'); break; }
      current = current.parentId === null ? null : byId.get(current.parentId);
    }
  }
  for (const values of orders.values()) {
    values.sort((a, b) => a - b);
    if (values.some((value, index) => value !== index)) issue('Sibling order must be contiguous');
  }
}
export const categoryTreeSchema = z.object({ id: z.literal('categories'), revision: revisionSchema,
  items: z.array(itemSchema).min(1).max(500),
  redirects:z.array(z.object({id:categoryIdSchema,targetId:categoryIdSchema}).strict()).max(10000).optional(),
}).strict().superRefine(validateTree);
export function categoryResolver(tree){const redirects=new Map((tree.redirects||[]).map(item=>[item.id,item.targetId]));return id=>redirects.get(id)||id;}
export const defaultCategoryTree = () => ({ id: 'categories', revision: 0,
  items: builtinCategories.map((id, order) => ({ id, name: '', parentId: null, order })) });
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('create'), revision: revisionSchema, name: nameSchema.min(1),
    parentId: categoryIdSchema.nullable().default(null) }).strict(),
  z.object({ action: z.literal('update'), revision: revisionSchema, id: categoryIdSchema, name: nameSchema }).strict(),
  z.object({ action: z.literal('move'), revision: revisionSchema, id: categoryIdSchema,
    parentId: categoryIdSchema.nullable().default(null), beforeId: categoryIdSchema.nullable().optional() }).strict(),
  z.object({ action:z.literal('delete'),revision:revisionSchema,id:categoryIdSchema }).strict(),
]);

export {actions as categoryActionSchema};
