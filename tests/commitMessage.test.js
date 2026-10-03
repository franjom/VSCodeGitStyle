'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fitDiff, TRUNCATED_NOTE } = require('../out/commitMessage.js');

/** A diff of `lines` lines, each 20 characters including its newline. */
function diffOf(lines) {
  return Array.from({ length: lines }, (_, i) => `+line ${String(i).padStart(12, '0')}\n`).join('');
}

test('a diff within the budget is sent whole', () => {
  const diff = diffOf(10);
  assert.equal(fitDiff(diff, 50, 50), diff);
  assert.equal(fitDiff(diff, 10, 50), diff);
});

test('a diff over the budget is cut, and says it was', () => {
  const diff = diffOf(100);
  const fitted = fitDiff(diff, 1000, 500);
  assert.ok(fitted.length < diff.length);
  assert.ok(fitted.endsWith(TRUNCATED_NOTE));
});

test('the cut keeps a tenth in hand, since the estimate is only proportional', () => {
  // Half the tokens fit, so half the text would - less the margin.
  const diff = diffOf(100);
  const kept = fitDiff(diff, 1000, 500).length - TRUNCATED_NOTE.length;
  assert.ok(kept <= diff.length * 0.5 * 0.9, `${kept} of ${diff.length}`);
  assert.ok(kept > diff.length * 0.4, 'not cut far below the estimate');
});

test('the cut falls at a line break, so no line reaches the model half-written', () => {
  const diff = diffOf(100);
  const kept = fitDiff(diff, 1000, 333).slice(0, -TRUNCATED_NOTE.length);
  assert.ok(kept.endsWith('\n'));
  assert.ok(diff.startsWith(kept));
});

test('no budget at all leaves only the note, rather than a negative slice', () => {
  assert.equal(fitDiff(diffOf(10), 50, 0), TRUNCATED_NOTE);
  assert.equal(fitDiff(diffOf(10), 50, -20), TRUNCATED_NOTE);
});
