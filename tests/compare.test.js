'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { comparePairs, pairStatus } = require('../out/git/compare.js');

const FROM = 'aaaaaaa';
const TO = 'bbbbbbb';

test('a modified file is the same path on both sides', () => {
  assert.deepEqual(comparePairs([{ status: 'M', path: 'src/a.cs' }], FROM, TO), [
    {
      path: 'src/a.cs',
      left: { rev: FROM, path: 'src/a.cs' },
      right: { rev: TO, path: 'src/a.cs' },
    },
  ]);
});

test('an added file has nothing on the left, so it reads as added', () => {
  const [pair] = comparePairs([{ status: 'A', path: 'new.cs' }], FROM, TO);
  assert.equal(pair.left, undefined);
  assert.deepEqual(pair.right, { rev: TO, path: 'new.cs' });
});

test('a deleted file has nothing on the right, so it reads as deleted', () => {
  const [pair] = comparePairs([{ status: 'D', path: 'gone.cs' }], FROM, TO);
  assert.deepEqual(pair.left, { rev: FROM, path: 'gone.cs' });
  assert.equal(pair.right, undefined);
});

test('a renamed file is compared with the path it came from', () => {
  const [pair] = comparePairs(
    [{ status: 'R', path: 'src/new name.cs', origPath: 'src/old name.cs' }],
    FROM,
    TO
  );
  assert.equal(pair.path, 'src/new name.cs');
  assert.deepEqual(pair.left, { rev: FROM, path: 'src/old name.cs' });
  assert.deepEqual(pair.right, { rev: TO, path: 'src/new name.cs' });
});

test('every listed file becomes one entry, in the order given', () => {
  const files = [
    { status: 'M', path: 'a' },
    { status: 'A', path: 'b' },
    { status: 'D', path: 'c' },
  ];
  assert.deepEqual(
    comparePairs(files, FROM, TO).map((pair) => pair.path),
    ['a', 'b', 'c']
  );
});

test('a pair reads back as the letter its file was listed with', () => {
  const files = [
    { status: 'M', path: 'm' },
    { status: 'A', path: 'a' },
    { status: 'D', path: 'd' },
    { status: 'R', path: 'new', origPath: 'old' },
  ];
  assert.deepEqual(
    comparePairs(files, FROM, TO).map(pairStatus),
    ['M', 'A', 'D', 'R']
  );
});
