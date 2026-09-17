'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extensionOf, collectFolderKeys } = require('../media/changesview.js');

function folder(key, children) {
  return { kind: 'folder', key: key, children: children || [] };
}
function file(path) {
  return { kind: 'file', path: path };
}

// ----------------------------------------------------------------- extensions

test('a file is grouped by the part after its last dot', () => {
  assert.equal(extensionOf('Controller.cs'), 'cs');
  assert.equal(extensionOf('styles.module.scss'), 'scss', 'the last dot wins');
});

test('grouping ignores case, so .CS and .cs are one group', () => {
  assert.equal(extensionOf('README.MD'), 'md');
  assert.equal(extensionOf('Controller.CS'), extensionOf('controller.cs'));
});

test('a dotfile is its own group rather than a nameless one', () => {
  // The leading dot starts the name, it does not separate an extension.
  assert.equal(extensionOf('.gitignore'), 'gitignore');
  assert.equal(extensionOf('.env'), 'env');
});

test('a file with no dot at all groups under its own name', () => {
  assert.equal(extensionOf('LICENSE'), 'license');
  assert.equal(extensionOf('Makefile'), 'makefile');
});

test('a trailing dot leaves an empty group rather than throwing', () => {
  assert.equal(extensionOf('odd.'), '');
});

// --------------------------------------------------------------- folder keys

test('every folder in the tree is collected, parents first', () => {
  const tree = [folder('src', [folder('src/api', [file('src/api/a.cs')])]), file('top.md')];
  assert.deepEqual(collectFolderKeys(tree, 'staged:'), ['staged:src', 'staged:src/api']);
});

test('files are not folders', () => {
  assert.deepEqual(collectFolderKeys([file('a.cs'), file('b.cs')], 'x:'), []);
});

test('the prefix scopes the keys to one section', () => {
  // The same folder can be open under Staged and shut under Changes, so the
  // keys the two sections produce must not collide.
  const tree = [folder('src', [])];
  assert.deepEqual(collectFolderKeys(tree, 'staged:'), ['staged:src']);
  assert.deepEqual(collectFolderKeys(tree, 'unstaged:'), ['unstaged:src']);
});

test('siblings are all collected, not just the first', () => {
  const tree = [folder('a', [folder('a/x', [])]), folder('b', [])];
  assert.deepEqual(collectFolderKeys(tree, ''), ['a', 'a/x', 'b']);
});

test('an empty tree yields no keys', () => {
  assert.deepEqual(collectFolderKeys([], 'staged:'), []);
});

test('collecting twice does not accumulate', () => {
  // It used to take the output array as an argument, which made that possible.
  const tree = [folder('src', [])];
  assert.deepEqual(collectFolderKeys(tree, ''), collectFolderKeys(tree, ''));
});
