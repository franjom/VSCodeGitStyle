'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStatus } = require('../out/git.js');
const {
  parseLog,
  parseNameStatus,
  remoteHost,
  providerFromHost,
  labelForProvider,
} = require('../out/graph.js');
const { NUL, porcelain } = require('./helpers.js');

const UNIT = String.fromCharCode(31);
const RECORD = String.fromCharCode(30);

test('parseStatus splits the index and worktree columns', () => {
  const out = porcelain([
    '1 M. N... 100644 100644 100644 aaa bbb src/Staged.cs',
    '1 .M N... 100644 100644 100644 aaa bbb src/Worktree.cs',
  ]);
  const result = parseStatus(out);

  assert.deepEqual(
    result.staged.map((c) => c.path),
    ['src/Staged.cs']
  );
  assert.deepEqual(
    result.unstaged.map((c) => c.path),
    ['src/Worktree.cs']
  );
  assert.equal(result.staged[0].staged, true);
  assert.equal(result.unstaged[0].staged, false);
});

test('parseStatus puts a staged-then-edited file in both lists', () => {
  // This is the case a single entry with a boolean cannot represent.
  const result = parseStatus(
    porcelain(['1 MM N... 100644 100644 100644 aaa bbb src/Both.cs'])
  );

  assert.deepEqual(result.staged.map((c) => c.path), ['src/Both.cs']);
  assert.deepEqual(result.unstaged.map((c) => c.path), ['src/Both.cs']);
  assert.equal(result.staged[0].status, 'modified');
  assert.equal(result.unstaged[0].status, 'modified');
});

test('parseStatus reads a rename, including paths containing spaces', () => {
  const result = parseStatus(
    '2 R. N... 100644 100644 100644 aaa bbb R100 dir one/new name.cs' +
      NUL +
      'dir one/old name.cs' +
      NUL
  );

  assert.equal(result.staged.length, 1);
  assert.equal(result.staged[0].status, 'renamed');
  assert.equal(result.staged[0].path, 'dir one/new name.cs');
  assert.equal(result.staged[0].origPath, 'dir one/old name.cs');
  assert.equal(result.unstaged.length, 0);
});

test('parseStatus keeps a rename record from swallowing the next entry', () => {
  // The original path is a separate NUL-terminated token; mis-handling it
  // would consume the following record.
  const result = parseStatus(
    '2 R. N... 100644 100644 100644 aaa bbb R100 new.cs' +
      NUL +
      'old.cs' +
      NUL +
      '1 .M N... 100644 100644 100644 aaa bbb after.cs' +
      NUL
  );

  assert.equal(result.staged.length, 1);
  assert.deepEqual(result.unstaged.map((c) => c.path), ['after.cs']);
});

test('a rename whose old path looks like a record does not become one', () => {
  // The original path must be consumed, not merely read: a file named
  // "1 old.cs" or "? old.cs" would otherwise be re-parsed as its own entry.
  const result = parseStatus(
    '2 R. N... 100644 100644 100644 aaa bbb R100 new.cs' +
      NUL +
      '? old.cs' +
      NUL
  );

  assert.deepEqual(result.staged.map((c) => c.path), ['new.cs']);
  assert.equal(result.staged[0].origPath, '? old.cs');
  assert.deepEqual(
    result.unstaged,
    [],
    'the original path must not reappear as an untracked file'
  );
});

test('parseStatus keeps unmerged paths out of the staged and unstaged lists', () => {
  const result = parseStatus(
    porcelain([
      'u UU N... 100644 100644 100644 100644 a b c src/Conflict.cs',
      '1 M. N... 100644 100644 100644 aaa bbb src/Staged.cs',
    ])
  );

  assert.deepEqual(result.conflicts.map((c) => c.path), ['src/Conflict.cs']);
  assert.equal(result.conflicts[0].status, 'conflict');
  assert.ok(!result.staged.some((c) => c.path === 'src/Conflict.cs'));
  assert.ok(!result.unstaged.some((c) => c.path === 'src/Conflict.cs'));
});

