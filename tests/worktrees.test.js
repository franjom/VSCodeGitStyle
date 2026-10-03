'use strict';

/*
 * What can be decided about worktrees from captured output: the porcelain
 * listing, the folding of a status into one row per path, and the cap. The
 * reader that runs git is in readers.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWorktreeList, worktreeFiles, samePath } = require('../out/git/worktrees.js');

function lists(parts) {
  return Object.assign({ staged: [], unstaged: [], conflicts: [] }, parts);
}
function change(path, status, staged, origPath) {
  return { path, status, staged, origPath };
}

test('the main worktree, one on a branch and one detached are read apart', () => {
  const entries = parseWorktreeList(
    [
      'worktree D:/DungeonKeeperRemake',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/master',
      '',
      'worktree D:/DungeonKeeperRemake-l3',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/l3-lord-fight',
      '',
      'worktree D:/scratch',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n')
  );

  assert.deepEqual(
    entries.map((e) => [e.path, e.branch, e.detached]),
    [
      ['D:/DungeonKeeperRemake', 'refs/heads/master', false],
      ['D:/DungeonKeeperRemake-l3', 'refs/heads/l3-lord-fight', false],
      ['D:/scratch', undefined, true],
    ]
  );
});

test('a bare main repository and a worktree whose directory is gone are flagged', () => {
  const entries = parseWorktreeList(
    [
      'worktree /srv/repo.git',
      'bare',
      '',
      'worktree /tmp/gone',
      'HEAD 4444444444444444444444444444444444444444',
      'branch refs/heads/x',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\r\n')
  );

  assert.deepEqual(
    entries.map((e) => [e.path, e.bare, e.prunable]),
    [
      ['/srv/repo.git', true, false],
      ['/tmp/gone', false, true],
    ]
  );
});

test('a path with spaces in it is kept whole', () => {
  const [entry] = parseWorktreeList('worktree C:/My Projects/repo two\nHEAD 5\nbranch refs/heads/m\n');
  assert.equal(entry.path, 'C:/My Projects/repo two');
});

test('a new file staged and edited again is one row, and it is added', () => {
  const { files } = worktreeFiles(
    lists({
      staged: [change('src/New.cs', 'added', true)],
      unstaged: [change('src/New.cs', 'modified', false)],
    })
  );
  assert.deepEqual(files, [{ path: 'src/New.cs', origPath: undefined, status: 'A' }]);
});

test('a file deleted from disk is D even when an edit to it is staged', () => {
  const { files } = worktreeFiles(
    lists({
      staged: [change('src/Gone.cs', 'modified', true)],
      unstaged: [change('src/Gone.cs', 'deleted', false)],
    })
  );
  assert.deepEqual(files.map((f) => f.status), ['D']);
});

test('a rename keeps the path it came from', () => {
  const { files } = worktreeFiles(
    lists({ staged: [change('src/new.cs', 'renamed', true, 'src/old.cs')] })
  );
  assert.deepEqual(files, [{ path: 'src/new.cs', origPath: 'src/old.cs', status: 'R' }]);
});

test('untracked files are listed and ignored ones are not', () => {
  const { files, total } = worktreeFiles(
    lists({
      unstaged: [change('notes.txt', 'untracked', false), change('bin/x.dll', 'ignored', false)],
    })
  );
  assert.deepEqual(files.map((f) => f.status), ['U']);
  assert.equal(total, 1);
});

test('when every row is a change, the cap holds and says how many it left out', () => {
  const unstaged = [];
  for (let i = 0; i < 2000; i++) {
    unstaged.push(change('f/' + String(i).padStart(4, '0') + '.txt', 'untracked', false));
  }
  const { files, total } = worktreeFiles(lists({ unstaged }), 500);
  assert.equal(files.length, 500);
  assert.equal(total, 2000);
});

test('conflicts survive the cap ahead of every other change', () => {
  const unstaged = [];
  for (let i = 0; i < 10; i++) {
    unstaged.push(change('a/' + i + '.txt', 'modified', false));
  }
  const { files } = worktreeFiles(
    lists({ unstaged, conflicts: [change('z/Merge.cs', 'conflict', false)] }),
    3
  );
  assert.deepEqual(files.map((f) => f.path), ['z/Merge.cs', 'a/0.txt', 'a/1.txt']);
});

test("git's D:/repo and VS Code's d:\\repo are one directory on Windows", () => {
  assert.equal(samePath('D:/DungeonKeeperRemake', 'd:\\DungeonKeeperRemake\\', true), true);
  assert.equal(samePath('D:/DungeonKeeperRemake', 'D:/DungeonKeeperRemake-l3', true), false);
});

test('case still tells two directories apart where the file system does', () => {
  assert.equal(samePath('/home/me/Repo', '/home/me/repo', false), false);
});
