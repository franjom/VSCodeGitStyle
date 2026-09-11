'use strict';

/*
 * The file context menu's two new git-facing actions: "Ignore and Untrack item"
 * and "View History". Both are exercised against real repositories, because
 * both turn on git behaviour that is easy to get wrong by reasoning: what
 * `git rm --cached` does to a file that was never tracked, and what --follow
 * does across a rename.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Git } = require('../out/git.js');
const { readGraph } = require('../out/graph.js');
const { TestRepo } = require('./helpers.js');

const git = new Git('git');

test('ignore and untrack stops tracking the file but leaves it on disk', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('src/Secret.cs', 'secrets\n');
  repo.write('src/Kept.cs', 'kept\n');
  repo.commit('Initial');

  await git.ignoreAndUntrack(repo.dir, 'src/Secret.cs');

  assert.equal(repo.read('src/Secret.cs'), 'secrets\n', 'the file stays on disk');
  assert.equal(repo.read('.gitignore'), '/src/Secret.cs\n');
  assert.equal(
    repo.git(['ls-files', '--', 'src/Secret.cs']).trim(),
    '',
    'it is out of the index'
  );
  assert.match(
    repo.git(['ls-files', '--', 'src/Kept.cs']),
    /src\/Kept\.cs/,
    'its neighbour is untouched'
  );

  // The deletion is staged, and the file itself is now ignored rather than
  // showing up as untracked.
  const status = repo.git(['status', '--porcelain']);
  assert.match(status, /^D {2}src\/Secret\.cs$/m);
  assert.doesNotMatch(status, /\?\? src\/Secret\.cs/);
});

test('ignore and untrack works on a file that was never tracked', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');
  repo.write('build/output.log', 'noise\n');

  // git rm --cached fails outright on an untracked path, so the untrack half
  // has to be skipped rather than attempted and swallowed.
  await git.ignoreAndUntrack(repo.dir, 'build/output.log');

  assert.equal(repo.read('.gitignore'), '/build/output.log\n');
  assert.doesNotMatch(repo.git(['status', '--porcelain']), /output\.log/, 'now ignored');
});

test('ignoring twice does not repeat the line', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.write('b.txt', 'b\n');
  repo.commit('Initial');

  await git.ignoreAndUntrack(repo.dir, 'a.txt');
  await git.ignoreAndUntrack(repo.dir, 'a.txt');
  await git.ignoreAndUntrack(repo.dir, 'b.txt');

  assert.equal(repo.read('.gitignore'), '/a.txt\n/b.txt\n');
});

test('an existing .gitignore without a trailing newline is appended to cleanly', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('.gitignore', '*.tmp');
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');

  await git.ignoreAndUntrack(repo.dir, 'a.txt');

  assert.equal(
    repo.read('.gitignore'),
    '*.tmp\n/a.txt\n',
    'the new pattern must not run onto the end of the last line'
  );
});

test('the ignore pattern is anchored to the repository root', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('src/Config.cs', 'one\n');
  repo.write('other/src/Config.cs', 'two\n');
  repo.commit('Initial');

  await git.ignoreAndUntrack(repo.dir, 'src/Config.cs');

  // Without the leading slash this would also ignore other/src/Config.cs.
  assert.equal(repo.read('.gitignore'), '/src/Config.cs\n');
  assert.match(
    repo.git(['ls-files', '--', 'other/src/Config.cs']),
    /other\/src\/Config\.cs/,
    'the same name elsewhere stays tracked'
  );
});

test('ignore and untrack handles a path containing a space', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('my folder/my file.cs', 'one\n');
  repo.commit('Initial');

  await git.ignoreAndUntrack(repo.dir, 'my folder/my file.cs');

  assert.equal(repo.read('.gitignore'), '/my folder/my file.cs\n');
  assert.equal(repo.git(['ls-files']).trim(), '', 'nothing tracked but the ignore file');
});

test('file history shows only the commits that touched the file', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'one\n');
  repo.write('b.txt', 'one\n');
  repo.commit('Both files');
  repo.write('b.txt', 'two\n');
  repo.commit('Only b');
  repo.write('a.txt', 'two\n');
  repo.commit('Only a');
  repo.write('b.txt', 'three\n');
  repo.commit('Only b again');

  const all = await readGraph(git, repo.dir, 'HEAD', 50);
  assert.equal(all.rows.length, 4);
  assert.equal(all.file, undefined);

  const scoped = await readGraph(git, repo.dir, 'HEAD', 50, 'a.txt');
  assert.equal(scoped.file, 'a.txt');
  assert.deepEqual(
    scoped.rows.map((r) => r.commit.subject),
    ['Only a', 'Both files']
  );
});

test('file history follows the file through a rename', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('old name.cs', 'one\n');
  repo.commit('Add it');
  repo.write('old name.cs', 'two\n');
  repo.commit('Change it');
  repo.git(['mv', 'old name.cs', 'new name.cs']);
  repo.commit('Rename it');
  repo.write('new name.cs', 'three\n');
  repo.commit('Change it again');

  const scoped = await readGraph(git, repo.dir, 'HEAD', 50, 'new name.cs');
  assert.deepEqual(
    scoped.rows.map((r) => r.commit.subject),
    ['Change it again', 'Rename it', 'Change it', 'Add it'],
    '--follow must carry the history past the rename'
  );
});

test('file history is all local, never split against an upstream', async (t) => {
  const origin = new TestRepo();
  const repo = new TestRepo();
  t.after(() => {
    origin.dispose();
    repo.dispose();
  });

  origin.write('a.txt', 'one\n');
  origin.commit('Initial');

  repo.git(['remote', 'add', 'origin', origin.dir]);
  repo.git(['fetch', '-q', 'origin']);
  repo.git(['checkout', '-q', '-B', 'main', 'origin/main']);

  repo.write('a.txt', 'two\n');
  repo.commit('Outgoing change');

  // The branch is one commit ahead, which the ordinary graph reports.
  const all = await readGraph(git, repo.dir, 'main', 50);
  assert.equal(all.outgoing, 1);

  // Scoped to a file, Incoming/Outgoing would count commits that never touched
  // it, so the split is dropped and every row is local history.
  const scoped = await readGraph(git, repo.dir, 'main', 50, 'a.txt');
  assert.equal(scoped.incoming, 0);
  assert.equal(scoped.outgoing, 0);
  assert.ok(
    scoped.rows.every((r) => r.group === 'local'),
    'every row belongs to Local History'
  );
});

test('file history of an unknown path is empty rather than an error', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'one\n');
  repo.commit('Initial');

  const scoped = await readGraph(git, repo.dir, 'HEAD', 50, 'does/not/exist.cs');
  assert.deepEqual(scoped.rows, []);
  assert.equal(scoped.hasMore, false);
});
