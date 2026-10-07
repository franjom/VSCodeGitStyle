import { Git } from './git';
import { CommitFile, parseNameStatus } from './graph';

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

/** The letter a pair is shown with, read back from which sides it has. */
export function pairStatus(pair: ChangePair): 'A' | 'D' | 'R' | 'M' {
  if (!pair.left) {
    return 'A';
  }
  if (!pair.right) {
    return 'D';
  }
  return pair.left.path === pair.right.path ? 'M' : 'R';
}

/** A stash as Visual Studio's Stash Details shows it. */
export interface StashChanges {
  hash: string;
  /** "On main: message", as `git stash list` shows it. */
  subject: string;
  /** ISO 8601. */
  created: string;
  /** The commit the stash was made on. */
  base: string;
  pairs: ChangePair[];
}

/**
 * What stash@{index} would put back, as Visual Studio's View Changes lists it:
 * the stash against the commit it was made on, plus the untracked files.
 *
 * Every revision handed back is a hash. Indices shift each time a stash is
 * pushed or dropped, and an editor reads its document once, so a side named
 * `stash@{0}` would go on showing whichever stash held that slot when it opened.
 *
 * The subject is the reflog's, which is what `git stash list` prints. The
 * commit's own message is git's "WIP on main: <hash> <subject>" whenever the
 * stash was stored by hand, as `git stash store -m` does.
 *
 * `git stash push -u` keeps untracked files in a third parent, a commit of its
 * own that `git stash show` leaves out unless asked; without it a stash made
 * by Stash All Changes would look emptier than it is.
 */
export async function readStashChanges(
  git: Git,
  root: string,
  index: number
): Promise<StashChanges | undefined> {
  const header = await git
    .exec(root, ['log', '-g', '-1', '--format=%H%x1f%cI%x1f%gs', `stash@{${index}}`])
    .catch(() => '');
  const [stash, created, subject] = header.trim().split('\x1f');
  if (!stash) {
    return undefined;
  }
  const [base, untracked] = await Promise.all([
    git.resolveCommit(root, `${stash}^1`),
    git.resolveCommit(root, `${stash}^3`),
  ]);
  if (!base) {
    return undefined;
  }
  const [trackedOut, untrackedOut] = await Promise.all([
    git.exec(root, ['diff', '--name-status', '-z', '-M', base, stash]),
    untracked
      ? git.exec(root, ['ls-tree', '-r', '-z', '--name-only', untracked])
      : Promise.resolve(''),
  ]);

  const pairs = comparePairs(parseNameStatus(trackedOut), base, stash);
  if (untracked) {
    const added = untrackedOut
      .split('\0')
      .filter(Boolean)
      .map((path): CommitFile => ({ status: 'A', path }));
    pairs.push(...comparePairs(added, base, untracked));
    pairs.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  }
  return { hash: stash, subject: subject ?? '', created: created ?? '', base, pairs };
}

/**
 * Where a stash sits in the list now. Stash Details holds the stash it was
 * opened on by hash, and by the time Apply or Drop is pressed another push may
 * have moved it - while `git stash drop` takes only a stash@{n}.
 */
export async function stashIndexOf(git: Git, root: string, hash: string): Promise<number | undefined> {
  const out = await git.exec(root, ['stash', 'list', '--format=%H']).catch(() => '');
  const index = out.split('\n').map((line) => line.trim()).indexOf(hash);
  return index < 0 ? undefined : index;
}
