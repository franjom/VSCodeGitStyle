'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatDate, menuPosition } = require('../media/format.js');

// --------------------------------------------------------------------- dates
//
// The output is the user's locale, so these assert what must hold in every
// locale rather than one machine's punctuation.

test('a git timestamp renders with its own date and time', () => {
  const out = formatDate('2026-09-17T14:35:00+02:00');
  assert.match(out, /2026/, 'the year is there');
  assert.match(out, /\d/, 'and so is a time');
  assert.equal(out.split(' ').length >= 2, true, 'date and time are separated');
});

test('seconds are dropped, because a commit list has no use for them', () => {
  const at = new Date('2026-09-17T14:35:59Z');
  const withSeconds = at.toLocaleTimeString();
  const out = formatDate(at.toISOString());
  // Only meaningful where the locale would have shown them.
  if (/59/.test(withSeconds)) {
    assert.ok(!out.includes('59'), 'the seconds are not carried through: ' + out);
  }
});

test('two different instants do not render the same', () => {
  assert.notEqual(
    formatDate('2026-09-17T14:35:00Z'),
    formatDate('2026-09-18T09:05:00Z')
  );
});

test('a value Date cannot read is passed through untouched', () => {
  // Better a raw string in the column than the words "Invalid Date".
  assert.equal(formatDate('not a date'), 'not a date');
  assert.equal(formatDate(''), '');
});

// --------------------------------------------------------------- menu placing

const VIEW = { width: 1000, height: 800 };
const SIZE = { width: 200, height: 300 };

test('a menu with room opens exactly at the pointer', () => {
  assert.deepEqual(menuPosition({ x: 100, y: 120 }, SIZE, VIEW), { x: 100, y: 120 });
});

test('a menu near the right edge is pulled back inside', () => {
  const at = menuPosition({ x: 950, y: 120 }, SIZE, VIEW);
  assert.equal(at.x, 796, 'flush against the edge, less the margin');
  assert.ok(at.x + SIZE.width <= VIEW.width, 'and wholly on screen');
});

test('a menu near the bottom edge is pulled up inside', () => {
  const at = menuPosition({ x: 100, y: 780 }, SIZE, VIEW);
  assert.ok(at.y + SIZE.height <= VIEW.height);
});

test('a corner pulls the menu back on both axes at once', () => {
  const at = menuPosition({ x: 990, y: 790 }, SIZE, VIEW);
  assert.ok(at.x + SIZE.width <= VIEW.width);
  assert.ok(at.y + SIZE.height <= VIEW.height);
});

test('a menu taller than the window is pinned to the top, not pushed off it', () => {
  // Its first entries have to stay reachable; sliding it up would hide them.
  const at = menuPosition({ x: 10, y: 400 }, { width: 200, height: 2000 }, VIEW);
  assert.equal(at.y, 0);
});

test('a menu wider than the window is pinned to the left', () => {
  const at = menuPosition({ x: 400, y: 10 }, { width: 4000, height: 100 }, VIEW);
  assert.equal(at.x, 0);
});

test('the pointer position is never overshot downward or rightward', () => {
  // Opening down and to the right is what a pointer expects; the clamp may pull
  // the menu back, never push it further along.
  for (const x of [0, 5, 300, 799, 900, 1200]) {
    const at = menuPosition({ x: x, y: x }, SIZE, VIEW);
    assert.ok(at.x <= x, 'x never moves right of the pointer at ' + x);
    assert.ok(at.y <= x, 'y never moves below the pointer at ' + x);
  }
});
