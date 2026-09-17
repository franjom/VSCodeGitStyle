'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Git } = require('../out/git/git.js');
const { parseUnifiedDiff, intraLineSpans, readFileDiff } = require('../out/git/diff.js');
const { TestRepo } = require('./helpers.js');

const git = new Git('git');

/** The rows a side-by-side view would draw, as compact strings. */
function shape(rows) {
  return rows.map((r) => r.kind + ':' + (r.oldNo ?? '-') + '/' + (r.newNo ?? '-'));
}

// ------------------------------------------------------------------ parsing

test('an edit pairs the removed and added lines into one row', () => {
  const diff = parseUnifiedDiff(
    [
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
      '',
    ].join('\n')
  );

  assert.deepEqual(shape(diff.rows), ['same:1/1', 'change:2/2', 'same:3/3']);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.changes, 1, 'one run of changed rows');
  assert.equal(diff.binary, false);

  const changed = diff.rows[1];
  assert.equal(changed.oldText, 'const b = 2;');
  assert.equal(changed.newText, 'const b = 3;');
});

test('the file header is not mistaken for added and removed lines', () => {
  const diff = parseUnifiedDiff(
    ['--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')
  );
  assert.equal(diff.added, 1, 'only the body line counts as added');
  assert.equal(diff.removed, 1);
  assert.deepEqual(shape(diff.rows), ['change:1/1']);
});

test('uneven runs pair what they can and leave the rest one-sided', () => {
  const diff = parseUnifiedDiff(
    [
      '@@ -1,4 +1,3 @@',
      ' keep',
      '-one',
      '-two',
      '-three',
      '+ONE',
      ' tail',
      '',
    ].join('\n')
  );

  // "one" pairs with "ONE"; the other two removals have nothing to sit beside.
  assert.deepEqual(shape(diff.rows), ['same:1/1', 'change:2/2', 'del:3/-', 'del:4/-', 'same:5/3']);
  assert.equal(diff.changes, 1, 'the three rows are one contiguous run');
});

test('a pure addition has no left cell and a pure deletion no right', () => {
  const diff = parseUnifiedDiff(
    ['@@ -1,2 +1,3 @@', ' a', '+inserted', ' b', ''].join('\n')
  );
  assert.deepEqual(shape(diff.rows), ['same:1/1', 'add:-/2', 'same:2/3']);
  const added = diff.rows[1];
  assert.equal(added.oldText, null);
  assert.equal(added.newText, 'inserted');
});

test('separate hunks are joined by a gap row counting the skipped lines', () => {
  const diff = parseUnifiedDiff(
    ['@@ -1,1 +1,1 @@', '-a', '+A', '@@ -10,1 +10,1 @@', '-b', '+B', ''].join('\n')
  );

  assert.deepEqual(shape(diff.rows), ['change:1/1', 'gap:-/-', 'change:10/10']);
  assert.equal(diff.rows[1].skipped, 8, 'lines 2..9 were never sent');
  assert.equal(diff.changes, 2, 'a gap breaks the run in two');
});

test('a binary file is reported rather than parsed', () => {
  const diff = parseUnifiedDiff(
    [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n')
  );
  assert.equal(diff.binary, true);
  assert.equal(diff.rows.length, 0);
});

test('the no-newline marker is dropped instead of becoming a row', () => {
  const diff = parseUnifiedDiff(
    ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+a', ''].join('\n')
  );
  assert.deepEqual(shape(diff.rows), ['change:1/1']);
});

test('a removed line whose own text starts with -- is not taken for a header', () => {
  // The file held "-- a SQL comment"; removing it puts "--- a SQL comment" in
  // the diff, which is a header only if you ignore where the hunk began.
  const diff = parseUnifiedDiff(
    [
      'diff --git a/schema.sql b/schema.sql',
      '--- a/schema.sql',
      '+++ b/schema.sql',
      '@@ -1,2 +1,2 @@',
      ' SELECT 1;',
      // Marker plus the line's own "-- ", which together read as "--- ".
      '--- a SQL comment',
      '+++ a markdown bullet',
      '',
    ].join('\n')
  );

  assert.deepEqual(shape(diff.rows), ['same:1/1', 'change:2/2']);
  assert.equal(diff.rows[1].oldText, '-- a SQL comment', 'the line survives, marker stripped');
  assert.equal(diff.rows[1].newText, '++ a markdown bullet');
});

test('a real commit removing a SQL comment keeps the line', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  // Removing this puts "--- drop the old index" into the diff, one character
  // away from a file header.
  repo.write('schema.sql', 'SELECT 1;\n-- drop the old index\nSELECT 2;\n');
  repo.commit('Initial');
  repo.write('schema.sql', 'SELECT 1;\nSELECT 2;\n');
  const hash = repo.commit('Drop the comment');

  const diff = await readFileDiff(git, repo.dir, hash, 'schema.sql');
  assert.equal(diff.removed, 1);
  const removed = diff.rows.find((r) => r.kind === 'del');
  assert.equal(removed.oldText, '-- drop the old index');
});

