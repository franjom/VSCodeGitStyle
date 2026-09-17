'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  laneX,
  graphWidth,
  laneColor,
  matchesFilter,
  rankRefs,
  classifyRef,
  nestRefs,
} = require('../media/graphview.js');

const LANE_W = 14;
const PALETTE = 8;

function commit(fields) {
  return Object.assign({ subject: '', author: '', hash: '' }, fields);
}

// ------------------------------------------------------------------ geometry

test('lanes are evenly spaced from the left margin', () => {
  assert.equal(laneX(0, LANE_W), 8);
  assert.equal(laneX(1, LANE_W), 22);
  assert.equal(laneX(3, LANE_W) - laneX(2, LANE_W), LANE_W, 'the step is the lane width');
});

test('the column is wide enough for the last lane plus its tail', () => {
  assert.equal(graphWidth(4, LANE_W), laneX(3, LANE_W) + 10);
  assert.ok(graphWidth(9, LANE_W) > graphWidth(8, LANE_W), 'a busier graph is wider');
});

test('a linear history still gets a readable column', () => {
  // One lane would otherwise ask for 18px, which is narrower than the dot.
  assert.equal(graphWidth(1, LANE_W), 28);
  assert.equal(graphWidth(0, LANE_W), 28);
});

test('lane colours cycle through the palette', () => {
  assert.equal(laneColor(0, PALETTE), 'var(--vsg-lane-0)');
  assert.equal(laneColor(7, PALETTE), 'var(--vsg-lane-7)');
  assert.equal(laneColor(8, PALETTE), 'var(--vsg-lane-0)', 'it wraps');
});

test('a negative lane index still names a colour that exists', () => {
  // Indexing backwards out of the palette would name a variable nothing
  // defines, and the line would be drawn invisible.
  assert.equal(laneColor(-1, PALETTE), 'var(--vsg-lane-7)');
  assert.equal(laneColor(-9, PALETTE), 'var(--vsg-lane-7)');
});

// -------------------------------------------------------------------- filter

test('an empty filter keeps every commit', () => {
  assert.equal(matchesFilter(commit({ subject: 'anything' }), ''), true);
  assert.equal(matchesFilter(commit({ subject: 'anything' }), '   '), true);
  assert.equal(matchesFilter(commit({ subject: 'anything' }), null), true);
});

test('the filter searches subject, author and hash alike', () => {
  const c = commit({ subject: 'Fix the badge', author: 'Franjo Misetic', hash: 'abc123def' });
  assert.equal(matchesFilter(c, 'badge'), true, 'subject');
  assert.equal(matchesFilter(c, 'misetic'), true, 'author');
  assert.equal(matchesFilter(c, 'abc123'), true, 'hash');
  assert.equal(matchesFilter(c, 'nothing here'), false);
});

test('matching ignores case on both sides', () => {
  const c = commit({ subject: 'Fix The Badge' });
  assert.equal(matchesFilter(c, 'fix the badge'), true);
  assert.equal(matchesFilter(c, 'FIX'), true);
});

test('surrounding spaces in the filter are not part of the search', () => {
  assert.equal(matchesFilter(commit({ subject: 'badge' }), '  badge  '), true);
});

// ---------------------------------------------------------------------- refs

test('git decorations are classified by what they are', () => {
  assert.deepEqual(classifyRef('HEAD -> main'), {
    raw: 'HEAD -> main',
    label: 'main',
    kind: 'current',
  });
  assert.deepEqual(classifyRef('tag: v0.0.1'), {
    raw: 'tag: v0.0.1',
    label: 'v0.0.1',
    kind: 'tag',
  });
  assert.equal(classifyRef('origin/main').kind, 'remote');
  assert.equal(classifyRef('main').kind, 'local');
  assert.equal(classifyRef('HEAD').kind, 'current', 'a detached HEAD is still current');
});

test('a decoration keeps its full text for the tooltip', () => {
  assert.equal(classifyRef('tag: v0.0.1').raw, 'tag: v0.0.1');
});

test('the checked-out branch and tags survive the cap ahead of remotes', () => {
  const ranked = rankRefs(
    ['origin/main', 'origin/release', 'tag: v1.0', 'HEAD -> main', 'develop'],
    3
  );
  assert.deepEqual(
    ranked.shown.map((r) => r.kind),
    ['current', 'local', 'tag'],
    'the remote-tracking refs are the ones dropped'
  );
  assert.deepEqual(ranked.hidden, ['origin/main', 'origin/release']);
});

test('a local branch with a slash in it is ranked as if it were remote', () => {
  // A known limit, pinned so it is a decision rather than a surprise: git's
  // decoration gives no way to tell "feature/x" from "origin/x", so the slash
  // is all there is to go on. The consequence is only ordering - the chip is
  // still labelled and linked correctly.
  assert.equal(classifyRef('feature/x').kind, 'remote');
  assert.equal(classifyRef('feature/x').label, 'feature/x', 'but it is labelled in full');
});

test('a commit inside the cap hides nothing', () => {
  const ranked = rankRefs(['HEAD -> main', 'tag: v1.0'], 3);
  assert.equal(ranked.shown.length, 2);
  assert.deepEqual(ranked.hidden, []);
});

test('a commit with no decorations ranks to nothing at all', () => {
  assert.deepEqual(rankRefs([], 3), { shown: [], hidden: [] });
  assert.deepEqual(rankRefs(undefined, 3), { shown: [], hidden: [] });
});

test('the hidden list keeps raw names, which is what the tooltip shows', () => {
  const ranked = rankRefs(['origin/a', 'origin/b', 'tag: v1'], 1);
  assert.deepEqual(ranked.shown.map((r) => r.label), ['v1']);
  assert.deepEqual(ranked.hidden, ['origin/a', 'origin/b']);
});

// ---------------------------------------------------------------- ref nesting

const nameOf = (ref) => ref;

test('refs nest on slashes', () => {
  const tree = nestRefs(['feature/one', 'feature/two', 'main'], nameOf);
  assert.deepEqual(tree.leaves.map((l) => l.name), ['main']);
  assert.deepEqual(
    tree.dirs.get('feature').leaves.map((l) => l.name),
    ['one', 'two']
  );
});

test('nesting goes as deep as the name does', () => {
  const tree = nestRefs(['a/b/c/leaf'], nameOf);
  const deep = tree.dirs.get('a').dirs.get('b').dirs.get('c');
  assert.deepEqual(deep.leaves.map((l) => l.name), ['leaf']);
});

test('a leaf keeps the whole ref, not just the part it is nested under', () => {
  // The label comes from the display path; checking the branch out needs the
  // real ref, so both have to survive.
  const tree = nestRefs(['origin/feature/x'], (ref) => ref.replace(/^origin\//, ''));
  const leaf = tree.dirs.get('feature').leaves[0];
  assert.equal(leaf.name, 'x', 'labelled by the display path');
  assert.equal(leaf.ref, 'origin/feature/x', 'but still the ref git knows');
});

test('two refs sharing a prefix share one node', () => {
  const tree = nestRefs(['a/one', 'a/two'], nameOf);
  assert.equal(tree.dirs.size, 1);
  assert.equal(tree.dirs.get('a').leaves.length, 2);
});

test('no refs is an empty tree rather than a failure', () => {
  const tree = nestRefs([], nameOf);
  assert.equal(tree.dirs.size, 0);
  assert.deepEqual(tree.leaves, []);
});
