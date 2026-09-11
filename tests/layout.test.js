'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { layout } = require('../out/graph.js');
const { commit, assertLaneContinuity, assertLanesInRange } = require('./helpers.js');

const NO_SET = new Set();

function run(commits, head) {
  const result = layout(commits, NO_SET, NO_SET, head || '');
  assertLanesInRange(result.rows, result.maxLanes, 'layout');
  assertLaneContinuity(result.rows, 'layout');
  return result;
}

function lanesOf(result) {
  return result.rows.map((row) => row.lane);
}

test('a linear history stays in one lane', () => {
  const result = run([
    commit('a', ['b']),
    commit('b', ['c']),
    commit('c', []),
  ]);

  assert.deepEqual(lanesOf(result), [0, 0, 0]);
  assert.equal(result.maxLanes, 1);
});

test('a merge opens a second lane and the branch rejoins into the first', () => {
  //  M        merge of A and B
  //  |\
  //  | B      side branch
  //  A |      main line
  //  |/
  //  C        common ancestor
  const result = run([
    commit('m', ['a', 'b']),
    commit('b', ['c']),
    commit('a', ['c']),
    commit('c', []),
  ]);

  const [m, b, a, c] = result.rows;
  assert.equal(m.lane, 0, 'the merge sits on the main line');
  assert.equal(m.below.length, 2, 'a merge has two outgoing lines');
  assert.equal(b.lane, 1, 'the side branch takes the second lane');
  assert.equal(a.lane, 0, 'the first parent continues in the merge lane');
  assert.equal(
    c.lane,
    0,
    'the common ancestor collapses back to the leftmost lane, as git draws it'
  );
  assert.equal(result.maxLanes, 2);
});

test('the collapse leaves a converging line on the row that causes it', () => {
  // Same shape as above. The side branch claims the ancestor's lane first, so
  // pulling it back to lane 0 must leave a visible line from lane 1 to lane 0.
  const result = run([
    commit('m', ['a', 'b']),
    commit('b', ['c']),
    commit('a', ['c']),
    commit('c', []),
  ]);

  const a = result.rows[2];
  const converging = a.through.find((t) => t.from === 1 && t.to === 0);
  assert.ok(converging, 'expected a line converging from lane 1 into lane 0');
});

test('without the collapse the graph would keep drifting right', () => {
  // Three merges in a row: if the main line never returned to lane 0 the lane
  // count would grow with each one.
  const result = run([
    commit('m3', ['m2', 'x3']),
    commit('x3', ['m2']),
    commit('m2', ['m1', 'x2']),
    commit('x2', ['m1']),
    commit('m1', ['base', 'x1']),
    commit('x1', ['base']),
    commit('base', []),
  ]);

  assert.equal(result.maxLanes, 2, 'repeated merges must not accumulate lanes');
  assert.equal(result.rows[result.rows.length - 1].lane, 0, 'the base ends up leftmost');
});

test('an octopus merge opens one lane per extra parent', () => {
  const result = run([
    commit('m', ['a', 'b', 'c']),
    commit('a', ['base']),
    commit('b', ['base']),
    commit('c', ['base']),
    commit('base', []),
  ]);

  assert.equal(result.rows[0].below.length, 3);
  assert.deepEqual(
    result.rows[0].below.map((b) => b.lane).sort((x, y) => x - y),
    [0, 1, 2]
  );
  assert.equal(result.maxLanes, 3);
});

test('two independent tips each get a lane', () => {
  const result = run([
    commit('tip1', ['base']),
    commit('tip2', ['base']),
    commit('base', []),
  ]);

  assert.equal(result.rows[0].lane, 0);
  assert.equal(result.rows[1].lane, 1);
  assert.equal(result.maxLanes, 2);
});

test('a lane freed by one branch is reused by a later one', () => {
  // The side branch ends at "b"; a later unrelated tip should take lane 1 back
  // rather than opening a third.
  const result = run([
    commit('m', ['a', 'b']),
    commit('b', []),
    commit('a', ['c']),
    commit('later', ['c']),
    commit('c', []),
  ]);

  assert.equal(result.maxLanes, 2, 'the freed lane is reused');
});

test('the row above a dot records the lines arriving at it', () => {
  const result = run([
    commit('m', ['a', 'b']),
    commit('b', ['c']),
    commit('a', ['c']),
    commit('c', []),
  ]);

  const c = result.rows[3];
  assert.ok(c.above.length >= 1, 'the ancestor must accept an incoming line');
  assert.ok(
    c.above.every((a) => typeof a.color === 'number'),
    'every incoming line carries a colour'
  );
});

test('a commit whose parents are outside the page still renders', () => {
  const result = run([commit('a', ['missing-parent'])]);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].below.length, 1);
  assert.equal(result.maxLanes, 1);
});

test('an empty history produces no rows and a usable width', () => {
  const result = layout([], NO_SET, NO_SET, '');
  assert.deepEqual(result.rows, []);
  assert.equal(result.maxLanes, 1, 'width must never be zero');
});

test('incoming, outgoing and HEAD are marked on the right rows', () => {
  const rows = layout(
    [commit('a', ['b']), commit('b', ['c']), commit('c', [])],
    new Set(['c']),
    new Set(['a']),
    'b'
  ).rows;

  assert.equal(rows[0].group, 'local');
  assert.equal(rows[0].outgoing, true);
  assert.equal(rows[1].isHead, true);
  assert.equal(rows[2].group, 'incoming');
  assert.equal(rows[2].outgoing, false);
});
