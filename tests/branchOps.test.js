'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { branchArgs, confirmation, branchMenu } = require('../out/git/branchOps.js');

const local = (short, extra) =>
  Object.assign({ short, kind: 'head', current: false }, extra);
const remote = (short) => ({ short, kind: 'remote', current: false });
const tag = (short) => ({ short, kind: 'tag', current: false });

const ctx = (target, extra) => Object.assign({ target, current: 'main' }, extra);

// ------------------------------------------------------------------ commands

test('checkout moves onto a local branch', () => {
  assert.deepEqual(branchArgs('checkout', ctx(local('feature/x'))), ['checkout', 'feature/x']);
});

test('checking out a remote branch creates the local one that tracks it', () => {
  // There is nothing local to move onto, so --track says what git would guess.
  assert.deepEqual(branchArgs('checkout', ctx(remote('origin/feature/x'))), [
    'checkout',
    '--track',
    'origin/feature/x',
  ]);
});

test('the detached checkout asks for the tip, not the branch', () => {
  assert.deepEqual(branchArgs('checkoutDetach', ctx(local('release'))), [
    'checkout',
    '--detach',
    'release',
  ]);
});

test('creating and renaming need a name and say so without one', () => {
  assert.deepEqual(branchArgs('createBranch', ctx(local('main'), { name: 'fix/1' })), [
    'branch',
    'fix/1',
    'main',
  ]);
  assert.equal(branchArgs('createBranch', ctx(local('main'))), null);

  assert.deepEqual(branchArgs('rename', ctx(local('old'), { name: 'new' })), [
    'branch',
    '-m',
    'old',
    'new',
  ]);
  assert.equal(branchArgs('rename', ctx(local('old'))), null);
});

test('the three resets differ only in their flag', () => {
  assert.deepEqual(branchArgs('resetSoft', ctx(local('x'))), ['reset', '--soft', 'x']);
  assert.deepEqual(branchArgs('resetMixed', ctx(local('x'))), ['reset', '--mixed', 'x']);
  assert.deepEqual(branchArgs('resetHard', ctx(local('x'))), ['reset', '--hard', 'x']);
});

test('deleting a local branch refuses unmerged work until forced', () => {
  assert.deepEqual(branchArgs('delete', ctx(local('x'))), ['branch', '-d', 'x']);
  assert.deepEqual(branchArgs('deleteForce', ctx(local('x'))), ['branch', '-D', 'x']);
});

test('deleting a remote branch pushes the deletion, split into remote and name', () => {
  assert.deepEqual(branchArgs('delete', ctx(remote('origin/feature/x'))), [
    'push',
    '--delete',
    'origin',
    'feature/x',
  ]);
});

test('a worktree needs somewhere to go', () => {
  assert.deepEqual(branchArgs('newWorktree', ctx(local('x'), { path: 'D:/wt/x' })), [
    'worktree',
    'add',
    'D:/wt/x',
    'x',
  ]);
  assert.equal(branchArgs('newWorktree', ctx(local('x'))), null);
});

test('a merge is always recorded, never fast-forwarded away', () => {
  assert.deepEqual(branchArgs('merge', ctx(local('x'))), ['merge', '--no-ff', 'x']);
});

test('a pull only fast-forwards, so it can never start a merge by surprise', () => {
  assert.deepEqual(branchArgs('pull', ctx(local('x'))), ['pull', '--ff-only']);
});

test("the window's own actions have no git command", () => {
  for (const op of ['viewHistory', 'compare', 'toggleInHistory', 'sync']) {
    assert.equal(branchArgs(op, ctx(local('x'))), null, op);
  }
});

test('a branch named like a flag stays an argument', () => {
  // Nothing is interpolated into a string, so this is an argument to git and
  // not an option, however it reads.
  const args = branchArgs('checkout', ctx(local('--upload-pack=evil')));
  assert.deepEqual(args, ['checkout', '--upload-pack=evil']);
  assert.equal(args.length, 2, 'it is one argument, not two');
});

// ------------------------------------------------------------- confirmations

test('what can be walked back is not worth asking about', () => {
  for (const op of ['checkout', 'checkoutDetach', 'createBranch', 'fetch', 'push', 'viewHistory']) {
    assert.equal(confirmation(op, ctx(local('x'))), null, op);
  }
});

test('what costs work asks first', () => {
  for (const op of ['merge', 'rebase', 'resetSoft', 'resetMixed', 'resetHard', 'cherryPick', 'delete']) {
    assert.ok(confirmation(op, ctx(local('x'))), op + ' should confirm');
  }
});

test('only what git cannot undo is marked destructive', () => {
  assert.equal(confirmation('resetHard', ctx(local('x'))).destructive, true);
  assert.equal(confirmation('rebase', ctx(local('x'))).destructive, true);
  assert.equal(confirmation('deleteForce', ctx(local('x'))).destructive, true);

  assert.ok(!confirmation('merge', ctx(local('x'))).destructive, 'a merge is recoverable');
  assert.ok(!confirmation('resetSoft', ctx(local('x'))).destructive);
});

test('a confirmation names both branches, so the direction is unambiguous', () => {
  const merge = confirmation('merge', ctx(local('feature/x')));
  assert.equal(merge.message, "Merge 'feature/x' into 'main'?");

  const rebase = confirmation('rebase', ctx(local('feature/x')));
  assert.equal(rebase.message, "Rebase 'main' onto 'feature/x'?");
});

