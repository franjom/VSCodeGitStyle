'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { countChanges, Git } = require('../out/git.js');
const { readGraph, readRefs, readCommitDetails, readReviewInfo } = require('../out/graph.js');
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

test('the badge counts each changed file once, ignoring ignored files', async (t) => {
  const repo = repoWithEveryChange();
  t.after(() => repo.dispose());
  repo.write('.gitignore', 'bin/\n');
  repo.write('bin/output.dll', 'binary\n');

  const snapshot = await git.snapshot(repo.dir, true);
  assert.ok(
    snapshot.unstaged.some((c) => c.status === 'ignored'),
    'the ignored file is in the list the panel shows'
  );

  // Added, Both, Deleted, Modified, Untracked, new name, .gitignore - and
  // Both.cs is staged as well as edited again, so it must not count twice.
  assert.equal(countChanges(snapshot), 7);
  assert.equal(await git.changeCount(repo.dir), 7, 'the cheap count agrees');
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

test('discard reverts a tracked file and deletes an untracked one', async (t) => {
  const repo = new TestRepo();
  t.after(() => repo.dispose());
  repo.write('tracked.txt', 'base\n');
  repo.commit('Initial');
  repo.write('tracked.txt', 'edited\n');
  repo.write('fresh.txt', 'new\n');

  const snapshot = await git.snapshot(repo.dir, false);
  const tracked = snapshot.unstaged.find((c) => c.path === 'tracked.txt');
  const untracked = snapshot.unstaged.find((c) => c.path === 'fresh.txt');

  await git.discard(repo.dir, tracked);
  await git.discard(repo.dir, untracked);

  assert.equal(repo.read('tracked.txt'), 'base\n');
  const after = await git.snapshot(repo.dir, false);
  assert.equal(after.unstaged.length, 0);
  assert.equal(after.staged.length, 0);
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
