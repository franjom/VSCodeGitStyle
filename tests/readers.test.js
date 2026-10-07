'use strict';

/*
 * The readers - snapshot, readGraph, readRefs, readCommitDetails,
 * readReviewInfo - exercised by running real git against a repository built for
 * the purpose. Anything that can be decided from captured output instead is a
 * parser, and lives in parse.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { countChanges, Git } = require('../out/git/git.js');
const { readGraph, readRefs, readCommitDetails, readReviewInfo } = require('../out/git/graph.js');
const { readWorktrees } = require('../out/git/worktrees.js');
const { readStashChanges, stashIndexOf } = require('../out/git/compare.js');
const { TestRepo, assertLaneContinuity, assertLanesInRange } = require('./helpers.js');

const git = new Git('git');

/** A repository holding one of every change type at once. */
function repoWithEveryChange() {
  const repo = new TestRepo();
  repo.write('src/Modified.cs', 'one\n');
  repo.write('src/Deleted.cs', 'one\n');
  repo.write('src/old name.cs', 'one\n');
  repo.write('src/Both.cs', 'one\n');
  repo.write('docs/Kept.md', 'one\n');
  repo.commit('Initial');

  repo.write('src/Modified.cs', 'one\ntwo\n');
  repo.remove('src/Deleted.cs');
  repo.git(['mv', 'src/old name.cs', 'src/new name.cs']);
  repo.write('src/Added.cs', 'new\n');
  repo.git(['add', 'src/Added.cs']);
  repo.write('src/Untracked.cs', 'new\n');
  // Staged, then edited again: belongs in both lists.
  repo.write('src/Both.cs', 'one\nstaged\n');
  repo.git(['add', 'src/Both.cs']);
  repo.write('src/Both.cs', 'one\nstaged\nand more\n');
  return repo;
}

test('snapshot reports every change type in the right list', async (t) => {
  const repo = repoWithEveryChange();
  t.after(() => repo.dispose());

  const snapshot = await git.snapshot(repo.dir, false);
  const staged = new Map(snapshot.staged.map((c) => [c.path, c]));
  const unstaged = new Map(snapshot.unstaged.map((c) => [c.path, c]));

  assert.equal(staged.get('src/Added.cs').status, 'added');
  assert.equal(staged.get('src/new name.cs').status, 'renamed');
  assert.equal(staged.get('src/new name.cs').origPath, 'src/old name.cs');
  assert.equal(unstaged.get('src/Modified.cs').status, 'modified');
  assert.equal(unstaged.get('src/Deleted.cs').status, 'deleted');
  assert.equal(unstaged.get('src/Untracked.cs').status, 'untracked');

  assert.ok(staged.has('src/Both.cs'), 'the staged edit is listed');
  assert.ok(unstaged.has('src/Both.cs'), 'the later edit is listed too');

  assert.equal(snapshot.conflicts.length, 0);
  assert.equal(snapshot.operation, undefined);
});

test('the badge totals the panel sections, ignoring ignored files', async (t) => {
  const repo = repoWithEveryChange();
  t.after(() => repo.dispose());
  repo.write('.gitignore', 'bin/\n');
  repo.write('bin/output.dll', 'binary\n');

  const snapshot = await git.snapshot(repo.dir, true);
  assert.ok(
    snapshot.unstaged.some((c) => c.status === 'ignored'),
    'the ignored file is in the list the panel shows'
  );

  const listed =
    snapshot.staged.length +
    snapshot.unstaged.filter((c) => c.status !== 'ignored').length +
    snapshot.conflicts.length;
  assert.equal(countChanges(snapshot), listed, 'the badge is what the sections add up to');
  assert.equal(await git.changeCount(repo.dir), listed, 'the cheap count agrees');
});