test('deleting a remote branch says it affects everyone', () => {
  const remoteDelete = confirmation('delete', ctx(remote('origin/x')));
  assert.match(remoteDelete.detail, /remote, for everyone/);
  assert.equal(remoteDelete.destructive, true);
  assert.ok(!confirmation('delete', ctx(local('x'))).destructive, 'a local one is recoverable');
});

test('the hard reset says the work cannot come back', () => {
  assert.match(confirmation('resetHard', ctx(local('x'))).detail, /cannot bring it back/);
  assert.equal(confirmation('resetHard', ctx(local('x'))).confirm, 'Discard and Reset');
});

// --------------------------------------------------------------------- menu

const opsOf = (menu) => menu.map((e) => e.op);
const find = (menu, op) => menu.find((e) => e.op === op);

test('the menu offers Visual Studio 2026 list, less Add to Chat', () => {
  const ops = opsOf(branchMenu(local('feature/x'), 'main'));
  for (const op of [
    'checkout', 'checkoutDetach', 'createBranch', 'merge', 'rebase',
    'resetSoft', 'resetMixed', 'resetHard', 'cherryPick', 'rename', 'delete',
    'viewHistory', 'compare', 'toggleInHistory', 'fetch', 'pull', 'push',
    'sync', 'newWorktree',
  ]) {
    assert.ok(ops.includes(op), 'missing ' + op);
  }
  assert.ok(!ops.some((op) => /chat/i.test(op)), 'and nothing about chat');
});

test('what cannot apply is disabled with a reason, not hidden', () => {
  // A menu that changes shape teaches nothing about why an action is missing.
  const menu = branchMenu(local('main', { current: true }), 'main');
  assert.equal(menu.length, branchMenu(local('other'), 'main').length, 'same shape either way');

  assert.equal(find(menu, 'checkout').disabled, true);
  assert.match(find(menu, 'checkout').why, /Already checked out/);
  assert.equal(find(menu, 'delete').disabled, true);
  assert.equal(find(menu, 'merge').disabled, true, 'a branch cannot merge into itself');
});

test('the current branch is the one that can push and pull', () => {
  const other = branchMenu(local('feature/x', { upstream: 'origin/feature/x' }), 'main');
  assert.equal(find(other, 'push').disabled, true);
  assert.match(find(other, 'push').why, /Checkout the branch first/);

  const mine = branchMenu(
    local('main', { current: true, upstream: 'origin/main' }),
    'main'
  );
  assert.ok(!find(mine, 'push').disabled);
  assert.ok(!find(mine, 'pull').disabled);
});

test('a branch with no upstream cannot pull or sync', () => {
  const menu = branchMenu(local('local-only', { current: true }), 'local-only');
  assert.equal(find(menu, 'pull').disabled, true);
  assert.match(find(menu, 'pull').why, /no upstream/);
  assert.equal(find(menu, 'sync').disabled, true);
});

test('a detached HEAD disables what needs a branch to act on', () => {
  const menu = branchMenu(local('feature/x'), undefined);
  assert.equal(find(menu, 'merge').disabled, true);
  assert.match(find(menu, 'merge').why, /detached/);
  assert.equal(find(menu, 'rebase').disabled, true);
  assert.ok(!find(menu, 'checkout').disabled, 'but checking out is how you leave it');
});

test('labels say which branch and in which direction', () => {
  const menu = branchMenu(local('feature/x'), 'Test_alpha');
  assert.equal(find(menu, 'merge').label, "Merge 'feature/x' into 'Test_alpha'");
  assert.equal(find(menu, 'rebase').label, "Rebase 'Test_alpha' onto 'feature/x'");
  assert.equal(find(menu, 'compare').label, "Compare 'feature/x' with 'Test_alpha'…");
});

test('a remote branch is checked out by creating a local one', () => {
  const menu = branchMenu(remote('origin/feature/x'), 'main');
  assert.equal(find(menu, 'checkout').label, "Checkout and Track 'origin/feature/x'");
  assert.equal(find(menu, 'rename').disabled, true);
});

test('a tag drops the entries that mean nothing for one', () => {
  const ops = opsOf(branchMenu(tag('v1.0'), 'main'));
  for (const gone of ['merge', 'rename', 'pull', 'push', 'sync']) {
    assert.ok(!ops.includes(gone), gone + ' has no meaning for a tag');
  }
  for (const kept of ['checkout', 'createBranch', 'cherryPick', 'viewHistory', 'newWorktree']) {
    assert.ok(ops.includes(kept), kept + ' still does');
  }
});

test('every entry the menu offers can be acted on', () => {
  // Either it produces a git command or the window handles it itself; an entry
  // that does neither would be a button that does nothing.
  const handled = ['viewHistory', 'compare', 'toggleInHistory', 'sync'];
  for (const entry of branchMenu(local('feature/x'), 'main')) {
    const args = branchArgs(entry.op, ctx(local('feature/x'), { name: 'n', path: 'p' }));
    assert.ok(
      args !== null || handled.includes(entry.op),
      entry.op + ' has neither a command nor a handler'
    );
  }
});

test('every disabled entry gives a reason', () => {
  for (const target of [local('x', { current: true }), remote('origin/x'), tag('v1')]) {
    for (const entry of branchMenu(target, 'main')) {
      if (entry.disabled) {
        assert.ok(entry.why, entry.op + ' is disabled without saying why');
      }
    }
  }
});
