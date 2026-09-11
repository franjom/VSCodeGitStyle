'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { visibleRange } = require('../media/virtual.js');

const ROW = 22;

function range(options) {
  return visibleRange(
    Object.assign({ rowHeight: ROW, overscan: 0, offset: 0, scrollTop: 0, viewportHeight: 0 }, options)
  );
}

test('an unscrolled viewport starts at the first row', function () {
  assert.deepStrictEqual(range({ total: 100, viewportHeight: 220 }), { start: 0, end: 10 });
});

test('a row only partly in view is still rendered at both edges', function () {
  // Scrolled by half a row: row 0 is still half visible at the top and the row
  // after the last whole one is half visible at the bottom.
  const r = range({ total: 100, scrollTop: 11, viewportHeight: 220 });
  assert.strictEqual(r.start, 0);
  assert.strictEqual(r.end, 11);
});

test('overscan widens the range without leaving the list', function () {
  const r = range({ total: 100, scrollTop: 22 * 20, viewportHeight: 220, overscan: 5 });
  assert.deepStrictEqual(r, { start: 15, end: 35 });

  // Clamped at the top, where the overscan would run past row zero.
  assert.deepStrictEqual(range({ total: 100, viewportHeight: 220, overscan: 5 }), {
    start: 0,
    end: 15,
  });
});

test('the range never runs past the end of the list', function () {
  const r = range({ total: 30, scrollTop: 22 * 25, viewportHeight: 220, overscan: 5 });
  assert.strictEqual(r.end, 30);
  assert.ok(r.start >= 0 && r.start <= r.end);
});

test('a region below the viewport renders nothing', function () {
  // The region starts 5000px down; the viewport has not reached it.
  assert.deepStrictEqual(range({ total: 100, offset: 5000, viewportHeight: 600 }), {
    start: 0,
    end: 0,
  });
});

test('a region scrolled past above the viewport renders nothing', function () {
  const r = range({ total: 100, offset: 0, scrollTop: 10000, viewportHeight: 600 });
  assert.strictEqual(r.start, 100);
  assert.strictEqual(r.end, 100);
});

test('the offset shifts the range by whole rows', function () {
  // A region that begins one group header (22px) down should show the same
  // rows as an unshifted one scrolled 22px less.
  const shifted = range({ total: 100, offset: 22, scrollTop: 22 * 11, viewportHeight: 220 });
  const plain = range({ total: 100, offset: 0, scrollTop: 22 * 10, viewportHeight: 220 });
  assert.deepStrictEqual(shifted, plain);
});

test('an empty region yields an empty range', function () {
  assert.deepStrictEqual(range({ total: 0, viewportHeight: 600 }), { start: 0, end: 0 });
});

test('a viewport taller than the list renders all of it', function () {
  assert.deepStrictEqual(range({ total: 12, viewportHeight: 2000 }), { start: 0, end: 12 });
});

test('a viewport of unknown height still renders the rows at the scroll position', function () {
  // Height 0 happens when the pane has not been laid out yet. Overscan is what
  // keeps something on screen until the resize arrives.
  const r = range({ total: 100, scrollTop: 22 * 40, viewportHeight: 0, overscan: 8 });
  assert.deepStrictEqual(r, { start: 32, end: 48 });
});

test('a row height of zero renders the whole list rather than none of it', function () {
  assert.deepStrictEqual(
    visibleRange({ total: 50, rowHeight: 0, scrollTop: 0, offset: 0, viewportHeight: 600 }),
    { start: 0, end: 50 }
  );
});

test('padding above and below always accounts for every row', function () {
  // The invariant the scrollbar depends on: hidden rows above, rendered rows,
  // and hidden rows below add up to the whole list at any scroll position.
  const total = 500;
  for (let scrollTop = 0; scrollTop < total * ROW; scrollTop += 137) {
    const r = range({ total: total, scrollTop: scrollTop, viewportHeight: 480, overscan: 8 });
    assert.strictEqual(r.start + (r.end - r.start) + (total - r.end), total);
    assert.ok(r.start <= r.end, 'start ' + r.start + ' must not pass end ' + r.end);
  }
});

test('every row is covered as the viewport walks the list', function () {
  // Scrolling a row at a time must never skip a row: each row has to be inside
  // the range while it is on screen.
  const total = 200;
  const viewportHeight = 10 * ROW;
  for (let i = 0; i + 10 <= total; i++) {
    const r = range({ total: total, scrollTop: i * ROW, viewportHeight: viewportHeight });
    for (let onScreen = i; onScreen < i + 10; onScreen++) {
      assert.ok(
        onScreen >= r.start && onScreen < r.end,
        'row ' + onScreen + ' is on screen at scroll ' + i + ' but outside [' + r.start + ',' + r.end + ')'
      );
    }
  }
});