test('a file staged and then edited again counts under both sections', async (t) => {
  // It is listed twice in the panel - once under Staged Changes and once under
  // Changes - so a badge counting distinct paths would read lower than the two
  // headings it sits above, and lower than the built-in Git view beside it.
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('Both.cs', 'one');
  repo.commit('Initial');
  repo.write('Both.cs', 'one staged');
  repo.git(['add', 'Both.cs']);
  repo.write('Both.cs', 'one staged and more');

  const snapshot = await git.snapshot(repo.dir, false);
  assert.equal(snapshot.staged.length, 1);
  assert.equal(snapshot.unstaged.length, 1);
  assert.equal(countChanges(snapshot), 2, 'once for each section it appears in');
});

test('ignored files never reach the badge, however many there are', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('.gitignore', 'bin/');
  repo.commit('Initial');
  repo.write('bin/a.dll', 'x');
  repo.write('bin/b.dll', 'x');

  const snapshot = await git.snapshot(repo.dir, true);
  assert.ok(snapshot.unstaged.some((c) => c.status === 'ignored'), 'they are listed');
  assert.equal(countChanges(snapshot), 0, 'but none of them is a change');
});

test('snapshot reads the branch, and ahead/behind without an upstream', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');
  repo.git(['branch', 'feature/x']);

  const snapshot = await git.snapshot(repo.dir, false);
  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.detached, false);
  assert.deepEqual(snapshot.branches.sort(), ['feature/x', 'main']);
  assert.equal(snapshot.upstream, undefined);
  assert.equal(snapshot.ahead, 0);
  assert.equal(snapshot.behind, 0);
});

test('snapshot counts outgoing and incoming against an upstream', async (t) => {
  const origin = new TestRepo();
  const clone = new TestRepo();
  t.after(() => {
    origin.dispose();
    clone.dispose();
  });

  origin.write('a.txt', 'a\n');
  origin.commit('Initial');
  origin.git(['config', 'receive.denyCurrentBranch', 'ignore']);

  clone.git(['remote', 'add', 'origin', origin.dir]);
  clone.git(['fetch', '-q', 'origin']);
  clone.git(['checkout', '-q', '-B', 'main', 'origin/main']);

  // Two commits only here, one only on the remote.
  clone.write('b.txt', 'b\n');
  clone.commit('Local one');
  clone.write('c.txt', 'c\n');
  clone.commit('Local two');
  origin.write('d.txt', 'd\n');
  origin.commit('Remote one');
  clone.git(['fetch', '-q', 'origin']);

  const snapshot = await git.snapshot(clone.dir, false);
  assert.equal(snapshot.upstream, 'origin/main');
  assert.equal(snapshot.ahead, 2, 'two commits not on the remote');
  assert.equal(snapshot.behind, 1, 'one commit not held locally');
});

test('a stash is listed the way Visual Studio shows it', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');
  repo.write('a.txt', 'changed\n');
  repo.git(['stash', 'push', '-q', '-m', 'work in progress']);

  const snapshot = await git.snapshot(repo.dir, false);
  assert.equal(snapshot.stashes.length, 1);
  assert.equal(snapshot.stashes[0].index, 0);
  assert.equal(snapshot.stashes[0].label, 'On main: work in progress');
});

