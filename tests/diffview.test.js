'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFileTree, visibleTreeRows } = require('../media/diffview.js');

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

test('a folder shut in one worktree stays open in another', () => {
  const rows = buildFileTree([{ path: 'src/a.ts', status: 'M' }]);
  const shutInFirst = new Set(['wt:D:/one' + rows[0].key]);

  assert.deepEqual(
    visibleTreeRows(rows, shutInFirst, 'wt:D:/one').map((r) => r.label),
    ['src']
  );
  assert.deepEqual(
    visibleTreeRows(rows, shutInFirst, 'wt:D:/two').map((r) => r.label),
    ['src', 'a.ts']
  );
});
