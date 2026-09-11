import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflict'
  | 'ignored';

export interface FileChange {
  /** Repo-relative path, always with forward slashes. */
  path: string;
  /** Previous path for renames. */
  origPath?: string;
  status: ChangeStatus;
  /** Which list this entry belongs to. */
  staged: boolean;
}

/** An interrupted operation that the working tree is currently sitting in. */
export interface RepoOperation {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  /** What is being merged in, when it can be named. */
  ref?: string;
}

export interface StashEntry {
  index: number;
  /** Already formatted the way Visual Studio shows it: "On branch: message". */
  label: string;
}

export interface RepoSnapshot {
  root: string;
  name: string;
  branch: string;
  detached: boolean;
  branches: string[];
  upstream?: string;
  /** Commits on HEAD not on upstream (Visual Studio calls these Outgoing). */
  ahead: number;
  /** Commits on upstream not on HEAD (Incoming). */
  behind: number;
  /** Entries from the index column: Visual Studio's "Staged Changes". */
  staged: FileChange[];
  /** Entries from the worktree column, plus untracked files: "Changes". */
  unstaged: FileChange[];
  /** Unmerged paths, kept out of the other two lists. */
  conflicts: FileChange[];
  operation?: RepoOperation;
  stashes: StashEntry[];
}

export interface GitError extends Error {
  stderr: string;
  exitCode: number;
}

/**
 * Thin wrapper around the git binary. We deliberately shell out for every read
 * instead of leaning on the built-in Git extension's model: the porcelain
 * formats are stable and give us exactly the fields the Visual Studio layout
 * needs (reflog subjects, ahead/behind in one call, rename pairs).
 *
 * Mutating network operations (fetch/pull/push/sync) are *not* here - those go
 * through the built-in git commands so that VS Code's credential plumbing
 * (GIT_ASKPASS, auth providers) stays in play. See extension.ts.
 */
/** NUL, the record separator used by git's -z output. */
const SEPARATOR = String.fromCharCode(0);

export class Git {
  constructor(private readonly gitPath: string) {}