test('viewing a stash shows its untracked files beside its tracked changes', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('Modified.cs', 'one\n');
  repo.write('Deleted.cs', 'one\n');
  repo.commit('Initial');
  const base = repo.git(['rev-parse', 'HEAD']).trim();

  repo.write('Modified.cs', 'one\ntwo\n');
  repo.remove('Deleted.cs');
  repo.write('Added.cs', 'new\n');
  repo.git(['add', 'Added.cs']);
  repo.write('Untracked.cs', 'new\n');
  // Stash All Changes pushes with -u, which is what puts a third parent there.
  repo.git(['stash', 'push', '-q', '-u', '-m', 'wip']);
  const stash = repo.git(['rev-parse', 'stash@{0}']).trim();
  const untracked = repo.git(['rev-parse', 'stash@{0}^3']).trim();

  const changes = await readStashChanges(git, repo.dir, 0);
  assert.equal(changes.subject, 'On main: wip');
  assert.equal(changes.hash, stash);
  assert.equal(changes.base, base);
  assert.ok(!isNaN(new Date(changes.created).getTime()), 'the created date parses');
  assert.deepEqual(changes.pairs, [
    { path: 'Added.cs', left: undefined, right: { rev: stash, path: 'Added.cs' } },
    { path: 'Deleted.cs', left: { rev: base, path: 'Deleted.cs' }, right: undefined },
    {
      path: 'Modified.cs',
      left: { rev: base, path: 'Modified.cs' },
      right: { rev: stash, path: 'Modified.cs' },
    },
    { path: 'Untracked.cs', left: undefined, right: { rev: untracked, path: 'Untracked.cs' } },
  ]);
});

test('viewing a stash names it by hash, so pushing another does not change what is shown', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');
  repo.write('a.txt', 'first\n');
  repo.git(['stash', 'push', '-q', '-m', 'first']);
  const first = repo.git(['rev-parse', 'stash@{0}']).trim();

  const changes = await readStashChanges(git, repo.dir, 0);
  repo.write('a.txt', 'second\n');
  repo.git(['stash', 'push', '-q', '-m', 'second']);

  assert.equal(changes.pairs[0].right.rev, first);
  assert.equal(await readStashChanges(git, repo.dir, 5), undefined, 'no such stash');
  assert.equal(await stashIndexOf(git, repo.dir, first), 1, 'found again where it moved to');
  repo.git(['stash', 'drop', '-q', 'stash@{1}']);
  assert.equal(await stashIndexOf(git, repo.dir, first), undefined, 'gone once dropped');
});

test('a stash stored by hand is titled by its stash message, not by git\'s WIP line', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');
  repo.write('a.txt', 'changed\n');
  const hash = repo.git(['stash', 'create']).trim();
  repo.git(['stash', 'store', '-m', 'On main: kept by hand', hash]);

  const changes = await readStashChanges(git, repo.dir, 0);
  assert.equal(changes.subject, 'On main: kept by hand');
});

test('a conflicted merge is reported as conflicts plus an operation', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());

  repo.write('src/Sender.cs', 'one\ntwo\nthree\n');
  repo.commit('Initial');
  repo.git(['checkout', '-q', '-b', 'feature/rework']);
  repo.write('src/Sender.cs', 'one\nFEATURE\nthree\n');
  repo.commit('Feature edit');
  repo.git(['checkout', '-q', 'main']);
  repo.write('src/Sender.cs', 'one\nMAIN\nthree\n');
  repo.commit('Main edit');

  const merged = repo.tryGit(['merge', 'feature/rework']);
  assert.equal(merged, false, 'the merge is expected to conflict');

  const snapshot = await git.snapshot(repo.dir, false);
  assert.deepEqual(snapshot.conflicts.map((c) => c.path), ['src/Sender.cs']);
  assert.equal(snapshot.conflicts[0].status, 'conflict');
  assert.ok(
    !snapshot.staged.some((c) => c.path === 'src/Sender.cs'),
    'an unmerged path must not appear as staged'
  );
  assert.ok(
    !snapshot.unstaged.some((c) => c.path === 'src/Sender.cs'),
    'an unmerged path must not appear as unstaged'
  );
  assert.equal(snapshot.operation.kind, 'merge');
  assert.equal(snapshot.operation.ref, 'feature/rework');
});

