import { randomUUID } from 'node:crypto';
import { builtinCategories, categoryTreeSchema, defaultCategoryTree, categoryActionSchema as actions } from './schema.js';
export { builtinCategories, categoryIdSchema, categoryTreeSchema, defaultCategoryTree } from './schema.js';

const failure = (code, message) => Object.assign(new Error(message), { code });

const clone = value => structuredClone(value);
const siblings = (items, parentId) => items.filter(item => item.parentId === parentId).sort((a, b) => a.order - b.order);
function normalize(items, parentId, ordered = siblings(items, parentId)) {
  ordered.forEach((item, order) => { item.order = order; });
}

/** A separate queue serializes category writes. Snapshots reserve their place immediately. */
export class CategoryStore {
  constructor(tableOrOptions) {
    this.table = tableOrOptions?.table ?? tableOrOptions;
    this.queue = Promise.resolve();
  }
  enqueue(operation) {
    const work = this.queue.then(operation).then(clone);
    this.queue = work.catch(() => {});
    return work;
  }
  async read() {
    const stored = await this.table.get('categories');
    return categoryTreeSchema.parse(stored == null ? defaultCategoryTree() : clone(stored));
  }
  snapshot() { return this.enqueue(() => this.read()); }
  execute(input) {
    let request;
    try { request = clone(input); } catch (error) { return Promise.reject(error); }
    return this.enqueue(async () => {
      const input = actions.parse(request);
      const tree = await this.read();
      if (input.action === 'list') return { ok: true, tree };
      if (tree.revision !== input.revision) throw failure('CONFLICT', 'Category tree changed elsewhere. Refresh and retry.');
      const previous = JSON.stringify(tree);
      const item = tree.items.find(item => item.id === input.id);
      if (input.action !== 'create' && !item) throw failure('NOT_FOUND', 'Category not found');
      if ((input.action === 'create' || input.action === 'move') && input.parentId !== null &&
        !tree.items.some(item => item.id === input.parentId)) throw failure('NOT_FOUND', 'Parent category not found');
      if (input.action === 'create') {
        tree.items.push({ id: randomUUID(), name: input.name, parentId: input.parentId,
          order: siblings(tree.items, input.parentId).length });
      } else if (input.action === 'update') {
        item.name = input.name;
      } else if(input.action==='delete'){
        if(tree.items.length===1)throw failure('LAST_CATEGORY','Keep at least one category for your notes');
        const children=siblings(tree.items,item.id),peers=siblings(tree.items,item.parentId);
        const promoted=peers.flatMap(peer=>peer.id===item.id?children:[peer]);
        for(const child of children)child.parentId=item.parentId;
        tree.items=tree.items.filter(value=>value.id!==item.id);
        normalize(tree.items,item.parentId,promoted);
        const targetId=item.parentId??siblings(tree.items,null)[0].id;
        tree.redirects=[...(tree.redirects||[]).map(value=>({...value,targetId:value.targetId===item.id?targetId:value.targetId})),{id:item.id,targetId}];
      } else {
        if (input.beforeId === item.id) throw failure('INVALID_REQUEST', 'Cannot move a category before itself');
        const target = input.beforeId == null ? null : tree.items.find(value => value.id === input.beforeId);
        if (input.beforeId != null && (!target || target.parentId !== input.parentId)) {
          throw failure('INVALID_REQUEST', 'beforeId must be a sibling in the destination parent');
        }
        const oldParent = item.parentId;
        const destination = siblings(tree.items, input.parentId).filter(value => value.id !== item.id);
        const index = target ? destination.findIndex(value => value.id === target.id) : destination.length;
        destination.splice(index, 0, item);
        item.parentId = input.parentId;
        normalize(tree.items, oldParent);
        normalize(tree.items, input.parentId, destination);
      }
      categoryTreeSchema.parse(tree);
      if (JSON.stringify(tree) === previous) return { ok: true, tree };
      tree.revision++;
      const validated = categoryTreeSchema.parse(tree);
      await this.table.put('categories', clone(validated));
      return { ok: true, tree: validated };
    });
  }
}
