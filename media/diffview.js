/*
 * The arithmetic behind the commit details pane, kept free of the DOM so it can
 * be fed directly from tests. Loaded as a plain script by the webview (where it
 * defines `VsgDiffView`) and required as a module by tests/diffview.test.js.
 */
(function (scope) {
  'use strict';

  /** Rows of unchanged context kept on each side of a change when collapsing. */
  const KEEP_CONTEXT = 12;

  function isChanged(row) {
    return row.kind === 'add' || row.kind === 'del' || row.kind === 'change';
  }

  /**
   * Caps how many rows the view has to build.
   *
   * A whole-file diff is what makes the two sides read as documents, but a very
   * long file would put tens of thousands of rows in the DOM for the sake of a
   * few changed lines. Past `maxRows` the unchanged stretches far from any
   * change collapse into the same gap rows the parser already emits when git
   * elides a region, so the view has one shape to draw either way.
   *
   * A diff already within the cap is returned untouched - the common case, and
   * the one where every line of context is worth keeping.
   */
  function collapseRows(rows, maxRows) {
    const limit = Math.max(1, maxRows || 0);
    if (rows.length <= limit) {
      return rows;
    }

    const keep = new Array(rows.length).fill(false);
    for (let i = 0; i < rows.length; i++) {
      if (!isChanged(rows[i])) {
        continue;
      }
      const from = Math.max(0, i - KEEP_CONTEXT);
      const to = Math.min(rows.length - 1, i + KEEP_CONTEXT);
      for (let j = from; j <= to; j++) {
        keep[j] = true;
      }
    }

    const out = [];
    let skipped = 0;
    for (let i = 0; i < rows.length; i++) {
      if (keep[i]) {
        if (skipped > 0) {
          out.push(gapRow(skipped));
          skipped = 0;
        }
        out.push(rows[i]);
        continue;
      }
      // A gap row the parser produced stands for lines git never sent, so its
      // own count has to survive the collapse rather than being counted as one.
      skipped += rows[i].kind === 'gap' ? rows[i].skipped || 0 : 1;
    }
    if (skipped > 0) {
      out.push(gapRow(skipped));
    }
    return out;
  }

  function gapRow(skipped) {
    return {
      kind: 'gap',
      oldNo: null,
      newNo: null,
      oldText: null,
      newText: null,
      skipped: skipped,
    };
  }

  /**
   * The row index that starts each run of changed rows, which is what the ↑ and
   * ↓ buttons step between and what "N changes" counts. A run is broken by any
   * unchanged row, gaps included, so two edits either side of elided context
   * count as two.
   */
  function changeAnchors(rows) {
    const anchors = [];
    let inRun = false;
    for (let i = 0; i < rows.length; i++) {
      const changed = isChanged(rows[i]);
      if (changed && !inRun) {
        anchors.push(i);
      }
      inRun = changed;
    }
    return anchors;
  }

  /**
   * Which change the view is sitting on, given the first row on screen.
   *
   * Returns the index into `anchors` of the last change at or above that row,
   * so scrolling through a file keeps the "3 of 7" counter honest without the
   * ↑ ↓ buttons having to own the position. -1 means the view is above the
   * first change.
   */
  function currentAnchor(anchors, firstVisibleRow) {
    let found = -1;
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i] <= firstVisibleRow) {
        found = i;
      } else {
        break;
      }
    }
    return found;
  }

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
   */
  function visibleTreeRows(rows, closed) {
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
      if (row.kind === 'dir' && closed.has(row.key)) {
        hiddenBelow = row.depth;
      }
    }
    return out;
  }

  const api = {
    collapseRows: collapseRows,
    changeAnchors: changeAnchors,
    currentAnchor: currentAnchor,
    buildFileTree: buildFileTree,
    visibleTreeRows: visibleTreeRows,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    scope.VsgDiffView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
