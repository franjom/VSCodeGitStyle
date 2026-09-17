'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  widestLine,
  changeAnchors,
  currentAnchor,
  buildFileTree,
  visibleTreeRows,
} = require('../media/diffview.js');

function same(n) {
  return { kind: 'same', oldNo: n, newNo: n, oldText: 'l' + n, newText: 'l' + n };
}
function change(n) {
  return { kind: 'change', oldNo: n, newNo: n, oldText: 'a', newText: 'b' };
}
function gap(skipped) {
  return { kind: 'gap', oldNo: null, newNo: null, oldText: null, newText: null, skipped: skipped };
}

// ------------------------------------------------------------ column width

test('the widest line decides the column width', () => {
  assert.equal(widestLine(['ab', 'abcdef', 'abc'], 4), 6);
});

test('a tab advances to the next stop rather than counting as one', () => {
  assert.equal(widestLine(['	x'], 4), 5, 'tab fills to column 4, then x');
  assert.equal(widestLine(['ab	x'], 4), 5, 'a tab at column 2 still lands on 4');
  assert.equal(widestLine(['abcd	x'], 4), 9, 'a tab on a stop advances a whole one');
});

test('blank and missing lines do not count', () => {
  assert.equal(widestLine(['', null, 'abc'], 4), 3);
  assert.equal(widestLine([], 4), 0);
  assert.equal(widestLine([null, null], 4), 0);
});

test('a minified line does not ask for a column millions of pixels wide', () => {
  const minified = 'var a=1;'.repeat(100000); // 800,000 characters
  assert.equal(widestLine([minified], 4), 4000, 'capped');
  assert.equal(widestLine(['short', minified], 4), 4000, 'and the cap wins over the others');
});

test('the cap does not disturb a file of ordinary lines', () => {
  assert.equal(widestLine(['a'.repeat(300), 'b'.repeat(120)], 4), 300);
});

test('an absent tab size falls back to four', () => {
  assert.equal(widestLine(['	x'], 0), 5);
  assert.equal(widestLine(['	x'], undefined), 5);
});

// -------------------------------------------------------------- navigation

test('each run of changed rows yields one anchor', () => {
  const rows = [same(1), change(2), change(3), same(4), change(5), same(6)];
  assert.deepEqual(changeAnchors(rows), [1, 4]);
});

test('a gap breaks a run, so changes either side of it count separately', () => {
  const rows = [change(1), gap(10), change(2)];
  assert.deepEqual(changeAnchors(rows), [0, 2]);
});

test('a file with no changes has no anchors', () => {
  assert.deepEqual(changeAnchors([same(1), same(2)]), []);
});

test('the current change is the last one at or above the top row', () => {
  const anchors = [3, 40, 90];
  assert.equal(currentAnchor(anchors, 0), -1, 'above the first change');
  assert.equal(currentAnchor(anchors, 3), 0, 'sitting exactly on it');
  assert.equal(currentAnchor(anchors, 39), 0);
  assert.equal(currentAnchor(anchors, 40), 1);
  assert.equal(currentAnchor(anchors, 500), 2, 'past the last one');
});

// ------------------------------------------------------------ changes tree

test('files nest under their folders, deepest label first', () => {
  const rows = buildFileTree([
    { path: 'src/app.ts', status: 'M' },
    { path: 'src/util.ts', status: 'M' },
    { path: 'README.md', status: 'M' },
  ]);

  assert.deepEqual(
    rows.map((r) => r.kind + ':' + r.label + '@' + r.depth),
    ['dir:src@0', 'file:app.ts@1', 'file:util.ts@1', 'file:README.md@0']
  );
});

test('a chain of single-child folders becomes one row', () => {
  const rows = buildFileTree([{ path: 'Mcs.Medicus.Spa/src/business/Session.ts', status: 'M' }]);

  assert.deepEqual(
    rows.map((r) => r.kind + ':' + r.label),
    ['dir:Mcs.Medicus.Spa/src/business', 'file:Session.ts'],
    'three nested folders collapse into one label, the way Visual Studio shows them'
  );
});

test('a chain stops collapsing where the tree forks', () => {
  const rows = buildFileTree([
    { path: 'a/b/c/one.ts', status: 'M' },
    { path: 'a/b/d/two.ts', status: 'M' },
  ]);

  assert.deepEqual(
    rows.map((r) => r.kind + ':' + r.label + '@' + r.depth),
    ['dir:a/b@0', 'dir:c@1', 'file:one.ts@2', 'dir:d@1', 'file:two.ts@2']
  );
});

test('a folder holding both a file and a folder does not collapse', () => {
  const rows = buildFileTree([
    { path: 'a/b/deep.ts', status: 'M' },
    { path: 'a/top.ts', status: 'M' },
  ]);

  assert.deepEqual(
    rows.map((r) => r.kind + ':' + r.label + '@' + r.depth),
    ['dir:a@0', 'dir:b@1', 'file:deep.ts@2', 'file:top.ts@1']
  );
});

test('files at the root sit after the folders', () => {
  const rows = buildFileTree([
    { path: 'z.ts', status: 'M' },
    { path: 'src/a.ts', status: 'M' },
  ]);
  assert.equal(rows[0].kind, 'dir');
  assert.equal(rows[rows.length - 1].label, 'z.ts');
});

test('a closed folder hides its whole subtree but not its siblings', () => {
  const rows = buildFileTree([
    { path: 'a/b/one.ts', status: 'M' },
    { path: 'a/b/two.ts', status: 'M' },
    { path: 'z.ts', status: 'M' },
  ]);
  const closed = new Set(rows.filter((r) => r.kind === 'dir').map((r) => r.key));

  assert.deepEqual(
    visibleTreeRows(rows, closed).map((r) => r.label),
    ['a/b', 'z.ts'],
    'the folder row stays, its files go, the root file is untouched'
  );
});

test('nothing is hidden when no folder is closed', () => {
  const rows = buildFileTree([{ path: 'a/b/one.ts', status: 'M' }]);
  assert.equal(visibleTreeRows(rows, new Set()).length, rows.length);
});

test('a closed folder inside an open one hides only its own files', () => {
  const rows = buildFileTree([
    { path: 'a/b/deep.ts', status: 'M' },
    { path: 'a/top.ts', status: 'M' },
  ]);
  const inner = rows.find((r) => r.kind === 'dir' && r.label === 'b');

  assert.deepEqual(
    visibleTreeRows(rows, new Set([inner.key])).map((r) => r.label),
    ['a', 'b', 'top.ts']
  );
});
