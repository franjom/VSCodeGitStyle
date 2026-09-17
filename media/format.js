/*
 * Presentation decisions both webviews make and neither needs a document for:
 * how a timestamp reads, and where a popup has to sit to stay on screen.
 *
 * Kept apart from media/dom.js precisely so node can test it. Anything here
 * must stay free of the DOM.
 */
(function (scope) {
  'use strict';

  /**
   * A git timestamp as the user's own locale writes it, to the minute.
   *
   * Seconds are noise in a commit list, and the date and time are separated by
   * a space rather than run through toLocaleString so both halves keep the
   * user's format. A value git did not give us - or gave us in a shape Date
   * cannot read - is passed through untouched rather than rendered as
   * "Invalid Date".
   */
  function formatDate(iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) {
      return iso;
    }
    return (
      date.toLocaleDateString() +
      ' ' +
      date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    );
  }

  /** Margin kept between a popup and the edge of the window. */
  const EDGE = 4;

  /**
   * Where a popup of `size` goes when the pointer is at `at`.
   *
   * It opens down and to the right, which is what a pointer expects, and is
   * pulled back only as far as it must be to stay inside `viewport`. A popup
   * taller or wider than the window is pinned to the top left rather than
   * pushed off the other side, so its first entries stay reachable.
   */
  function menuPosition(at, size, viewport) {
    return {
      x: clampEdge(at.x, size.width, viewport.width),
      y: clampEdge(at.y, size.height, viewport.height),
    };
  }

  function clampEdge(at, size, available) {
    return Math.min(at, Math.max(0, available - size - EDGE));
  }

  const api = {
    formatDate: formatDate,
    menuPosition: menuPosition,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    scope.VsgFormat = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
