import { FileChange } from '../git/git';

export interface FolderNode {
  kind: 'folder';
  /** Stable identity for expand/collapse persistence: the full relative path. */
  key: string;
  /** Possibly a compressed chain, e.g. "Controllers\Api\WidgetSettings". */
  label: string;
  children: TreeNode[];
  fileCount: number;
}

export interface FileNode {
  kind: 'file';
  key: string;
  label: string;
  change: FileChange;
}

export type TreeNode = FolderNode | FileNode;

interface Builder {
  dirs: Map<string, Builder>;
  files: FileChange[];
}

/**
 * Builds the Changes tree the way Visual Studio renders it: folders first,
 * alphabetical, and single-child folder chains collapsed into one row
 * ("Mcs.Skzz.Api\Controllers\Api\WidgetSettings") so deep project layouts stay
 * readable.
 */
export function buildTree(changes: FileChange[], separator: string): TreeNode[] {
  const root: Builder = { dirs: new Map(), files: [] };

  for (const change of changes) {
    const segments = change.path.split('/');
    const fileName = segments.pop();
    if (!fileName) {
      continue;
    }
    let node = root;
    for (const segment of segments) {
      let next = node.dirs.get(segment);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push(change);
  }

  return materialize(root, '', separator);
}

function materialize(node: Builder, prefix: string, separator: string): TreeNode[] {
  const folders: FolderNode[] = [];

  for (const [name, child] of node.dirs) {
    let label = name;
    let key = prefix ? `${prefix}/${name}` : name;
    let current = child;

    // Collapse chains of folders that hold nothing but a single subfolder.
    while (current.files.length === 0 && current.dirs.size === 1) {
      const [onlyName, onlyChild] = [...current.dirs.entries()][0];
      label = `${label}${separator}${onlyName}`;
      key = `${key}/${onlyName}`;
      current = onlyChild;
    }

    const children = materialize(current, key, separator);
    folders.push({
      kind: 'folder',
      key,
      label,
      children,
      fileCount: countFiles(children),
    });
  }

  folders.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const files: FileNode[] = node.files
    .map((change) => ({
      kind: 'file' as const,
      key: change.path,
      label: change.path.split('/').pop() ?? change.path,
      change,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  return [...folders, ...files];
}

function countFiles(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += node.kind === 'file' ? 1 : node.fileCount;
  }
  return total;
}