test('taking each side resolves a conflict and stages the result', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());

  repo.write('ours.txt', 'base\n');
  repo.write('theirs.txt', 'base\n');
  repo.commit('Initial');
  repo.git(['checkout', '-q', '-b', 'other']);
  repo.write('ours.txt', 'from other\n');
  repo.write('theirs.txt', 'from other\n');
  repo.commit('Other edits');
  repo.git(['checkout', '-q', 'main']);
  repo.write('ours.txt', 'from main\n');
  repo.write('theirs.txt', 'from main\n');
  repo.commit('Main edits');
  repo.tryGit(['merge', 'other']);

  await git.resolveWith(repo.dir, 'ours.txt', 'ours');
  await git.resolveWith(repo.dir, 'theirs.txt', 'theirs');

  assert.equal(repo.read('ours.txt'), 'from main\n');
  assert.equal(repo.read('theirs.txt'), 'from other\n');

  const snapshot = await git.snapshot(repo.dir, false);
  assert.equal(snapshot.conflicts.length, 0, 'nothing is left conflicted');
  assert.equal(
    snapshot.operation.kind,
    'merge',
    'git keeps the merge open until it is committed'
  );

  await git.commit(repo.dir, 'Merge other into main', false);
  const after = await git.snapshot(repo.dir, false);
  assert.equal(after.operation, undefined, 'committing ends the merge');
});

test('aborting a merge restores the working tree', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());

  repo.write('f.txt', 'base\n');
  repo.commit('Initial');
  repo.git(['checkout', '-q', '-b', 'other']);
  repo.write('f.txt', 'other\n');
  repo.commit('Other');
  repo.git(['checkout', '-q', 'main']);
  repo.write('f.txt', 'main\n');
  repo.commit('Main');
  repo.tryGit(['merge', 'other']);

  repo.git(['merge', '--abort']);
  const snapshot = await git.snapshot(repo.dir, false);
  assert.equal(snapshot.conflicts.length, 0);
  assert.equal(snapshot.operation, undefined);
  assert.equal(repo.read('f.txt'), 'main\n');
});

test('amending with no message keeps the previous one', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('The original message');
  repo.write('a.txt', 'b\n');
  repo.git(['add', '-A']);

  await git.commit(repo.dir, '', true);
  assert.equal(
    repo.git(['log', '-1', '--format=%s']).trim(),
    'The original message',
    'an empty box must not blank the message being amended'
  );
});

test('a commit with nothing staged fails with git saying so, not with the message', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('first');

  // git writes this one to stdout, which the error used to drop.
  await assert.rejects(git.commit(repo.dir, 'A message nobody needs to see again', false), (err) => {
    assert.match(err.message, /nothing to commit/);
    assert.doesNotMatch(err.message, /nobody needs to see/);
    return true;
  });
});

test('a pre-commit hook that refuses is reported in its own words', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  // Printed to stdout, as many hook scripts do.
  const hook = repo.write(
    '.git/hooks/pre-commit',
    '#!/bin/sh\necho "kb check: verdict changed without a History line"\nexit 1\n'
  );
  require('node:fs').chmodSync(hook, 0o755);
  repo.write('a.txt', 'b\n');
  repo.git(['add', '-A']);

  await assert.rejects(git.commit(repo.dir, 'change a', false), (err) => {
    assert.match(err.message, /verdict changed without a History line/);
    return true;
  });
});

test('discard reverts a tracked file', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('tracked.txt', 'base\n');
  repo.commit('Initial');
  repo.write('tracked.txt', 'edited\n');

  const snapshot = await git.snapshot(repo.dir, false);
  await git.discard(repo.dir, snapshot.unstaged.find((c) => c.path === 'tracked.txt'));

  assert.equal(repo.read('tracked.txt'), 'base\n');
  const after = await git.snapshot(repo.dir, false);
  assert.equal(after.unstaged.length, 0);
  assert.equal(after.staged.length, 0);
});

test('discard leaves an untracked file for the bin rather than deleting it for good', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('tracked.txt', 'base\n');
  repo.commit('Initial');
  repo.write('fresh.txt', 'new\n');

  const snapshot = await git.snapshot(repo.dir, false);
  const untracked = snapshot.unstaged.find((c) => c.path === 'fresh.txt');

  await assert.rejects(git.discard(repo.dir, untracked), /not tracked/);
  assert.equal(repo.read('fresh.txt'), 'new\n', 'still on disk');
});

