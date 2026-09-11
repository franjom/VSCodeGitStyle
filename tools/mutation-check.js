'use strict';

/**
 * Reintroduces bugs that were actually hit while building this extension and
 * checks the suite notices. A green test run says the tests pass; this says
 * they are worth having.
 *
 * Every mutation is reverted afterwards, and the sources are recompiled at the
 * end. Run with: node tools/mutation-check.js
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GIT_TS = path.join(ROOT, 'src', 'git.ts');
const GRAPH_TS = path.join(ROOT, 'src', 'graph.ts');

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
    if (!original.includes(mutation.from)) {
      console.log('SKIP    ' + mutation.label + '  (the code has moved on)\n');
      continue;
    }

    fs.writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
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
