'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  commitArgs,
  commitConfirmation,
  commitMenu,
  stepTo,
} = require('../out/git/commitOps.js');

const commit = (extra) =>
  Object.assign(
    { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Fix the badge', parents: ['b'.repeat(40)] },
    extra
  );
const merge = () => commit({ parents: ['b'.repeat(40), 'c'.repeat(40)] });
const root = () => commit({ parents: [] });
const ctx = (target, extra) => Object.assign({ target, current: 'main' }, extra);

const opsOf = (menu) => menu.map((e) => e.op);
const find = (menu, op) => menu.find((e) => e.op === op);

// ------------------------------------------------------------------ commands

test('a commit is checked out detached, by hash', () => {
  assert.deepEqual(commitArgs('checkoutDetach', ctx(commit())), [
    'checkout',
    '--detach',
    'a'.repeat(40),
  ]);
});

test('a branch or tag made here needs a name first', () => {
  assert.deepEqual(commitArgs('newBranch', ctx(commit(), { name: 'fix/1' })), [
    'branch',
    'fix/1',
    'a'.repeat(40),
  ]);
  assert.equal(commitArgs('newBranch', ctx(commit())), null);
  assert.equal(commitArgs('newTag', ctx(commit())), null);
});

test('a tag with something to say is annotated, one without is not', () => {
  // -m on its own would record a tag object with an empty message.
  assert.deepEqual(commitArgs('newTag', ctx(commit(), { name: 'v1.0' })), [
    'tag',
    'v1.0',
    'a'.repeat(40),
  ]);
  assert.deepEqual(
    commitArgs('newTag', ctx(commit(), { name: 'v1.0', message: 'First release' })),
    ['tag', '-a', 'v1.0', '-m', 'First release', 'a'.repeat(40)]
  );
});

test('reverting and cherry-picking a merge say which side to take', () => {
  // A merge has no single "before"; -m 1 means as it looked from the branch it
  // was merged into.
  assert.deepEqual(commitArgs('revert', ctx(merge())), [
    'revert',
    '--no-edit',
    '-m',
    '1',
    'a'.repeat(40),
  ]);
  assert.deepEqual(commitArgs('cherryPick', ctx(merge())), [
    'cherry-pick',
    '-m',
    '1',
    'a'.repeat(40),
  ]);
});

test('an ordinary commit needs no such thing', () => {
  assert.deepEqual(commitArgs('revert', ctx(commit())), ['revert', '--no-edit', 'a'.repeat(40)]);
  assert.deepEqual(commitArgs('cherryPick', ctx(commit())), ['cherry-pick', 'a'.repeat(40)]);
});

test('a worktree made from a commit is detached, having no branch to be on', () => {
  assert.deepEqual(commitArgs('newWorktree', ctx(commit(), { path: 'D:/wt/x' })), [
    'worktree',
    'add',
    '--detach',
    'D:/wt/x',
    'a'.repeat(40),
  ]);
});

test("the window's own entries have no git command", () => {
  for (const op of ['viewDetails', 'compare', 'goToChild', 'goToParent', 'refresh', 'outgoingOnly', 'copyId', 'viewPatch']) {
    assert.equal(commitArgs(op, ctx(commit())), null, op);
  }
});

// ------------------------------------------------------------- confirmations

test('what changes nothing is not worth asking about', () => {
  for (const op of ['viewDetails', 'newBranch', 'newTag', 'copyId', 'refresh']) {
    assert.equal(commitConfirmation(op, ctx(commit())), null, op);
  }
});

test('what rewrites or discards asks first, and names the commit', () => {
  for (const op of ['revert', 'cherryPick', 'resetSoft', 'resetMixed', 'resetHard', 'checkoutDetach']) {
    const ask = commitConfirmation(op, ctx(commit()));
    assert.ok(ask, op + ' should confirm');
    assert.match(ask.message, /aaaaaaa/, op + ' should name the commit');
  }
});

test('only the hard reset is marked destructive', () => {
  assert.equal(commitConfirmation('resetHard', ctx(commit())).destructive, true);
  assert.match(commitConfirmation('resetHard', ctx(commit())).detail, /cannot bring it back/);
  for (const op of ['revert', 'cherryPick', 'resetSoft', 'resetMixed', 'checkoutDetach']) {
    assert.ok(!commitConfirmation(op, ctx(commit())).destructive, op + ' is recoverable');
  }
});

test('a revert says the original commit stays', () => {
  assert.match(commitConfirmation('revert', ctx(commit())).detail, /left in place/);
});

test('a detached checkout explains what detached means', () => {
  assert.match(commitConfirmation('checkoutDetach', ctx(commit())).detail, /not be on a branch/);
});

// --------------------------------------------------------------------- menu

test('the menu offers what Visual Studio does, less what we cannot do', () => {
  const ops = opsOf(commitMenu(commit(), { current: 'main' }));
  for (const op of [
    'checkoutDetach', 'viewDetails', 'compare', 'newBranch', 'newTag', 'revert',
    'resetSoft', 'resetMixed', 'resetHard', 'cherryPick', 'goToChild',
    'goToParent', 'refresh', 'outgoingOnly', 'newWorktree',
  ]) {
    assert.ok(ops.includes(op), 'missing ' + op);
  }
});

test('nothing is offered that this extension cannot do', () => {
  // "Add to Chat", "Review Commit" and "Squash Commits…" are Visual Studio's
  // and not ours; a menu that offers what it cannot deliver is worse than a
  // shorter one.
  const labels = commitMenu(commit()).map((e) => e.label.toLowerCase());
  for (const absent of ['chat', 'review', 'squash']) {
    assert.ok(!labels.some((l) => l.includes(absent)), absent + ' should not be offered');
  }
});

test('the root commit disables what needs a commit before it', () => {
  const menu = commitMenu(root(), { current: 'main' });
  for (const op of ['revert', 'cherryPick', 'goToParent']) {
    assert.equal(find(menu, op).disabled, true, op);
    assert.ok(find(menu, op).why, op + ' says why');
  }
  assert.ok(!find(menu, 'newBranch').disabled, 'but a branch can still start here');
});

test('the commit HEAD is on cannot be checked out or picked again', () => {
  const menu = commitMenu(commit({ isHead: true }), { current: 'main' });
  assert.equal(find(menu, 'checkoutDetach').disabled, true);
  assert.match(find(menu, 'checkoutDetach').why, /already here/);
  assert.equal(find(menu, 'cherryPick').disabled, true);
});

test('a merge says which parent it will act against', () => {
  const menu = commitMenu(merge(), { current: 'main' });
  assert.match(find(menu, 'revert').label, /first parent/);
  assert.match(find(menu, 'cherryPick').label, /first parent/);
  assert.ok(!find(menu, 'revert').disabled, 'and it is still allowed');
});

test('the outgoing filter shows whether it is on', () => {
  assert.equal(find(commitMenu(commit(), { current: 'main' }), 'outgoingOnly').checked, false);
  assert.equal(
    find(commitMenu(commit(), { current: 'main', filtered: true }), 'outgoingOnly').checked,
    true
  );
});

test('a detached HEAD has no upstream to filter against', () => {
  const menu = commitMenu(commit(), {});
  assert.equal(find(menu, 'outgoingOnly').disabled, true);
  assert.match(find(menu, 'outgoingOnly').why, /detached/);
});

test('the two that have keyboard shortcuts say so', () => {
  const menu = commitMenu(commit(), { current: 'main' });
  assert.equal(find(menu, 'goToChild').shortcut, 'Alt+PgUp');
  assert.equal(find(menu, 'goToParent').shortcut, 'Alt+PgDn');
});

test('every entry can be acted on', () => {
  const handled = ['viewDetails', 'compare', 'goToChild', 'goToParent', 'refresh', 'outgoingOnly', 'copyId', 'viewPatch'];
  for (const entry of commitMenu(commit(), { current: 'main' })) {
    const args = commitArgs(entry.op, ctx(commit(), { name: 'n', path: 'p' }));
    assert.ok(args !== null || handled.includes(entry.op), entry.op + ' does nothing');
  }
});

test('every disabled entry gives a reason', () => {
  for (const target of [root(), commit({ isHead: true }), merge()]) {
    for (const entry of commitMenu(target, {})) {
      if (entry.disabled) {
        assert.ok(entry.why, entry.op + ' is disabled without saying why');
      }
    }
  }
});

// ------------------------------------------------------------- walking the graph

const rows = [
  { hash: 'c3', parents: ['c2'] },
  { hash: 'c2', parents: ['c1'] },
  { hash: 'c1', parents: [] },
];

test('the parent is the first one, so a merge follows the line being read', () => {
  assert.equal(stepTo('parent', 'c3', rows), 'c2');
  const merged = [{ hash: 'm', parents: ['main-side', 'feature-side'] }];
  assert.equal(stepTo('parent', 'm', merged), 'main-side');
});

test('a child has to be searched for, because a commit does not record one', () => {
  assert.equal(stepTo('child', 'c2', rows), 'c3');
  assert.equal(stepTo('child', 'c1', rows), 'c2');
});

test('the newest child is taken, so repeated steps walk back the way in', () => {
  const forked = [
    { hash: 'newer', parents: ['base'] },
    { hash: 'older', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  assert.equal(stepTo('child', 'base', forked), 'newer');
});

test('nowhere to go reports nothing rather than staying put silently', () => {
  assert.equal(stepTo('parent', 'c1', rows), null, 'the root has no parent');
  assert.equal(stepTo('child', 'c3', rows), null, 'the newest has no child');
  assert.equal(stepTo('parent', 'missing', rows), null);
});