// ------------------------------------------------------- untrackedToRemove

/** Untracked files in a folder, a wholly untracked directory, and more. */
function repoWithUntrackedFolder() {
  const repo = new TestRepo();
  repo.write('src/kept.cs', 'tracked\n');
  repo.write('other/kept.cs', 'tracked\n');
  repo.write('.gitignore', '*.log\n');
  repo.commit('Initial');
  repo.write('src/loose.cs', 'new\n');
  repo.write('src/fresh/a.cs', 'new\n');
  repo.write('src/fresh/deeper/b.cs', 'new\n');
  repo.write('src/build.log', 'ignored\n');
  repo.write('other/elsewhere.cs', 'new\n');
  return repo;
}

test('a folder discard removes its untracked files, a new directory as one entry', async (t) => {
  const repo = repoWithUntrackedFolder();
  t.after(() => repo.dispose());
  assert.deepEqual((await git.untrackedToRemove(repo.dir, 'src')).sort(), [
    'src/fresh',
    'src/loose.cs',
  ]);
});

test('a folder discard leaves ignored files and files outside the folder alone', async (t) => {
  const repo = repoWithUntrackedFolder();
  t.after(() => repo.dispose());
  const entries = await git.untrackedToRemove(repo.dir, 'src');
  assert.ok(!entries.includes('src/build.log'), 'clean leaves ignored files without -x');
  assert.ok(!entries.some((e) => e.startsWith('other/')));
});

test('the repository root, spelled ".", takes every untracked file', async (t) => {
  const repo = repoWithUntrackedFolder();
  t.after(() => repo.dispose());
  assert.deepEqual((await git.untrackedToRemove(repo.dir, '.')).sort(), [
    'other/elsewhere.cs',
    'src/fresh',
    'src/loose.cs',
  ]);
});

test('a nested repository is never binned with the folder that holds it', async (t) => {
  // git clean -fd refuses one without a second -f; binning it would take its
  // whole history.
  const repo = repoWithUntrackedFolder();
  t.after(() => repo.dispose());
  const nested = path.join(repo.dir, 'src', 'vendored');
  fs.mkdirSync(nested, { recursive: true });
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: nested });
  fs.writeFileSync(path.join(nested, 'lib.cs'), 'x\n');

  const entries = await git.untrackedToRemove(repo.dir, 'src');
  assert.ok(!entries.some((e) => e.startsWith('src/vendored')), entries.join(', '));
  assert.ok(entries.includes('src/loose.cs'), 'the rest of the folder still goes');
});

test('the graph of a real merge keeps every line continuous', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());

  repo.write('f.txt', 'base\n');
  repo.commit('Base');
  for (let i = 0; i < 3; i++) {
    repo.git(['checkout', '-q', '-b', `side-${i}`]);
    repo.write(`side-${i}.txt`, 'x\n');
    repo.commit(`Side ${i}`);
    repo.git(['checkout', '-q', 'main']);
    repo.write('f.txt', `main ${i}\n`);
    repo.commit(`Main ${i}`);
    repo.git(['merge', '-q', '--no-ff', '-m', `Merge side-${i}`, `side-${i}`]);
  }

  const model = await readGraph(git, repo.dir, 'main', 100);
  assertLanesInRange(model.rows, model.maxLanes, 'real merge graph');
  const checked = assertLaneContinuity(model.rows, 'real merge graph');

  assert.ok(model.rows.length >= 10, 'the history is big enough to be interesting');
  assert.ok(checked > 0, 'parent edges were actually checked');
  assert.equal(model.rows[model.rows.length - 1].lane, 0, 'the base sits leftmost');
  assert.ok(model.maxLanes <= 2, `repeated merges must not accumulate lanes (${model.maxLanes})`);
});

