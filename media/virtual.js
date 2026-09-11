/*
 * The windowing arithmetic for the commit graph, kept free of the DOM so it can
 * be fed directly from tests. Loaded as a plain script by the webview (where it
 * defines `VsgVirtual`) and required as a module by tests/virtual.test.js.
 */
(function (scope) {
  'use strict';

  /**
   * Which slice of a region of equal-height rows has to exist in the DOM.
   *
   * `offset` is where the region starts inside the scrolled content, so a
   * region sitting below a group header still measures its own rows from zero.
   * The returned range is always a valid slice of [0, total]: a region scrolled
   * entirely out of view yields an empty one, and `end` is exclusive.
   *
   * `overscan` rows are kept on each side so a scroll of a row or two does not
   * expose an empty band before the next frame refills it.
   */
  function visibleRange(options) {
    const total = Math.max(0, options.total || 0);
    const rowHeight = options.rowHeight;
    const overscan = Math.max(0, options.overscan || 0);

    // A row height of zero would divide the viewport into infinitely many rows.
    // It only happens if the stylesheet has not applied yet, and rendering the
    // whole list is the safe answer rather than rendering none of it.
    if (!(rowHeight > 0)) {
      return { start: 0, end: total };
    }

    const top = (options.scrollTop || 0) - (options.offset || 0);
    const bottom = top + Math.max(0, options.viewportHeight || 0);

    const start = clamp(Math.floor(top / rowHeight) - overscan, 0, total);
    const end = clamp(Math.ceil(bottom / rowHeight) + overscan, start, total);
    return { start: start, end: end };
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  const api = { visibleRange: visibleRange };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    scope.VsgVirtual = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
