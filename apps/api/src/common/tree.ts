import { compareNumbered } from './collate';

export interface TreeNode<T> {
  item: T;
  depth: number;
  /** "Parent:Child" path of names. */
  fullName: string;
  children: TreeNode<T>[];
}

/**
 * Orders a parent/child list depth-first (parents before their children, siblings sorted), as
 * QuickBooks lists and reports display them. Orphans (parent missing) are treated as roots.
 */
export function buildTree<T extends { id: string; parent_id: string | null }>(
  items: T[],
  name: (item: T) => string,
  sortKey: (item: T) => string = name,
): TreeNode<T>[] {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) {
    const parent = item.parent_id && ids.has(item.parent_id) ? item.parent_id : null;
    const list = byParent.get(parent) ?? [];
    list.push(item);
    byParent.set(parent, list);
  }
  const build = (parent: string | null, depth: number, prefix: string): TreeNode<T>[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => compareNumbered(sortKey(a), sortKey(b)))
      .map((item) => {
        const fullName = prefix ? `${prefix}:${name(item)}` : name(item);
        return { item, depth, fullName, children: build(item.id, depth + 1, fullName) };
      });
  return build(null, 0, '');
}

export function flattenTree<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}
