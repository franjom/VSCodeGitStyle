import { CommitFile } from './graph';

/** One side of a file's comparison: the file at one revision. */
export interface Side {
  rev: string;
  path: string;
}

/** A changed file as the changes editor is handed it. */
export interface ChangePair {
  path: string;
  left?: Side;
  right?: Side;
}

/**
 * Each file `git diff --name-status` listed between two revisions, as the two
 * sides VS Code's multi-file changes editor compares.
 *
 * An added file has no left side and a deleted one no right: the editor then
 * shows the file as added or deleted, where an empty document in its place
 * would read as every line inserted beside a blank one and be labelled
 * modified. A rename or copy is compared with the path it came from.
 */
export function comparePairs(files: CommitFile[], from: string, to: string): ChangePair[] {
  return files.map((file) => ({
    path: file.path,
    left: file.status === 'A' ? undefined : { rev: from, path: file.origPath ?? file.path },
    right: file.status === 'D' ? undefined : { rev: to, path: file.path },
  }));
}