  async exec(cwd: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        this.gitPath,
        args,
        { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const wrapped = new Error(
              `git ${args.join(' ')} failed: ${stderr || err.message}`
            ) as GitError;
            wrapped.stderr = stderr ?? '';
            wrapped.exitCode = typeof (err as unknown as { code?: number }).code === 'number'
              ? (err as unknown as { code: number }).code
              : 1;
            reject(wrapped);
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  private async tryExec(cwd: string, args: string[]): Promise<string | undefined> {
    try {
      return await this.exec(cwd, args);
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- reads ---

  async snapshot(root: string, includeIgnored: boolean): Promise<RepoSnapshot> {
    const [head, branches, status, stashes] = await Promise.all([
      this.head(root),
      this.localBranches(root),
      this.status(root, includeIgnored),
      this.stashes(root),
    ]);

    const upstream = await this.upstream(root);
    const counts = upstream ? await this.aheadBehind(root) : { ahead: 0, behind: 0 };
    const operation = await this.operation(root);

    return {
      root,
      name: path.basename(root),
      branch: head.name,
      detached: head.detached,
      branches,
      upstream,
      ahead: counts.ahead,
      behind: counts.behind,
      staged: status.staged,
      unstaged: status.unstaged,
      conflicts: status.conflicts,
      operation,
      stashes,
    };
  }

  private async head(root: string): Promise<{ name: string; detached: boolean }> {
    const out = (await this.tryExec(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
    if (!out || out === 'HEAD') {
      const short = (await this.tryExec(root, ['rev-parse', '--short', 'HEAD']))?.trim();
      return { name: short ? `(detached at ${short})` : '(no commits yet)', detached: true };
    }
    return { name: out, detached: false };
  }

  private async localBranches(root: string): Promise<string[]> {
    const out = await this.tryExec(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    return (out ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  private async upstream(root: string): Promise<string | undefined> {
    const out = await this.tryExec(root, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ]);
    const trimmed = out?.trim();
    return trimmed ? trimmed : undefined;
  }

  private async aheadBehind(root: string): Promise<{ ahead: number; behind: number }> {
    // left..right with --left-right --count => [only in HEAD, only in upstream].
    const out = await this.tryExec(root, [
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...@{u}',
    ]);
    const [ahead, behind] = (out ?? '0\t0').trim().split(/\s+/).map((n) => Number(n) || 0);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  private async status(root: string, includeIgnored: boolean): Promise<StatusLists> {
    const args = ['status', '--porcelain=v2', '-z', '--untracked-files=all'];
    if (includeIgnored) {
      args.push('--ignored=matching');
    }
    return parseStatus(await this.exec(root, args));
  }

  /**
   * Detects an operation left half-finished in the working tree. Each of these
   * writes a pseudo-ref that survives until the operation is completed or
   * aborted, so verifying the ref is enough - no reading of .git internals.
   */
  private async operation(root: string): Promise<RepoOperation | undefined> {
    const probes: { ref: string; kind: RepoOperation['kind'] }[] = [
      { ref: 'MERGE_HEAD', kind: 'merge' },
      { ref: 'REBASE_HEAD', kind: 'rebase' },
      { ref: 'CHERRY_PICK_HEAD', kind: 'cherry-pick' },
      { ref: 'REVERT_HEAD', kind: 'revert' },
    ];

    for (const probe of probes) {
      const hash = await this.tryExec(root, ['rev-parse', '-q', '--verify', probe.ref]);
      if (!hash?.trim()) {
        continue;
      }
      const named = await this.tryExec(root, [
        'name-rev',
        '--name-only',
        '--refs=refs/heads/*',
        '--refs=refs/remotes/*',
        probe.ref,
      ]);
      const ref = named?.trim();
      return {
        kind: probe.kind,
        ref: ref && ref !== 'undefined' ? ref : hash.trim().slice(0, 7),
      };
    }
    return undefined;
  }

  // ------------------------------------------------------- conflict resolve ---

  /** Keeps one side of a conflicted file and marks it resolved. */
  async resolveWith(root: string, filePath: string, side: 'ours' | 'theirs'): Promise<void> {
    await this.exec(root, ['checkout', `--${side}`, '--', filePath]);
    await this.exec(root, ['add', '--', filePath]);
  }

  markResolved(root: string, filePath: string): Promise<string> {
    return this.exec(root, ['add', '--', filePath]);
  }

  private async stashes(root: string): Promise<StashEntry[]> {
    // %gd => stash@{0}, %gs => the reflog subject, which is already in the
    // "On <branch>: <message>" shape Visual Studio displays.
    const out = await this.tryExec(root, ['stash', 'list', '--format=%gd%x1f%gs']);
    return (out ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [ref, subject] = line.split('\x1f');
        const match = /stash@\{(\d+)\}/.exec(ref ?? '');
        return { index: match ? Number(match[1]) : 0, label: subject ?? '' };
      });
  }

  async diffForMessage(root: string): Promise<string> {
    // Staged if anything is staged, otherwise the whole working tree.
    const staged = await this.tryExec(root, ['diff', '--cached', '--stat']);
    const useStaged = Boolean(staged && staged.trim());
    const args = useStaged
      ? ['diff', '--cached', '--no-color', '--unified=1']
      : ['diff', 'HEAD', '--no-color', '--unified=1'];
    const diff = (await this.tryExec(root, args)) ?? '';
    return diff.slice(0, 24_000);
  }

  // ------------------------------------------------------------- mutations ---

  stage(root: string, paths: string[]): Promise<string> {
    return this.exec(root, ['add', '--', ...paths]);
  }

  unstage(root: string, paths: string[]): Promise<string> {
    return this.exec(root, ['reset', '-q', 'HEAD', '--', ...paths]);
  }

  stageAll(root: string): Promise<string> {
    return this.exec(root, ['add', '-A']);
  }

  async discard(root: string, change: FileChange): Promise<void> {
    if (change.status === 'untracked' || change.status === 'ignored') {
      await this.exec(root, ['clean', '-f', '--', change.path]);
      return;
    }
    if (change.staged) {
      await this.exec(root, ['reset', '-q', 'HEAD', '--', change.path]);
    }
    await this.exec(root, ['checkout', '-q', '--', change.path]);
  }

  /**
   * Visual Studio's "Ignore and Untrack item": add the file to .gitignore and
   * drop it from the index, leaving it on disk.
   *
   * The two halves are independent. An untracked file has nothing to untrack -
   * `git rm --cached` fails outright with "pathspec did not match any files" -
   * and a file already covered by .gitignore still needs removing from the
   * index, because a tracked file goes on being tracked whatever .gitignore
   * says. So each half is decided on its own.
   */
  async ignoreAndUntrack(root: string, relPath: string): Promise<void> {
    const tracked = (await this.tryExec(root, ['ls-files', '--', relPath]))?.trim();
    if (tracked) {
      await this.exec(root, ['rm', '--cached', '-q', '--', relPath]);
    }
    await this.addToGitignore(root, relPath);
  }

  /**
   * Appends one anchored pattern to the repository's .gitignore. The leading
   * slash matters: without it `foo/bar.cs` would also ignore that name anywhere
   * deeper in the tree, which is not what "ignore this item" means.
   */
  private async addToGitignore(root: string, relPath: string): Promise<void> {
    const file = path.join(root, '.gitignore');
    const pattern = `/${relPath}`;
    let existing = '';
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch {
      // No .gitignore yet; it is written below.
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === pattern)) {
      return;
    }
    // A file that does not end in a newline would otherwise have the new
    // pattern run onto the end of its last line.
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    await fs.writeFile(file, `${existing}${separator}${pattern}\n`, 'utf8');
  }

  commit(root: string, message: string, amend: boolean): Promise<string> {
    // Amending with no new text keeps the existing message; passing -m '' here
    // would silently blank it instead.
    if (amend && !message) {
      return this.exec(root, ['commit', '--amend', '--no-edit']);
    }
    const args = ['commit', '-m', message];
    if (amend) {
      args.push('--amend');
    }
    return this.exec(root, args);
  }

  checkout(root: string, branch: string): Promise<string> {
    return this.exec(root, ['checkout', branch]);
  }

  stashPush(root: string, message: string, includeUntracked: boolean): Promise<string> {
    const args = ['stash', 'push'];
    if (includeUntracked) {
      args.push('--include-untracked');
    }
    if (message) {
      args.push('-m', message);
    }
    return this.exec(root, args);
  }

  stashApply(root: string, index: number): Promise<string> {
    return this.exec(root, ['stash', 'apply', `stash@{${index}}`]);
  }

  stashPop(root: string, index: number): Promise<string> {
    return this.exec(root, ['stash', 'pop', `stash@{${index}}`]);
  }

  stashDrop(root: string, index: number): Promise<string> {
    return this.exec(root, ['stash', 'drop', `stash@{${index}}`]);
  }

  stashClear(root: string): Promise<string> {
    return this.exec(root, ['stash', 'clear']);
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function byPath(changes: FileChange[]): void {
  changes.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}

function statusFromLetter(code: string | undefined): ChangeStatus {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'U':
      return 'conflict';
    default:
      return 'modified';
  }
}

export interface StatusLists {
  staged: FileChange[];
  unstaged: FileChange[];
  conflicts: FileChange[];
}

/**
 * Parses `git status --porcelain=v2 -z` into the lists Visual Studio shows.
 * Version 2 is used rather than v1 because rename records carry the original
 * path as an explicit extra NUL-separated field, with no ambiguity about
 * ordering or quoting.
 *
 * The XY code carries two independent states: X is the index, Y is the
 * worktree. A file edited, staged, then edited again is "MM" and genuinely
 * belongs in both lists, so each column is read on its own rather than
 * collapsing the file into one entry.
 *
 * Exported as a pure function so it can be tested without a repository.
 */
export function parseStatus(out: string): StatusLists {
  const tokens = out.split(SEPARATOR);
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const conflicts: FileChange[] = [];

  for (let i = 0; i < tokens.length; i++) {
      const line = tokens[i];
      if (!line) {
        continue;
      }
      const kind = line[0];

      if (kind === '1') {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const parts = line.split(' ');
        const xy = parts[1] ?? '..';
        const path = toPosix(parts.slice(8).join(' '));
        if (xy[0] !== '.') {
          staged.push({ path, status: statusFromLetter(xy[0]), staged: true });
        }
        if (xy[1] !== '.') {
          unstaged.push({ path, status: statusFromLetter(xy[1]), staged: false });
        }
      } else if (kind === '2') {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
        const parts = line.split(' ');
        const xy = parts[1] ?? '..';
        const origPath = toPosix(tokens[++i] ?? '');
        const path = toPosix(parts.slice(9).join(' '));
        if (xy[0] !== '.') {
          staged.push({ path, origPath, status: 'renamed', staged: true });
        }
        if (xy[1] !== '.') {
          // The rename is recorded in the index; any further worktree edit to
          // the new path is an ordinary unstaged change.
          unstaged.push({ path, status: statusFromLetter(xy[1]), staged: false });
        }
      } else if (kind === 'u') {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        // Unmerged paths are neither staged nor unstaged: until they are
        // resolved they cannot be committed at all, so they get their own list.
        const parts = line.split(' ');
        conflicts.push({
          path: toPosix(parts.slice(10).join(' ')),
          status: 'conflict',
          staged: false,
        });
      } else if (kind === '?') {
        unstaged.push({ path: toPosix(line.slice(2)), status: 'untracked', staged: false });
      } else if (kind === '!') {
        unstaged.push({ path: toPosix(line.slice(2)), status: 'ignored', staged: false });
      }
    }

  byPath(staged);
  byPath(unstaged);
  byPath(conflicts);
  return { staged, unstaged, conflicts };
}
