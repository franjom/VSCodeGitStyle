'use strict';

/**
 * Reintroduces bugs that were actually hit while building this extension - and,
 * for the row windowing, the two slips that windowing code classically grows -
 * then checks the suite notices. A green test run says the tests pass; this
 * says they are worth having.
 *
 * Every mutation is reverted afterwards, and the sources are recompiled at the
 * end. Run with: node tools/mutation-check.js
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GIT_TS = path.join(ROOT, 'src', 'git', 'git.ts');
const GRAPH_TS = path.join(ROOT, 'src', 'git', 'graph.ts');
const VIRTUAL_JS = path.join(ROOT, 'media', 'virtual.js');
const TREE_TS = path.join(ROOT, 'src', 'git', 'tree.ts');
const WORKTREES_TS = path.join(ROOT, 'src', 'git', 'worktrees.ts');
const DIFFVIEW_JS = path.join(ROOT, 'media', 'diffview.js');
const CHANGESVIEW_JS = path.join(ROOT, 'media', 'changesview.js');
const REFNAMES_TS = path.join(ROOT, 'src', 'git', 'refNames.ts');
const COMPARE_TS = path.join(ROOT, 'src', 'git', 'compare.ts');
const COMMIT_MESSAGE_TS = path.join(ROOT, 'src', 'commitMessage.ts');

const MUTATIONS = [
  {
    label: 'lane collapse removed (the graph drifts right after a merge)',
    file: GRAPH_TS,
    from: '      } else if (index === 0 && target > lane && lanes[lane] === null) {',
    to: '      } else if (false) {',
  },
  {
    label: 'staged-then-edited file collapsed into one entry',
    file: GIT_TS,
    from:
      "        if (xy[0] !== '.') {\n" +
      '          staged.push({ path, status: statusFromLetter(xy[0]), staged: true });\n' +
      '        }\n' +
      "        if (xy[1] !== '.') {\n" +
      '          unstaged.push({ path, status: statusFromLetter(xy[1]), staged: false });\n' +
      '        }',
    to:
      "        if (xy[0] !== '.') {\n" +
      '          staged.push({ path, status: statusFromLetter(xy[0]), staged: true });\n' +
      "        } else if (xy[1] !== '.') {\n" +
      '          unstaged.push({ path, status: statusFromLetter(xy[1]), staged: false });\n' +
      '        }',
  },
  {
    label: 'merge file list without --first-parent (git prints nothing)',
    file: GRAPH_TS,
    from: "      '--first-parent',\n      '--root',",
    to: "      '--root',",
  },
  {
    label: 'rename original path read but not consumed',
    file: GIT_TS,
    from: "        const origPath = toPosix(tokens[++i] ?? '');",
    to: "        const origPath = toPosix(tokens[i + 1] ?? '');",
  },
  {
    label: 'a failed command reports only stderr (git and hooks also use stdout)',
    file: GIT_TS,
    from: '  const output = [stderr, stdout]',
    to: '  const output = [stderr]',
  },
  {
    label: 'amend with an empty box blanks the message',
    file: GIT_TS,
    from:
      '    if (amend && !message) {\n' +
      "      return this.exec(root, ['commit', '--amend', '--no-edit']);\n" +
      '    }',
    to:
      '    if (false) {\n' +
      "      return this.exec(root, ['commit', '--amend', '--no-edit']);\n" +
      '    }',
  },
  {
    // Rounding the bottom edge down drops the row that is only half on screen,
    // leaving a sliver of empty scroller under the last one.
    label: 'the partly visible row at the bottom edge dropped',
    file: VIRTUAL_JS,
    from: 'const end = clamp(Math.ceil(bottom / rowHeight) + overscan, start, total);',
    to: 'const end = clamp(Math.floor(bottom / rowHeight) + overscan, start, total);',
  },
  {
    // Without the ceiling the range runs past the list, and the rows asked for
    // beyond the end are undefined.
    label: 'the row range not clamped to the end of the list',
    file: VIRTUAL_JS,
    from: 'const end = clamp(Math.ceil(bottom / rowHeight) + overscan, start, total);',
    to: 'const end = Math.max(Math.ceil(bottom / rowHeight) + overscan, start);',
  },
  {
    // Treating "." as a prefix matches no listed path, so a discard from the
    // root row silently does nothing.
    label: 'the repository root treated as a folder prefix',
    file: TREE_TS,
    from: '  if (folder === ROOT) {\n    return true;\n  }',
    to: '  if (false) {\n    return true;\n  }',
  },
  {
    // An estimate landing just over the model's limit fails the request.
    label: 'a diff cut to the budget with no margin',
    file: COMMIT_MESSAGE_TS,
    from: '  const keep = Math.floor((diff.length * budget * 0.9) / tokens);',
    to: '  const keep = Math.floor((diff.length * budget) / tokens);',
  },
  {
    label: 'a diff cut mid-line',
    file: COMMIT_MESSAGE_TS,
    from: '  return diff.slice(0, lineEnd > 0 ? lineEnd + 1 : keep) + TRUNCATED_NOTE;',
    to: '  return diff.slice(0, keep) + TRUNCATED_NOTE;',
  },
  {
    // A nested repository binned with its whole history.
    label: 'a nested repository listed for the bin',
    file: GIT_TS,
    from: "      const nested = entry.endsWith('/')",
    to: "      const nested = false && entry.endsWith('/')",
  },
  {
    // Ignored files binned, which git clean leaves without -x.
    label: 'a folder discard listing ignored files',
    file: GIT_TS,
    from: "      '--exclude-standard',\n      '--directory',",
    to: "      '--directory',",
  },
  {
    // A staged addition left on disk once unstaged.
    label: 'a staged addition not counted as a new file',
    file: TREE_TS,
    from: "    [...mine.filter(isNew), ...mineStaged.filter((c) => c.status === 'added')].map((c) => c.path)",
    to: '    mine.filter(isNew).map((c) => c.path)',
  },
  {
    // checkout run on a folder holding only additions, which fails.
    label: 'a staged addition taken for something to revert',
    file: TREE_TS,
    from: "mineStaged.some((c) => c.status !== 'added')",
    to: 'mineStaged.length > 0',
  },
  {
    // An added file shown against an empty document, labelled modified.
    label: 'an added file given a left side',
    file: COMPARE_TS,
    from: "    left: file.status === 'A' ? undefined : { rev: from, path: file.origPath ?? file.path },",
    to: '    left: { rev: from, path: file.origPath ?? file.path },',
  },
  {
    label: 'a deleted file given a right side',
    file: COMPARE_TS,
    from: "    right: file.status === 'D' ? undefined : { rev: to, path: file.path },",
    to: '    right: { rev: to, path: file.path },',
  },
  {
    // The old side of a rename read at its new path, where it did not exist.
    label: 'a rename compared at its new path on both sides',
    file: COMPARE_TS,
    from: "{ rev: from, path: file.origPath ?? file.path }",
    to: '{ rev: from, path: file.path }',
  },
  {
    // Stash All Changes pushes with -u, and those files live in a third parent.
    label: "a stash's untracked files left out of View Changes",
    file: COMPARE_TS,
    from: '  if (untracked) {\n    const added',
    to: '  if (false) {\n    const added',
  },
  {
    // The commit's message is git's "WIP on main: <hash> <subject>" for a
    // stash stored by hand; the list shows the reflog's.
    label: "a stash titled by its commit message instead of its stash message",
    file: COMPARE_TS,
    from: "'--format=%H%x1f%cI%x1f%gs'",
    to: "'--format=%H%x1f%cI%x1f%s'",
  },
  {
    // An editor reads its document once; a side named stash@{0} shows
    // whichever stash holds that slot when it opens.
    label: 'a stash read by its index rather than its hash',
    file: COMPARE_TS,
    from: '  const pairs = comparePairs(parseNameStatus(trackedOut), base, stash);',
    to: '  const pairs = comparePairs(parseNameStatus(trackedOut), base, `stash@{${index}}`);',
  },
  {
    // "@{-1}" passes on its exit code, and a branch named after the previous
    // one is made instead of the one typed.
    label: 'a branch name git rewrote taken as accepted',
    file: REFNAMES_TS,
    from: "    if (kind === 'branch' && out.trim() !== name) {",
    to: '    if (false) {',
  },
  {
    // "-x" would reach `git tag` as an option.
    label: 'a ref name starting with "-" let through',
    file: REFNAMES_TS,
    from: "  if (name === '@' || name.startsWith('-')) {",
    to: "  if (name === '@') {",
  },
  {
    label: 'a lone "@" let through as a branch name',
    file: REFNAMES_TS,
    from: "  if (name === '@' || name.startsWith('-')) {",
    to: "  if (name.startsWith('-')) {",
  },
  {
    // A file at a revision decoded on the way through: any encoding but UTF-8
    // reaches the diff garbled.
    label: 'blob bytes decoded as UTF-8 before VS Code sees them',
    file: GIT_TS,
    from: '          resolve(stdoutBytes);',
    to: "          resolve(Buffer.from(stdoutBytes.toString('utf8'), 'utf8'));",
  },
  {
    // An annotated tag would pin to the tag object, which has no files.
    label: 'a revision pinned without peeling it to a commit',
    file: GIT_TS,
    from: "['rev-parse', '-q', '--verify', `${rev}^{commit}`]",
    to: "['rev-parse', '-q', '--verify', rev]",
  },
  {
    // A "../" from the webview would reach past the repository - and the
    // delete it guards moves whatever it lands on to the bin.
    label: 'a path climbing out of the repository accepted',
    file: TREE_TS,
    from: "  const escapes = fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`);",
    to: '  const escapes = false;',
  },
  {
    // A file whose name starts with ".." refused as though it were outside.
    label: 'a leading ".." in a name taken for a parent directory',
    file: TREE_TS,
    from: "  const escapes = fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`);",
    to: "  const escapes = fromRoot.startsWith('..');",
  },
  {
    label: 'a folder matched as a bare prefix (src claims src2)',
    file: TREE_TS,
    from: "  return filePath.startsWith(folder.endsWith('/') ? folder : `${folder}/`);",
    to: '  return filePath.startsWith(folder);',
  },
  {
    // The branch pane is not windowed; this is the only thing bounding it.
    label: "a worktree's file list not capped",
    file: WORKTREES_TS,
    from: '  return { files: all.slice(0, max), total: all.length };',
    to: '  return { files: all, total: all.length };',
  },
  {
    label: 'the cap keeps files by path alone, dropping conflicts',
    file: WORKTREES_TS,
    from: "    const conflictFirst = Number(b.status === '!') - Number(a.status === '!');",
    to: '    const conflictFirst = 0;',
  },
  {
    // The row would open a diff against a file that is not there.
    label: 'a file deleted from disk takes its staged letter',
    file: WORKTREES_TS,
    from: "    if (change.status === 'deleted' && !byPath.has(change.path)) {",
    to: '    if (false) {',
  },
  {
    // The entry would offer to bin a file that is no longer there.
    label: 'Delete offered on a file already deleted',
    file: CHANGESVIEW_JS,
    from: "    return change.status === 'deleted' ? 'already deleted' : null;",
    to: '    return null;',
  },
  {
    label: 'one shut folder shuts the same folder in every worktree',
    file: DIFFVIEW_JS,
    from: "      if (row.kind === 'dir' && closed.has(scope + row.key)) {",
    to: "      if (row.kind === 'dir' && closed.has(row.key)) {",
  },
];

function run(command) {
  try {
    return { ok: true, out: execSync(command, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || '') };
  }
}

function failingTests() {
  const result = run('node --test');
  return result.out
    .split('\n')
    .filter((line) => line.startsWith('not ok '))
    .map((line) => line.split(' - ').pop().trim());
}

function main() {
  if (!run('npx tsc -p ./').ok) {
    console.error('The sources do not compile; fix that first.');
    process.exit(1);
  }
  const baseline = failingTests();
  if (baseline.length) {
    console.error('The suite is already failing:\n  ' + baseline.join('\n  '));
    process.exit(1);
  }
  console.log('baseline: clean\n');

  let caught = 0;
  for (const mutation of MUTATIONS) {
    const original = fs.readFileSync(mutation.file, 'utf8');
    // The patterns below are written with LF, but git hands these files to a
    // Windows working tree with CRLF, which silently turned every multi-line
    // mutation into a SKIP - a weaker run reported as a clean one. Match
    // against a normalised copy; the exact original bytes are what gets put
    // back afterwards.
    const normalised = original.replace(/\r\n/g, '\n');
    if (!normalised.includes(mutation.from)) {
      console.log('SKIP    ' + mutation.label + '  (the code has moved on)\n');
      continue;
    }

    fs.writeFileSync(mutation.file, normalised.replace(mutation.from, mutation.to));
    const compiled = run('npx tsc -p ./');
    const failures = compiled.ok ? failingTests() : ['(did not compile)'];
    fs.writeFileSync(mutation.file, original);

    if (failures.length) {
      caught++;
      console.log('CAUGHT  ' + mutation.label);
      failures.slice(0, 3).forEach((name) => console.log('          -> ' + name));
      if (failures.length > 3) {
        console.log('          -> ... and ' + (failures.length - 3) + ' more');
      }
    } else {
      console.log('MISSED  ' + mutation.label + '  <-- not covered by any test');
    }
    console.log('');
  }

  run('npx tsc -p ./');
  const after = failingTests();
  console.log(caught + ' of ' + MUTATIONS.length + ' mutations caught');
  console.log('restored: ' + (after.length ? 'STILL FAILING - investigate' : 'clean'));
  process.exit(caught === MUTATIONS.length && !after.length ? 0 : 1);
}

main();