test('readRefs classifies heads, remotes and tags, and marks the current branch', async (t) => {
  const origin = new TestRepo();
  const clone = new TestRepo();
  t.after(() => {
    origin.dispose();
    clone.dispose();
  });

  origin.write('a.txt', 'a\n');
  origin.commit('Initial');
  clone.git(['remote', 'add', 'origin', origin.dir]);
  clone.git(['fetch', '-q', 'origin']);
  clone.git(['checkout', '-q', '-B', 'main', 'origin/main']);
  clone.git(['branch', 'feature/nested']);
  clone.git(['tag', 'v1.0']);

  const refs = await readRefs(git, clone.dir);
  const byShort = new Map(refs.map((r) => [r.short, r]));

  assert.equal(byShort.get('main').kind, 'head');
  assert.equal(byShort.get('main').current, true);
  assert.equal(byShort.get('feature/nested').kind, 'head');
  assert.equal(byShort.get('feature/nested').current, false);
  assert.equal(byShort.get('origin/main').kind, 'remote');
  assert.equal(byShort.get('v1.0').kind, 'tag');
  assert.ok(!refs.some((r) => r.short.endsWith('/HEAD')), 'origin/HEAD is not a branch');
});

/** A repository with one linked worktree beside it, on its own branch. */
function repoWithWorktree(t) {
  const repo = new TestRepo();
  const linked = repo.dir + '-linked';
  t.after(() => {
    fs.rmSync(linked, { recursive: true, force: true });
    repo.dispose();
  });
  repo.write('src/Shared.cs', 'one\n');
  repo.commit('Initial');
  repo.git(['worktree', 'add', '-q', '-b', 'feature', linked]);
  return { repo, linked };
}

test('a repository with no linked worktree lists none', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');
  repo.write('a.txt', 'changed\n');

  assert.deepEqual(await readWorktrees(git, repo.dir), []);
});

test('each worktree reports its own branch and only its own changes', async (t) => {
  const { repo, linked } = repoWithWorktree(t);
  fs.writeFileSync(path.join(linked, 'src', 'Shared.cs'), 'edited in the worktree\n');
  fs.writeFileSync(path.join(linked, 'New.cs'), 'new\n');

  const [main, other] = await readWorktrees(git, repo.dir);

  assert.equal(main.branch, 'main');
  assert.equal(main.current, true);
  assert.equal(main.total, 0);
  assert.equal(main.note, 'No changes.');

  assert.equal(other.branch, 'feature');
  assert.equal(other.current, false);
  assert.equal(other.name, path.basename(linked));
  assert.deepEqual(
    other.files.map((f) => f.path + ' ' + f.status),
    ['New.cs U', 'src/Shared.cs M']
  );
});

test('the window opened on a linked worktree marks that one as current', async (t) => {
  const { linked } = repoWithWorktree(t);
  const worktrees = await readWorktrees(git, linked);
  assert.deepEqual(worktrees.map((w) => w.current), [false, true]);
});

test('a worktree whose directory is gone is listed as missing, not as a failure', async (t) => {
  const { repo, linked } = repoWithWorktree(t);
  fs.rmSync(linked, { recursive: true, force: true });

  const [, gone] = await readWorktrees(git, repo.dir);
  assert.equal(gone.note, 'The directory is missing.');
  assert.deepEqual(gone.files, []);
});

