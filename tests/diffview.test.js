'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collapseRows,
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

function rowsWithChangeAt(total, at) {
  const rows = [];
  for (let i = 1; i <= total; i++) {
    rows.push(i === at ? change(i) : same(i));
  }
  return rows;
}

// --------------------------------------------------------------- collapsing

test('a diff within the cap keeps every line of context', () => {
  const rows = rowsWithChangeAt(50, 25);
  assert.equal(collapseRows(rows, 4000), rows, 'the same array, not a copy');
});

test('a long file collapses to the changes and their surroundings', () => {
  const rows = rowsWithChangeAt(1000, 500);
  const out = collapseRows(rows, 100);

  // 12 rows either side of the change, plus the change, plus a gap at each end.
  assert.equal(out.length, 27);
  assert.equal(out[0].kind, 'gap');
  assert.equal(out[out.length - 1].kind, 'gap');
  assert.ok(
    out.some((r) => r.kind === 'change'),
    'the change itself survives'
  );
});

test('every line of the file is accounted for after collapsing', () => {
  const rows = rowsWithChangeAt(1000, 500);
  const out = collapseRows(rows, 100);

  const shown = out.filter((r) => r.kind !== 'gap').length;
  const elided = out.reduce((sum, r) => sum + (r.kind === 'gap' ? r.skipped : 0), 0);
  assert.equal(shown + elided, 1000, 'nothing is lost or double counted');
});

test('two distant changes each keep their own context', () => {
  const rows = [];
  for (let i = 1; i <= 1000; i++) {
    rows.push(i === 100 || i === 900 ? change(i) : same(i));
  }
  const out = collapseRows(rows, 100);

  assert.equal(out.filter((r) => r.kind === 'change').length, 2);
  assert.equal(out.filter((r) => r.kind === 'gap').length, 3, 'before, between and after');
});

test("a gap the parser produced keeps its own count through a collapse", () => {
  const rows = [change(1), gap(500)];
  for (let i = 0; i < 200; i++) {
    rows.push(same(i + 502));
  }
  const out = collapseRows(rows, 10);

  const elided = out.reduce((sum, r) => sum + (r.kind === 'gap' ? r.skipped : 0), 0);
  assert.ok(elided >= 500, 'the 500 lines git never sent are still reported as missing');
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