test('rename headers do not leak into the rows', () => {
  const diff = parseUnifiedDiff(
    [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n')
  );
  assert.deepEqual(shape(diff.rows), ['change:1/1']);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

// ------------------------------------------------------- intra-line spans

test('only the word that changed is marked, not the rest of the line', () => {
  const spans = intraLineSpans('const b = 2;', 'const b = 3;');
  const cut = (text, list) => list.map(([s, e]) => text.slice(s, e));

  assert.deepEqual(cut('const b = 2;', spans.old), ['2']);
  assert.deepEqual(cut('const b = 3;', spans.new), ['3']);
});

test('a line wrapped in a call marks the wrapper, not the argument', () => {
  const before = '    if (!this._default) {';
  const after = '    if (Util.isEmpty(this._default)) {';
  const spans = intraLineSpans(before, after);

  const oldParts = spans.old.map(([s, e]) => before.slice(s, e));
  const newText = spans.new.map(([s, e]) => after.slice(s, e)).join('');

  assert.deepEqual(oldParts, ['!'], 'the removed negation is the only old change');
  assert.ok(newText.includes('Util'), 'the added wrapper is marked');
  assert.ok(!newText.includes('_default'), 'the untouched argument is not');
});

test('an unchanged line has no spans at all', () => {
  const spans = intraLineSpans('same', 'same');
  assert.deepEqual(spans.old, []);
  assert.deepEqual(spans.new, []);
});

test('adjacent changed tokens merge into one span', () => {
  const spans = intraLineSpans('a x', 'a yy zz');
  assert.equal(spans.new.length, 1, 'one run rather than a span per token');
  assert.equal('a yy zz'.slice(spans.new[0][0], spans.new[0][1]), 'yy zz');
});

test('a very long line is marked whole rather than word by word', () => {
  const long = new Array(900).fill('tok').join(' ');
  const spans = intraLineSpans(long, long + ' end');
  assert.deepEqual(spans.new, [[0, long.length + 4]]);
});

// ------------------------------------------------------------- against git

test('a real commit reads back as whole-file rows with the change in place', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());

  const lines = [];
  for (let i = 1; i <= 40; i++) {
    lines.push('line ' + i);
  }
  repo.write('src/app.ts', lines.join('\n') + '\n');
  repo.commit('Initial');

  lines[19] = 'line twenty changed';
  repo.write('src/app.ts', lines.join('\n') + '\n');
  const hash = repo.commit('Edit one line');

  const diff = await readFileDiff(git, repo.dir, hash, 'src/app.ts');

  assert.equal(diff.changes, 1);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.truncated, false);
  assert.equal(
    diff.rows.length,
    40,
    'the whole file is returned, not just the hunk, so both sides scroll as documents'
  );
  assert.ok(
    !diff.rows.some((r) => r.kind === 'gap'),
    'nothing is elided when the file fits'
  );

  const changed = diff.rows[19];
  assert.equal(changed.kind, 'change');
  assert.equal(changed.oldNo, 20);
  assert.equal(changed.newNo, 20);
  assert.equal(changed.newText, 'line twenty changed');
});

test('the root commit diffs against the empty tree instead of failing', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('first.txt', 'a\nb\n');
  const hash = repo.commit('Initial');

  const diff = await readFileDiff(git, repo.dir, hash, 'first.txt');
  assert.deepEqual(shape(diff.rows), ['add:-/1', 'add:-/2']);
  assert.equal(diff.removed, 0);
});

test('a rename is read as an edit, not as a whole file added', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('old.ts', 'alpha\nbeta\ngamma\n');
  repo.commit('Initial');

  repo.git(['mv', 'old.ts', 'new.ts']);
  repo.write('new.ts', 'alpha\nBETA\ngamma\n');
  const hash = repo.commit('Rename and edit');

  const diff = await readFileDiff(git, repo.dir, hash, 'new.ts', 'old.ts');

  assert.equal(diff.origPath, 'old.ts');
  assert.equal(diff.added, 1, 'only the edited line counts, not the whole file');
  assert.equal(diff.removed, 1);
  assert.deepEqual(shape(diff.rows), ['same:1/1', 'change:2/2', 'same:3/3']);
});

test('a merge is diffed against its first parent, matching the file list', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('shared.txt', 'base\n');
  repo.commit('Initial');

  repo.git(['checkout', '-q', '-b', 'side']);
  repo.write('side-only.txt', 'from the side\n');
  repo.commit('Side work');

  repo.git(['checkout', '-q', 'main']);
  repo.write('main-only.txt', 'from main\n');
  repo.commit('Main work');

  repo.git(['merge', '-q', '--no-ff', '-m', 'Merge side', 'side']);
  const hash = repo.git(['rev-parse', 'HEAD']).trim();

  const diff = await readFileDiff(git, repo.dir, hash, 'side-only.txt');
  assert.deepEqual(shape(diff.rows), ['add:-/1'], 'the side branch file arrives in the merge');
});

test('a binary file comes back flagged rather than as rows of bytes', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('logo.bin', Buffer.from([0, 1, 2, 0, 255, 7]));
  repo.commit('Initial');
  repo.write('logo.bin', Buffer.from([0, 9, 9, 0, 255, 7]));
  const hash = repo.commit('Change the bytes');

  const diff = await readFileDiff(git, repo.dir, hash, 'logo.bin');
  assert.equal(diff.binary, true);
  assert.equal(diff.rows.length, 0);
});
