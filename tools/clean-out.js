'use strict';

/**
 * Empties out/ before a compile.
 *
 * tsc only writes; it never removes. A file that is renamed or moved therefore
 * leaves its old compile behind, and since the tests require out/ directly,
 * that stale copy goes on answering for a module the sources no longer have.
 * The suite then passes against code that is not in the repository any more,
 * which is the worst way for a test run to be wrong.
 *
 * Run as part of `npm run compile`; tsc dominates the cost either way.
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', 'out');

if (fs.existsSync(OUT)) {
  fs.rmSync(OUT, { recursive: true, force: true });
}
