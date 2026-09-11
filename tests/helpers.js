'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NUL = String.fromCharCode(0);

/**
 * A throwaway git repository in the OS temp directory. Every test that needs
 * real git output builds one of these rather than depending on a repository
 * that happens to be on the machine.
 */
class TestRepo {
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsgs-test-'));
    this.git(['init', '-q', '-b', 'main']);
    this.git(['config', 'user.email', 'test@example.invalid']);
    this.git(['config', 'user.name', 'Test']);
    // Keep line endings byte-identical so content assertions hold on Windows.
    this.git(['config', 'core.autocrlf', 'false']);
    this.git(['config', 'core.safecrlf', 'false']);
    this.git(['config', 'commit.gpgsign', 'false']);
  }

  git(args, options) {
    return execFileSync('git', args, {
      cwd: this.dir,
      encoding: 'utf8',
      stdio: options && options.allowFailure ? ['ignore', 'pipe', 'pipe'] : undefined,
    });
  }

  /** Runs a command that is expected to fail, returning whether it did. */
  tryGit(args) {
    try {
      execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  write(relPath, content) {
    const full = path.join(this.dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  read(relPath) {
    return fs.readFileSync(path.join(this.dir, relPath), 'utf8');
  }

  remove(relPath) {
    fs.rmSync(path.join(this.dir, relPath), { recursive: true, force: true });
  }

  commit(message) {
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-m', message]);
    return this.git(['rev-parse', 'HEAD']).trim();
  }

  dispose() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Builds a porcelain v2 record stream from already-formed record lines. */
function porcelain(records) {
  return records.join(NUL) + NUL;
}

/** A synthetic commit for layout tests. */
function commit(hash, parents, subject) {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: parents || [],
    author: 'Test',
    date: '2026-01-01T00:00:00+00:00',
    subject: subject || hash,
    refs: [],
  };
}

/**
 * Walks every parent edge down the graph and asserts the line is actually
 * drawn on each intervening row and lands on the parent's dot.
 *
 * The lane a line occupies is not constant: when a main line is pulled back to
 * the leftmost lane after a merge, the shift shows up as a `through` entry
 * whose `from` and `to` differ - git renders that as "|/". So the walk follows
 * those shifts instead of assuming one lane for the whole length.
 */
function assertLaneContinuity(rows, label) {
  const indexOf = new Map(rows.map((row, i) => [row.commit.hash, i]));
  let checked = 0;

  rows.forEach((row, i) => {
    assert.equal(
      row.below.length,
      row.commit.parents.length,
      `${label}: ${row.commit.shortHash} has ${row.below.length} outgoing lines for ` +
        `${row.commit.parents.length} parents`
    );

    row.commit.parents.forEach((parent, k) => {
      const end = indexOf.get(parent);
      if (end === undefined) {
        return; // parent lies beyond the loaded page
      }
      checked++;
      let lane = row.below[k].lane;

      for (let j = i + 1; j < end; j++) {
        const mid = rows[j];
        const line = mid.through.find((t) => t.from === lane);
        assert.ok(
          line,
          `${label}: ${row.commit.shortHash} -> ${parent.slice(0, 7)} has no line at ` +
            `lane ${lane} on row ${j} (${mid.commit.shortHash})`
        );
        assert.ok(
          mid.lane !== lane || mid.commit.hash === parent,
          `${label}: lane ${lane} carries ${row.commit.shortHash} -> ${parent.slice(0, 7)} ` +
            `but is also ${mid.commit.shortHash}'s dot`
        );
        lane = line.to;
      }

      const parentRow = rows[end];
      assert.ok(
        parentRow.lane === lane || parentRow.above.some((a) => a.lane === lane),
        `${label}: ${row.commit.shortHash} -> ${parent.slice(0, 7)} arrives at lane ` +
          `${lane}, but the parent's dot is at ${parentRow.lane}`
      );
    });
  });

  return checked;
}

/** Asserts every lane index referenced by a row is within the row's width. */
function assertLanesInRange(rows, maxLanes, label) {
  for (const row of rows) {
    const check = (lane, what) =>
      assert.ok(
        lane >= 0 && lane < maxLanes,
        `${label}: ${row.commit.shortHash} ${what} lane ${lane} outside 0..${maxLanes - 1}`
      );
    check(row.lane, 'dot');
    row.above.forEach((a) => check(a.lane, 'above'));
    row.below.forEach((b) => check(b.lane, 'below'));
    row.through.forEach((t) => {
      check(t.from, 'through.from');
      check(t.to, 'through.to');
    });
  }
}

module.exports = {
  NUL,
  TestRepo,
  porcelain,
  commit,
  assertLaneContinuity,
  assertLanesInRange,
};
