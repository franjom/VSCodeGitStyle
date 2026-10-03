import { FileChange, Git, StatusLists } from './git';

/**
 * The worktrees of a repository, each with its own uncommitted changes, for
 * the Git Repository window's branch pane.
 *
 * Visual Studio does not do this: its branch pane lists refs only, and changes
 * live in Git Changes, which follows one repository at a time. It is here
 * because a linked worktree's edits are otherwise invisible from the window -
 * VS Code's Source Control view is the only place that shows them, one block
 * per worktree.
 */

/** One record of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** As git prints it: forward slashes, even on Windows. */
  path: string;
  head?: string;
  /** Full ref name, e.g. refs/heads/feature/x. Absent when detached. */
  branch?: string;
  detached: boolean;
  /** The main repository is bare, and has no working tree to read. */
  bare: boolean;
  /** The worktree's directory is gone; `git worktree prune` would drop it. */
  prunable: boolean;
}

/** One changed path, folded from the index and worktree columns. */
export interface WorktreeFile {
  path: string;
  origPath?: string;
  /** The letter shown at the end of the row, as the commit details pane shows it. */
  status: string;
}

export interface Worktree {
  path: string;
  name: string;
  /** The branch checked out there, or "(detached at abc1234)". */
  branch: string;
  /** The worktree this window was opened on. */
  current: boolean;
  /** At most MAX_WORKTREE_FILES of them; `total` is how many there are. */
  files: WorktreeFile[];
  total: number;
  /** Said in place of the file list when there is none to give. */
  note?: string;
}

/**
 * The branch pane is not windowed the way the commit list is, so the rows a
 * worktree contributes have to be bounded at the source - and the pane is
 * redrawn whole for every refresh, filter keystroke and folder toggle. The
 * preview harness measures about 0.1 ms a row: 10 ms for the window with no
 * worktrees or with ten files, 33 ms with 200, and up to 60 ms with 500. A
 * worktree with more than 200 changes is usually missing a .gitignore, not
 * holding a change set anyone reads row by row.
 */
export const MAX_WORKTREE_FILES = 200;

/**
 * Parses `git worktree list --porcelain`: one attribute per line, records
 * separated by a blank line, the first record always the main worktree.
 *
 * `-z` would make a path with a newline in it safe, but it needs git 2.36, and
 * a worktree directory with a newline in its name is not worth that floor.
 */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) {
      current = undefined;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);

    if (key === 'worktree') {
      current = { path: value, detached: false, bare: false, prunable: false };
      entries.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value;
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'prunable') {
      current.prunable = true;
    }
  }
  return entries;
}

const LETTERS: Record<FileChange['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflict: '!',
  ignored: 'I',
};

/**
 * One row per path, where the Git Changes view has up to two.
 *
 * The row stands for the difference between HEAD and the file on disk, since
 * that is the diff it opens, so the letter is chosen to be true of that:
 *
 * - a conflict outranks everything, being the one thing that blocks a commit;
 * - a file deleted from disk is D whatever the index says, because there is
 *   no file to open on the right-hand side;
 * - otherwise the staged letter, because it is measured from HEAD: a new file
 *   staged and edited again ("AM") is new, not modified;
 * - otherwise the unstaged one.
 *
 * Conflicts come first, then by path, so that when the list is capped the
 * files that need attention are the ones kept.
 */
export function worktreeFiles(
  lists: StatusLists,
  max = MAX_WORKTREE_FILES
): { files: WorktreeFile[]; total: number } {
  const byPath = new Map<string, WorktreeFile>();

  for (const change of lists.conflicts) {
    byPath.set(change.path, { path: change.path, status: LETTERS.conflict });
  }
  for (const change of lists.unstaged) {
    if (change.status === 'deleted' && !byPath.has(change.path)) {
      byPath.set(change.path, { path: change.path, status: LETTERS.deleted });
    }
  }
  for (const change of lists.staged) {
    if (!byPath.has(change.path)) {
      byPath.set(change.path, {
        path: change.path,
        origPath: change.origPath,
        status: LETTERS[change.status],
      });
    }
  }
  for (const change of lists.unstaged) {
    if (!byPath.has(change.path) && change.status !== 'ignored') {
      byPath.set(change.path, { path: change.path, status: LETTERS[change.status] });
    }
  }

  const all = [...byPath.values()].sort((a, b) => {
    const conflictFirst = Number(b.status === '!') - Number(a.status === '!');
    return conflictFirst || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  return { files: all.slice(0, max), total: all.length };
}

/**
 * Whether two spellings name the same directory. git prints "D:/repo" where
 * VS Code's fsPath is "d:\repo", and Windows paths ignore case.
 */
export function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  const normal = (p: string) => {
    const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };
  return normal(a) === normal(b);
}

function branchLabel(entry: WorktreeEntry): string {
  if (entry.branch) {
    return entry.branch.replace(/^refs\/heads\//, '');
  }
  return entry.head ? `(detached at ${entry.head.slice(0, 7)})` : '(detached)';
}

/**
 * Every worktree with a working tree, and what has changed in each.
 *
 * A repository with no linked worktree lists none: its one set of changes is
 * already what Git Changes shows, and leaving it out spares a `git status` on
 * every reload of the window.
 */
export async function readWorktrees(
  git: Git,
  root: string,
  caseInsensitive = process.platform === 'win32'
): Promise<Worktree[]> {
  const entries = parseWorktreeList(
    await git.exec(root, ['worktree', 'list', '--porcelain'])
  ).filter((entry) => !entry.bare);
  if (entries.length < 2) {
    return [];
  }

  return Promise.all(
    entries.map(async (entry): Promise<Worktree> => {
      const worktree: Worktree = {
        path: entry.path,
        name: entry.path.replace(/\/+$/, '').split('/').pop() ?? entry.path,
        branch: branchLabel(entry),
        current: samePath(entry.path, root, caseInsensitive),
        files: [],
        total: 0,
      };
      if (entry.prunable) {
        worktree.note = 'The directory is missing.';
        return worktree;
      }
      try {
        const { files, total } = worktreeFiles(await git.status(entry.path, false));
        worktree.files = files;
        worktree.total = total;
        if (!total) {
          worktree.note = 'No changes.';
        }
      } catch (err) {
        // One unreadable worktree - a permissions problem, a lock git gave up
        // on - should not take the whole branch pane down with it.
        worktree.note = err instanceof Error ? err.message : String(err);
      }
      return worktree;
    })
  );
}
