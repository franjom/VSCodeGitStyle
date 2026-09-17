/*
 * The arithmetic behind the Git Repository window's commit list: where a lane
 * sits, how wide the graph column has to be, which commits a filter leaves, and
 * which refs survive the chip cap.
 *
 * Kept free of the DOM so it can be fed directly from tests. Loaded as a plain
 * script by the webview (where it defines `VsgGraphView`) and required as a
 * module by tests/graphview.test.js.
 */
(function (scope) {
  'use strict';

  /** Left margin before the first lane, and after the last one. */
  const EDGE = 8;
  const TAIL = 10;

  /** Narrowest the graph column is ever drawn, so a linear history still reads. */
  const MIN_WIDTH = 28;

  /** The x of a lane's centre line, in the row's own coordinates. */
  function laneX(lane, laneWidth) {
    return EDGE + lane * laneWidth;
  }

  /**
   * How wide the graph column has to be for a history this busy. Set as a CSS
   * variable on the grid: too narrow and the widest row's lanes are clipped by
   * the template.
   */
  function graphWidth(maxLanes, laneWidth) {
    return Math.max(laneX(maxLanes - 1, laneWidth) + TAIL, MIN_WIDTH);
  }

  /**
   * The CSS variable holding a lane's colour, cycled through the palette.
   *
   * The double modulo is not redundant: a negative index - which a malformed
   * layout could produce - would otherwise index backwards out of the palette
   * and name a variable that does not exist, leaving the line invisible.
   */
  function laneColor(index, paletteSize) {
    return 'var(--vsg-lane-' + (((index % paletteSize) + paletteSize) % paletteSize) + ')';
  }

  /**
   * Whether a commit survives the history filter. Subject, author and hash are
   * all matched, so a filter is equally a search for "who" and for "which".
   * Matching is case-insensitive, and an empty filter keeps everything.
   */
  function matchesFilter(commit, filter) {
    const needle = (filter || '').trim().toLowerCase();
    if (!needle) {
      return true;
    }
    return (
      commit.subject.toLowerCase().indexOf(needle) !== -1 ||
      commit.author.toLowerCase().indexOf(needle) !== -1 ||
      commit.hash.toLowerCase().indexOf(needle) !== -1
    );
  }

  /** Ranked so the checked-out branch and tags survive the cap ahead of the rest. */
  const RANK = { current: 0, local: 1, tag: 2, remote: 3 };

  /**
   * Sorts a commit's decorations and splits them at the chip cap.
   *
   * A commit that several branches point at would otherwise fill the Branch/Tag
   * column, so only the first few are shown and the rest are folded into a
   * "+n". Which few matters: the remote-tracking refs are the least interesting
   * to see here, and they are the ones that multiply, so they rank last and are
   * dropped first.
   */
  function rankRefs(refs, maxChips) {
    const classified = (refs || []).map(classifyRef).sort(function (a, b) {
      return RANK[a.kind] - RANK[b.kind];
    });
    return {
      shown: classified.slice(0, maxChips),
      hidden: classified.slice(maxChips).map(function (entry) {
        return entry.raw;
      }),
    };
  }

  /**
   * What git's decoration string means. "HEAD -> main" is the checked-out
   * branch, "tag: v1.2" a tag, and a remaining name with a slash in it is
   * remote-tracking - there being no other way to tell from the decoration
   * alone, and a local branch with a slash reading as remote is a cosmetic
   * misranking rather than a wrong label.
   */
  function classifyRef(raw) {
    if (raw.indexOf('HEAD -> ') === 0) {
      return { raw: raw, label: raw.substring(8), kind: 'current' };
    }
    if (raw === 'HEAD') {
      return { raw: raw, label: raw, kind: 'current' };
    }
    if (raw.indexOf('tag: ') === 0) {
      return { raw: raw, label: raw.substring(5), kind: 'tag' };
    }
    return { raw: raw, label: raw, kind: raw.indexOf('/') !== -1 ? 'remote' : 'local' };
  }

  /**
   * Nests refs on "/" so feature/x sits under a "feature" node.
   *
   * `displayOf` gives the path to nest by, which lets origin/feature/x nest
   * under the remote's own node while the leaf keeps its real ref name for
   * checkout.
   */
  function nestRefs(refs, displayOf) {
    const tree = { dirs: new Map(), leaves: [] };
    for (const ref of refs) {
      const segments = displayOf(ref).split('/');
      const name = segments.pop();
      let node = tree;
      for (const segment of segments) {
        let next = node.dirs.get(segment);
        if (!next) {
          next = { dirs: new Map(), leaves: [] };
          node.dirs.set(segment, next);
        }
        node = next;
      }
      node.leaves.push({ ref: ref, name: name });
    }
    return tree;
  }

  const api = {
    laneX: laneX,
    graphWidth: graphWidth,
    laneColor: laneColor,
    matchesFilter: matchesFilter,
    rankRefs: rankRefs,
    classifyRef: classifyRef,
    nestRefs: nestRefs,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    scope.VsgGraphView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