test('commit details cover a merge, an ordinary commit and the root', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());

  repo.write('root.txt', 'root\n');
  const root = repo.commit('Root commit');
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.write('side.txt', 'side\n');
  repo.commit('Side commit');
  repo.git(['checkout', '-q', 'main']);
  repo.write('main.txt', 'main\n');
  const ordinary = repo.commit('Ordinary commit');
  repo.git(['merge', '-q', '--no-ff', '-m', 'Merge side', 'side']);
  const merge = repo.git(['rev-parse', 'HEAD']).trim();

  const rootDetails = await readCommitDetails(git, repo.dir, root);
  assert.equal(rootDetails.parents.length, 0);
  assert.deepEqual(
    rootDetails.files.map((f) => f.path),
    ['root.txt'],
    'the root commit must list its own files'
  );

  const ordinaryDetails = await readCommitDetails(git, repo.dir, ordinary);
  assert.equal(ordinaryDetails.isMerge, false);
  assert.deepEqual(ordinaryDetails.files.map((f) => f.path), ['main.txt']);
  assert.equal(ordinaryDetails.subject, 'Ordinary commit');

  const mergeDetails = await readCommitDetails(git, repo.dir, merge);
  assert.equal(mergeDetails.isMerge, true);
  assert.equal(mergeDetails.parents.length, 2);
  assert.deepEqual(
    mergeDetails.files.map((f) => f.path),
    ['side.txt'],
    'a merge lists its diff against the first parent, not nothing'
  );
});

test('a self-hosted provider is recognised from a committed CI file', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('.gitlab-ci.yml', 'stages: [build]\n');
  repo.commit('Add CI');
  repo.git(['remote', 'add', 'origin', 'https://git.example.hr/group/repo.git']);

  const auto = await readReviewInfo(git, repo.dir, 'auto');
  assert.equal(auto.host, 'git.example.hr');
  assert.equal(auto.provider, 'gitlab', 'the host alone cannot say this, the CI file can');
  assert.equal(auto.label, 'Merge Requests');

  const forced = await readReviewInfo(git, repo.dir, 'github');
  assert.equal(forced.provider, 'github', 'the setting overrides detection');
  assert.equal(forced.label, 'Pull Requests');
});

test('a repository with no origin does not claim a provider', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');

  const info = await readReviewInfo(git, repo.dir, 'auto');
  assert.equal(info.host, undefined);
  assert.equal(info.provider, 'unknown');
});

// --------------------------------------------- several branches in one graph

/** A repository with two branches that diverged after a shared base. */
function repoWithTwoBranches() {
  const repo = new TestRepo();
  repo.write('base.txt', 'base\n');
  repo.commit('Base');

  repo.git(['checkout', '-q', '-b', 'feature/one']);
  repo.write('one.txt', 'one\n');
  repo.commit('Only on feature/one');

  repo.git(['checkout', '-q', 'main']);
  repo.write('main.txt', 'main\n');
  repo.commit('Only on main');
  return repo;
}

test('a graph of one branch does not show another branch commits', async (t) => {
  const repo = repoWithTwoBranches();
  t.after(() => repo.dispose());

  const graph = await readGraph(git, repo.dir, 'main', 50);
  const subjects = graph.rows.map((r) => r.commit.subject);
  assert.ok(subjects.includes('Only on main'));
  assert.ok(!subjects.includes('Only on feature/one'), 'the other branch is not in scope');
  assert.deepEqual(graph.extras, []);
});

test('toggling a branch in brings its commits into the same graph', async (t) => {
  const repo = repoWithTwoBranches();
  t.after(() => repo.dispose());

  const graph = await readGraph(git, repo.dir, 'main', 50, undefined, ['feature/one']);
  const subjects = graph.rows.map((r) => r.commit.subject);

  assert.ok(subjects.includes('Only on main'), 'the scope is still there');
  assert.ok(subjects.includes('Only on feature/one'), 'and so is the branch toggled in');
  assert.deepEqual(graph.extras, ['feature/one']);
  assert.ok(graph.maxLanes >= 2, 'they are drawn as separate lanes');
});

test('the shared base is one commit, not one per branch', async (t) => {
  const repo = repoWithTwoBranches();
  t.after(() => repo.dispose());

  const graph = await readGraph(git, repo.dir, 'main', 50, undefined, ['feature/one']);
  const bases = graph.rows.filter((r) => r.commit.subject === 'Base');
  assert.equal(bases.length, 1);
});

