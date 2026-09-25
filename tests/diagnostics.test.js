'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Diagnostics,
  formatRecord,
  trimToLimit,
  unfinished,
  parseLog,
  MAX_LOG_BYTES,
} = require('../out/diagnostics.js');

/** A sink that keeps what was written, and a clock that does not move on its own. */
function harness() {
  const lines = [];
  let clock = 1000;
  const diag = new Diagnostics({
    write: (line) => lines.push(line),
    now: () => clock,
    clock: () => new Date('2026-09-25T08:00:00.000Z'),
  });
  return {
    diag,
    lines,
    advance: (ms) => {
      clock += ms;
    },
    records: () => parseLog(lines.join('')),
  };
}

// ------------------------------------------------------------- begin and end

test('an operation writes a line before it starts, not only after', () => {
  // The whole point: a hang leaves the begin behind even though no end follows.
  const h = harness();
  h.diag.begin('readFileDiff', { path: 'a.ts' });

  assert.equal(h.lines.length, 1);
  const record = h.records()[0];
  assert.equal(record.kind, 'begin');
  assert.equal(record.label, 'readFileDiff');
  assert.equal(record.detail.path, 'a.ts');
});

test('ending an operation records how long it took', () => {
  const h = harness();
  const done = h.diag.begin('readFileDiff');
  h.advance(1234);
  done({ rows: 500 });

  const end = h.records()[1];
  assert.equal(end.kind, 'end');
  assert.equal(end.ms, 1234);
  assert.equal(end.detail.rows, 500, 'what the operation learned rides along');
});

test('ending twice does not write a second end', () => {
  // A finally block plus an explicit call is an easy mistake to make.
  const h = harness();
  const done = h.diag.begin('x');
  done();
  done();
  assert.equal(h.lines.length, 2);
});

test('an operation that never ends is what the log is read for', () => {
  const h = harness();
  h.diag.begin('load');
  const done = h.diag.begin('readFileDiff', { path: 'big.cs' });
  done();
  h.diag.begin('render', { rows: 20000 });

  const open = unfinished(h.records());
  assert.deepEqual(
    open.map((r) => r.label),
    ['load', 'render'],
    'the one that completed is not listed'
  );
  assert.equal(open[1].detail.rows, 20000, 'and its detail says what it was doing');
});

test('nesting is unwound innermost first', () => {
  const h = harness();
  h.diag.begin('outer');
  h.diag.begin('inner');
  h.diag.note('something happened');
  assert.deepEqual(unfinished(h.records()).map((r) => r.label), ['outer', 'inner']);
});

test('repeated operations of the same name pair up', () => {
  const h = harness();
  const a = h.diag.begin('read');
  a();
  const b = h.diag.begin('read');
  b();
  h.diag.begin('read');
  assert.equal(unfinished(h.records()).length, 1);
});

test('a log with nothing outstanding reads as clean', () => {
  const h = harness();
  const done = h.diag.begin('read');
  done();
  assert.deepEqual(unfinished(h.records()), []);
});

// -------------------------------------------------------------------- errors

test('an error records its message and a little of its stack', () => {
  const h = harness();
  h.diag.error('readFileDiff', new Error('git exploded'), { path: 'a.ts' });

  const record = h.records()[0];
  assert.equal(record.kind, 'error');
  assert.equal(record.detail.message, 'git exploded');
  assert.equal(record.detail.path, 'a.ts');
  assert.ok(record.detail.stack.length > 0);
});

test('a thrown value that is not an Error is still recorded', () => {
  const h = harness();
  h.diag.error('x', 'just a string');
  assert.equal(h.records()[0].detail.message, 'just a string');
});

test('a sink that throws never breaks the caller', () => {
  // Diagnostics must not be the reason a feature fails.
  const diag = new Diagnostics({
    write: () => {
      throw new Error('disk full');
    },
  });
  assert.doesNotThrow(() => {
    const done = diag.begin('x');
    done();
    diag.note('y');
    diag.error('z', new Error('w'));
  });
});

// ------------------------------------------------------------------ the file

test('a record is one line, whatever is in its detail', () => {
  // A newline inside a detail would otherwise forge a second record.
  const line = formatRecord({
    at: 'now',
    kind: 'note',
    label: 'commit',
    detail: { subject: 'first line\nsecond line' },
  });
  assert.equal(line.includes('\n'), false);
  assert.equal(JSON.parse(line).detail.subject, 'first line\nsecond line');
});

test('trimming keeps the end of the log, which is the part that matters', () => {
  const text = ['one', 'two', 'three', 'four'].map((s) => '"' + s + '"').join('\n') + '\n';
  const trimmed = trimToLimit(text, 20);

  assert.ok(Buffer.byteLength(trimmed) <= 20);
  assert.ok(trimmed.includes('four'), 'the newest record survives');
  assert.ok(!trimmed.includes('one'), 'the oldest is dropped');
});

test('trimming never leaves half a line at the front', () => {
  const text = new Array(50).fill('{"label":"padding-padding"}').join('\n') + '\n';
  const trimmed = trimToLimit(text, 100);
  for (const line of trimmed.split('\n')) {
    if (line.trim()) {
      assert.doesNotThrow(() => JSON.parse(line), 'every surviving line parses');
    }
  }
});

test('a log already within the limit is untouched', () => {
  const text = '{"a":1}\n';
  assert.equal(trimToLimit(text, MAX_LOG_BYTES), text);
});

test('a torn line is skipped without losing the records around it', () => {
  const text = '{"kind":"note","label":"before"}\n{"kind":"no' + '\n{"kind":"note","label":"after"}\n';
  assert.deepEqual(
    parseLog(text).map((r) => r.label),
    ['before', 'after']
  );
});

test('blank lines are not records', () => {
  assert.deepEqual(parseLog('\n\n  \n'), []);
});
