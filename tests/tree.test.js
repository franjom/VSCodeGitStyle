'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTree } = require('../out/tree.js');

const SEP = String.fromCharCode(92); // backslash, as shown on Windows

function change(path, status) {
  return { path, status: status || 'modified', staged: false };
}

/** Flattens the tree into "indent + label" lines for readable assertions. */
function outline(nodes, depth) {
  const lines = [];
  for (const node of nodes || []) {
    lines.push('  '.repeat(depth || 0) + (node.kind === 'folder' ? '+ ' : '') + node.label);
    if (node.kind === 'folder') {
      lines.push(...outline(node.children, (depth || 0) + 1));
    }
  }
  return lines;
}

test('files at the root produce no folders', () => {
  const tree = buildTree([change('a.txt'), change('b.txt')], SEP);
  assert.deepEqual(outline(tree), ['a.txt', 'b.txt']);
});

test('a chain of single-child folders collapses into one row', () => {
  const tree = buildTree([change('Api/Controllers/Api/Widgets/Thing.cs')], SEP);

  assert.deepEqual(outline(tree), [
    '+ Api' + SEP + 'Controllers' + SEP + 'Api' + SEP + 'Widgets',
    '  Thing.cs',
  ]);
});

test('a chain stops collapsing where it branches', () => {
  const tree = buildTree(
    [change('src/deep/one/a.cs'), change('src/deep/two/b.cs')],
    SEP
  );

  assert.deepEqual(outline(tree), [
    '+ src' + SEP + 'deep',
    '  + one',
    '    a.cs',
    '  + two',
    '    b.cs',
  ]);
});

test('a chain stops collapsing where a folder also holds a file', () => {
  const tree = buildTree([change('src/a.cs'), change('src/sub/b.cs')], SEP);

  assert.deepEqual(outline(tree), ['+ src', '  + sub', '    b.cs', '  a.cs']);
});

test('folders come before files, each alphabetically', () => {
  const tree = buildTree(
    [change('zeta.txt'), change('alpha.txt'), change('zfolder/x.txt'), change('afolder/y.txt')],
    SEP
  );

  assert.deepEqual(outline(tree), [
    '+ afolder',
    '  y.txt',
    '+ zfolder',
    '  x.txt',
    'alpha.txt',
    'zeta.txt',
  ]);
});

test('sorting ignores case', () => {
  const tree = buildTree([change('b.txt'), change('A.txt'), change('a.txt')], SEP);
  assert.deepEqual(outline(tree), ['A.txt', 'a.txt', 'b.txt']);
});

test('a folder counts every file beneath it', () => {
  const tree = buildTree(
    [change('src/a.cs'), change('src/sub/b.cs'), change('src/sub/deeper/c.cs')],
    SEP
  );

  const src = tree.find((n) => n.label === 'src');
  assert.equal(src.fileCount, 3);
  const sub = src.children.find((n) => n.kind === 'folder');
  assert.equal(sub.fileCount, 2);
});

test('keys stay full paths so expansion survives a collapsed chain', () => {
  const tree = buildTree([change('a/b/c/file.cs')], SEP);
  assert.equal(tree[0].key, 'a/b/c');
  assert.equal(tree[0].children[0].key, 'a/b/c/file.cs');
});

test('the file node carries its change through', () => {
  const tree = buildTree([change('src/x.cs', 'deleted')], SEP);
  const file = tree[0].children[0];
  assert.equal(file.kind, 'file');
  assert.equal(file.change.status, 'deleted');
  assert.equal(file.change.path, 'src/x.cs');
});

test('the separator is only used for display, not for keys', () => {
  const tree = buildTree([change('a/b/file.cs')], '/');
  assert.equal(tree[0].label, 'a/b');
  assert.equal(tree[0].key, 'a/b');
});

test('an empty change list gives an empty tree', () => {
  assert.deepEqual(buildTree([], SEP), []);
});

test('paths containing spaces are kept intact', () => {
  const tree = buildTree([change('my folder/my file.cs')], SEP);
  assert.deepEqual(outline(tree), ['+ my folder', '  my file.cs']);
});