test('the scope is what incoming and outgoing are still measured against', async (t) => {
  const repo = repoWithTwoBranches();
  t.after(() => repo.dispose());

  const graph = await readGraph(git, repo.dir, 'main', 50, undefined, ['feature/one']);
  assert.equal(graph.scope, 'main', 'toggling a branch in does not change the scope');
});

test('a branch toggled in twice, or equal to the scope, is counted once', async (t) => {
  const repo = repoWithTwoBranches();
  t.after(() => repo.dispose());

  const graph = await readGraph(git, repo.dir, 'main', 50, undefined, [
    'feature/one',
    'feature/one',
    'main',
    '',
  ]);
  assert.deepEqual(graph.extras, ['feature/one'], 'duplicates, the scope and blanks are dropped');
});

// ------------------------------------------------------------ folder history

test('a folder path gives the history of everything under it', async (t) => {
  // "View History" on a folder row sends a directory where the file rows send
  // a file, and readGraph passes --follow either way. git documents --follow
  // for a single file; with a directory it simply finds no rename to follow.
  // If that ever stops being true, folder history breaks, so it is pinned.
  const repo = new TestRepo();
  t.after(() => repo.dispose());

  repo.write('src/api/one.ts', 'one\n');
  repo.write('docs/note.md', 'note\n');
  repo.commit('Initial');

  repo.write('src/api/two.ts', 'two\n');
  repo.commit('Touches the folder');

  repo.write('docs/note.md', 'changed\n');
  repo.commit('Touches somewhere else');

  const graph = await readGraph(git, repo.dir, 'main', 50, 'src/api');
  const subjects = graph.rows.map((r) => r.commit.subject);

  assert.ok(subjects.includes('Touches the folder'));
  assert.ok(subjects.includes('Initial'), 'the commit that created it counts too');
  assert.ok(
    !subjects.includes('Touches somewhere else'),
    'and a commit that missed the folder does not'
  );
  assert.equal(graph.file, 'src/api', 'the breadcrumb still says what it is scoped to');
});

test('a folder with no history of its own comes back empty, not broken', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'a\n');
  repo.commit('Initial');

  const graph = await readGraph(git, repo.dir, 'main', 50, 'never/existed');
  assert.deepEqual(graph.rows, []);
});

// ------------------------------------------------------------ blobs and revs

test('a file saved in another encoding comes back as the bytes git holds', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  // "čaša" in Windows-1250: not valid UTF-8, so a decode on the way through
  // would turn each of these bytes into U+FFFD.
  const bytes = Buffer.from([0xe8, 0x61, 0x9a, 0x61, 0x0a]);
  repo.write('cp1250.txt', bytes);
  repo.commit('Initial');

  const read = await git.execBytes(repo.dir, ['cat-file', 'blob', 'HEAD:cp1250.txt']);
  assert.deepEqual([...read], [...bytes]);
});

test('a moving name is pinned to the commit it names when asked', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'one\n');
  const first = repo.commit('First');

  const pinned = await git.resolveCommit(repo.dir, 'HEAD');
  repo.write('a.txt', 'two\n');
  repo.commit('Second');

  assert.equal(pinned, first);
  assert.equal(await git.resolveCommit(repo.dir, 'main'), repo.git(['rev-parse', 'HEAD']).trim());
});

test('an annotated tag is pinned to its commit, not to the tag object', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('a.txt', 'one\n');
  const commitHash = repo.commit('First');
  repo.git(['tag', '-a', 'v1', '-m', 'Version one']);

  assert.equal(await git.resolveCommit(repo.dir, 'v1'), commitHash);
});

test('a name with no commit behind it pins to nothing', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  assert.equal(await git.resolveCommit(repo.dir, 'HEAD'), undefined, 'unborn HEAD');
  repo.write('a.txt', 'one\n');
  repo.commit('First');
  assert.equal(await git.resolveCommit(repo.dir, 'no-such-branch'), undefined);
});
