'use strict';

/*
 * New branch and tag names, judged by git's own check-ref-format - so these
 * run real git, in a real repository, since that is where --branch behaves
 * differently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Git } = require('../out/git/git.js');
const { refNameProblem } = require('../out/git/refNames.js');
const { TestRepo } = require('./helpers.js');

const git = new Git('git');

/** A repository that has switched branches once, so "@{-1}" means something. */
function repoWithPreviousBranch() {
  const repo = new TestRepo();
  repo.write('a.txt', 'one\n');
  repo.commit('First');
  repo.git(['checkout', '-q', '-b', 'other']);
  repo.git(['checkout', '-q', 'main']);
  return repo;
}

test('an ordinary branch name, slashes and all, is accepted', async (t) => {
  const repo = repoWithPreviousBranch();
  t.after(() => repo.dispose());
  assert.equal(await refNameProblem(git, repo.dir, 'branch', 'feature/login-form'), undefined);
  assert.equal(await refNameProblem(git, repo.dir, 'branch', '  padded  '), undefined, 'trimmed first');
});

test('the names git refuses are refused before git is asked to make them', async (t) => {
  const repo = repoWithPreviousBranch();
  t.after(() => repo.dispose());
  for (const name of ['a..b', 'with space', 'x.lock', 'trailing.', 'a//b', 'a@{b', 'HEAD']) {
    assert.match(await refNameProblem(git, repo.dir, 'branch', name), /not a valid branch name/, name);
  }
});

test('an empty name asks for one', async (t) => {
  const repo = repoWithPreviousBranch();
  t.after(() => repo.dispose());
  assert.equal(await refNameProblem(git, repo.dir, 'branch', '   '), 'Enter a name.');
});

test('"@{-1}" is refused although git expands it to the previous branch', async (t) => {
  // check-ref-format --branch answers "other" and succeeds; the name typed was
  // not "other", so taking its exit code alone would create a wrong branch.
  const repo = repoWithPreviousBranch();
  t.after(() => repo.dispose());
  assert.match(await refNameProblem(git, repo.dir, 'branch', '@{-1}'), /not a valid/);
});

test('a lone "@" is refused although --branch lets it through', async (t) => {
  const repo = repoWithPreviousBranch();
  t.after(() => repo.dispose());
  assert.match(await refNameProblem(git, repo.dir, 'branch', '@'), /not a valid/);
});

test('a tag name is judged as a tag, and one starting with "-" is refused', async (t) => {
  // "refs/tags/-x" is a valid ref, but `git tag -x` would read it as an option.
  const repo = repoWithPreviousBranch();
  t.after(() => repo.dispose());
  assert.equal(await refNameProblem(git, repo.dir, 'tag', 'v1.0.2'), undefined);
  assert.match(await refNameProblem(git, repo.dir, 'tag', 'v1..0'), /not a valid tag name/);
  assert.match(await refNameProblem(git, repo.dir, 'tag', '-x'), /not a valid tag name/);
});
