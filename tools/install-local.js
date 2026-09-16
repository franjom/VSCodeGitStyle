'use strict';

/**
 * Installs the packaged extension into VS Code.
 *
 * The vsix carries its version in the filename, so that two downloads of
 * different releases can be told apart rather than arriving as "(1)". That
 * means the name changes whenever the version does, so the newest build is
 * found here rather than named in the npm script.
 *
 * Run with: npm run install-local
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const builds = fs
  .readdirSync(ROOT)
  .filter((name) => /^vs-git-style-.+\.vsix$/.test(name))
  .map((name) => ({ name, modified: fs.statSync(path.join(ROOT, name)).mtimeMs }))
  .sort((a, b) => b.modified - a.modified);

if (builds.length === 0) {
  console.error('No vs-git-style-*.vsix in the repository root - run npm run package first.');
  process.exit(1);
}

const vsix = builds[0].name;
console.log(`Installing ${vsix}`);
execFileSync('code', ['--install-extension', path.join(ROOT, vsix), '--force'], {
  stdio: 'inherit',
  // code is a .cmd on Windows, which execFile cannot start on its own.
  shell: process.platform === 'win32',
});