test('parseStatus maps the status letters', () => {
  const result = parseStatus(
    porcelain([
      '1 A. N... 100644 100644 100644 aaa bbb added.cs',
      '1 D. N... 100644 100644 100644 aaa bbb deleted.cs',
      '1 .T N... 100644 100644 100644 aaa bbb typechange.cs',
      '? untracked.cs',
      '! ignored.cs',
    ])
  );

  const byPath = new Map(
    [...result.staged, ...result.unstaged].map((c) => [c.path, c.status])
  );
  assert.equal(byPath.get('added.cs'), 'added');
  assert.equal(byPath.get('deleted.cs'), 'deleted');
  assert.equal(byPath.get('typechange.cs'), 'modified');
  assert.equal(byPath.get('untracked.cs'), 'untracked');
  assert.equal(byPath.get('ignored.cs'), 'ignored');
});

test('parseStatus normalises separators and sorts by path', () => {
  const result = parseStatus(
    porcelain([
      '1 .M N... 100644 100644 100644 aaa bbb zeta.cs',
      '1 .M N... 100644 100644 100644 aaa bbb alpha.cs',
    ])
  );
  assert.deepEqual(result.unstaged.map((c) => c.path), ['alpha.cs', 'zeta.cs']);
});

test('parseStatus tolerates empty output', () => {
  const result = parseStatus('');
  assert.deepEqual(result, { staged: [], unstaged: [], conflicts: [] });
});

test('parseLog reads records, parents and decorations', () => {
  const record = (fields) => fields.join(UNIT) + RECORD;
  const out =
    record([
      'a'.repeat(40),
      'b'.repeat(40) + ' ' + 'c'.repeat(40),
      'Franjo',
      '2026-09-11T10:00:00+02:00',
      'HEAD -> main, origin/main, tag: v1.0',
      'Merge branch x',
    ]) +
    record(['b'.repeat(40), '', 'Someone', '2026-09-10T09:00:00+02:00', '', 'Root']);

  const commits = parseLog(out);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].shortHash, 'aaaaaaa');
  assert.deepEqual(commits[0].parents, ['b'.repeat(40), 'c'.repeat(40)]);
  assert.deepEqual(commits[0].refs, ['HEAD -> main', 'origin/main', 'tag: v1.0']);
  assert.equal(commits[0].subject, 'Merge branch x');
  assert.deepEqual(commits[1].parents, []);
  assert.deepEqual(commits[1].refs, []);
});

test('parseNameStatus handles renames and ordinary entries', () => {
  const out = ['R100', 'old name.cs', 'new name.cs', 'M', 'src/x.cs', 'A', 'src/y.cs', ''].join(NUL);
  const files = parseNameStatus(out);

  // The list is sorted by path, so the rename comes first here.
  assert.deepEqual(files, [
    { status: 'R', path: 'new name.cs', origPath: 'old name.cs' },
    { status: 'M', path: 'src/x.cs' },
    { status: 'A', path: 'src/y.cs' },
  ]);
});

test('parseNameStatus ignores a truncated trailing record', () => {
  const files = parseNameStatus(['M', 'src/x.cs', 'R100', 'only-one-path'].join(NUL));
  assert.deepEqual(files.map((f) => f.path), ['src/x.cs']);
});

test('remoteHost understands every URL shape git accepts', () => {
  assert.equal(remoteHost('https://git.example.hr/group/repo.git'), 'git.example.hr');
  assert.equal(remoteHost('https://user@git.example.hr/group/repo.git'), 'git.example.hr');
  assert.equal(remoteHost('git@git.example.hr:group/repo.git'), 'git.example.hr');
  assert.equal(remoteHost('ssh://git@git.example.hr:2222/group/repo.git'), 'git.example.hr');
  assert.equal(remoteHost('D:/local/bare.git'), undefined);
  assert.equal(remoteHost(''), undefined);
});

test('providerFromHost only claims hosts it can actually recognise', () => {
  assert.equal(providerFromHost('github.com'), 'github');
  assert.equal(providerFromHost('gitlab.com'), 'gitlab');
  assert.equal(providerFromHost('gitlab.example.com'), 'gitlab');
  assert.equal(providerFromHost('dev.azure.com'), 'azure');
  // A self-hosted instance gives nothing away by name; this must not guess.
  assert.equal(providerFromHost('git.example.hr'), 'unknown');
  assert.equal(providerFromHost(undefined), 'unknown');
});

test('labelForProvider says merge requests only for GitLab', () => {
  assert.equal(labelForProvider('gitlab'), 'Merge Requests');
  assert.equal(labelForProvider('github'), 'Pull Requests');
  assert.equal(labelForProvider('azure'), 'Pull Requests');
  assert.equal(labelForProvider('unknown'), 'Pull Requests');
});
