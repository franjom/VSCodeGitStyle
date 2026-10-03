/*
 * The commit details' changes tree, kept free of the DOM so it can be fed
 * directly from tests. Loaded as a plain script by the webview (where it
 * defines `VsgDiffView`) and required as a module by tests/diffview.test.js.
 */
(function (scope) {
  'use strict';

  /**
   * Nests changed files on "/" for the Changes tree.
   *
   * Chains of directories with nothing else in them are joined into one node -
   * `src/main/business` rather than three rows each holding the next - which is
   * how Visual Studio keeps a deep project from pushing every file off the
   * right edge of the pane.
   */
  function buildFileTree(files) {
    const rootNode = { name: '', dirs: new Map(), files: [] };

    for (const file of files) {
      const segments = file.path.split('/');
      segments.pop();
      let node = rootNode;
      for (const segment of segments) {
        let next = node.dirs.get(segment);
        if (!next) {
          next = { name: segment, dirs: new Map(), files: [] };
          node.dirs.set(segment, next);
        }
        node = next;
      }
      node.files.push(file);
    }

    return flatten(rootNode, '');
  }

  /** Turns the nested map into the list of rows the tree draws, in order. */
  function flatten(node, keyPrefix) {
    const rows = [];
    const dirs = [...node.dirs.values()].sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    for (const dir of dirs) {
      // Walk through directories that hold nothing but one more directory, so
      // the row carries the whole run as a single label.
      const parts = [dir.name];
      let leaf = dir;
      while (leaf.files.length === 0 && leaf.dirs.size === 1) {
        leaf = [...leaf.dirs.values()][0];
        parts.push(leaf.name);
      }
      const key = keyPrefix + '/' + parts.join('/');
      // Depth is relative to this level; the recursion below shifts the
      // subtree down as it is spliced in.
      rows.push({ kind: 'dir', label: parts.join('/'), key: key, depth: 0 });
      for (const child of flatten(leaf, key)) {
        rows.push(Object.assign({}, child, { depth: child.depth + 1 }));
      }
    }

    const files = node.files.slice().sort(function (a, b) {
      return a.path.localeCompare(b.path);
    });
    for (const file of files) {
      rows.push({
        kind: 'file',
        label: file.path.split('/').pop(),
        file: file,
        depth: 0,
      });
    }

    return rows;
  }

  /**
   * Hides the rows under a collapsed directory. Kept apart from the tree build
   * so opening and closing a folder never has to walk the file list again.
   *
   * `prefix` scopes the keys when one set of closed keys serves several trees,
   * as the branch pane's does for every worktree: the same folder in two
   * worktrees is two rows, and shutting one must not shut the other.
   */
  function visibleTreeRows(rows, closed, prefix) {
    const scope = prefix || '';
    const out = [];
    let hiddenBelow = -1;
    for (const row of rows) {
      if (hiddenBelow >= 0) {
        if (row.depth > hiddenBelow) {
          continue;
        }
        hiddenBelow = -1;
      }
      out.push(row);
      if (row.kind === 'dir' && closed.has(scope + row.key)) {
        hiddenBelow = row.depth;
      }
    }
    return out;
  }

  const api = {
    buildFileTree: buildFileTree,
    visibleTreeRows: visibleTreeRows,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    scope.VsgDiffView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
