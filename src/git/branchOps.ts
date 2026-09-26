/**
 * What the branch context menu offers, and the git command behind each entry.
 *
 * The menu's shape is a decision - which entries apply to this branch, what
 * they are called, which are disabled and which need confirming first - and
 * decisions belong somewhere they can be tested. The view layer is left with
 * the prompting and the running.
 *
 * Kept free of vscode imports, like the rest of src/git.
 */

/** Everything the menu can ask for. Visual Studio's list, less "Add to Chat". */
export type BranchOp =
  | 'checkout'
  | 'checkoutDetach'
  | 'createBranch'
  | 'merge'
  | 'rebase'
  | 'resetSoft'
  | 'resetMixed'
  | 'resetHard'
  | 'cherryPick'
  | 'rename'
  | 'delete'
  | 'deleteForce'
  | 'viewHistory'
  | 'compare'
  | 'toggleInHistory'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'sync'
  | 'newWorktree';

export interface BranchTarget {
  /** Display name: `feature/x`, or `origin/main` for a remote-tracking branch. */
  short: string;
  kind: 'head' | 'remote' | 'tag';
  current: boolean;
  upstream?: string;
}

export interface OpContext {
  target: BranchTarget;
  /** The checked-out branch, or undefined when HEAD is detached. */
  current?: string;
  /** A branch name, for create and rename. */
  name?: string;
  /** Where a new worktree goes. */
  path?: string;
}

export interface MenuEntry {
  op: BranchOp;
  label: string;
  icon?: string;
  /** Shown greyed, with `why` as the reason. */
  disabled?: boolean;
  why?: string;
  /** A separator follows this entry. */
  breakAfter?: boolean;
}

/**
 * The git invocation for an operation, or null where there is no single one -
 * `viewHistory`, `compare` and `toggleInHistory` are the window's own business
 * and never shell out on their own.
 *
 * Refs are passed to git after `--` or as whole arguments, never interpolated
 * into a string, so a branch named like a flag cannot become one.
 */
export function branchArgs(op: BranchOp, ctx: OpContext): string[] | null {
  const ref = ctx.target.short;
  switch (op) {
    case 'checkout':
      // A remote-tracking branch has no local counterpart to move onto, so
      // checking one out means creating that counterpart. git does this itself
      // when the name is unambiguous, which is what --track spells out.
      return ctx.target.kind === 'remote'
        ? ['checkout', '--track', ref]
        : ['checkout', ref];
    case 'checkoutDetach':
      return ['checkout', '--detach', ref];
    case 'createBranch':
      return ctx.name ? ['branch', ctx.name, ref] : null;
    case 'merge':
      return ['merge', '--no-ff', ref];
    case 'rebase':
      return ['rebase', ref];
    case 'resetSoft':
      return ['reset', '--soft', ref];
    case 'resetMixed':
      return ['reset', '--mixed', ref];
    case 'resetHard':
      return ['reset', '--hard', ref];
    case 'cherryPick':
      return ['cherry-pick', ref];
    case 'rename':
      return ctx.name ? ['branch', '-m', ref, ctx.name] : null;
    case 'delete':
      // -d refuses to drop work that is not merged anywhere; deleteForce is
      // the separate, confirmed decision to do it anyway.
      return ctx.target.kind === 'remote'
        ? ['push', '--delete', ...splitRemote(ref)]
        : ['branch', '-d', ref];
    case 'deleteForce':
      return ctx.target.kind === 'remote'
        ? ['push', '--delete', ...splitRemote(ref)]
        : ['branch', '-D', ref];
    case 'fetch':
      return ['fetch'];
    case 'pull':
      return ['pull', '--ff-only'];
    case 'push':
      return ['push'];
    case 'newWorktree':
      return ctx.path ? ['worktree', 'add', ctx.path, ref] : null;
    case 'sync':
    case 'viewHistory':
    case 'compare':
    case 'toggleInHistory':
      return null;
  }
}

/** `origin/feature/x` as the two arguments `git push --delete` wants. */
function splitRemote(ref: string): string[] {
  const at = ref.indexOf('/');
  return at === -1 ? [ref] : [ref.slice(0, at), ref.slice(at + 1)];
}

export interface Confirmation {
  message: string;
  detail: string;
  /** The button that goes ahead. */
  confirm: string;
  /** Marks it red: the work it destroys cannot be recovered from git. */
  destructive?: boolean;
}

/**
 * What to ask before going ahead, or null for an operation that is its own
 * undo.
 *
 * Checking out, creating and fetching change nothing that cannot be walked
 * back. Merging, rebasing, resetting and deleting can each cost work, and a
 * reset --hard or a forced delete can cost it irrecoverably, so those say so.
 */
export function confirmation(op: BranchOp, ctx: OpContext): Confirmation | null {
  const ref = ctx.target.short;
  const onto = ctx.current ?? 'HEAD';
  switch (op) {
    case 'merge':
      return {
        message: `Merge '${ref}' into '${onto}'?`,
        detail: 'A merge commit will be created. Conflicts will stop it part-way.',
        confirm: 'Merge',
      };
    case 'rebase':
      return {
        message: `Rebase '${onto}' onto '${ref}'?`,
        detail: `Every commit on '${onto}' is rewritten. Do not rebase what others have pulled.`,
        confirm: 'Rebase',
        destructive: true,
      };
    case 'resetSoft':
      return {
        message: `Reset '${onto}' to '${ref}', keeping the changes staged?`,
        detail: 'The working tree and the index are left alone.',
        confirm: 'Reset',
      };
    case 'resetMixed':
      return {
        message: `Reset '${onto}' to '${ref}', keeping the changes unstaged?`,
        detail: 'The working tree is left alone; the index is not.',
        confirm: 'Reset',
      };
    case 'resetHard':
      return {
        message: `Reset '${onto}' to '${ref}' and discard all changes?`,
        detail: 'Uncommitted work in the working tree is lost. Git cannot bring it back.',
        confirm: 'Discard and Reset',
        destructive: true,
      };
    case 'cherryPick':
      return {
        message: `Cherry-pick the tip of '${ref}' onto '${onto}'?`,
        detail: 'Its changes are applied as a new commit here.',
        confirm: 'Cherry-Pick',
      };
    case 'delete':
      return {
        message: `Delete branch '${ref}'?`,
        detail:
          ctx.target.kind === 'remote'
            ? 'This deletes it on the remote, for everyone.'
            : 'Commits it alone points at become unreachable.',
        confirm: 'Delete',
        destructive: ctx.target.kind === 'remote',
      };
    case 'deleteForce':
      return {
        message: `Delete branch '${ref}' even though it is not fully merged?`,
        detail: 'Commits only this branch points at will be lost.',
        confirm: 'Delete Anyway',
        destructive: true,
      };
    default:
      return null;
  }
}

/**
 * The menu for one branch, in Visual Studio's order.
 *
 * Entries that cannot apply are shown disabled rather than hidden, so the menu
 * does not change shape from branch to branch and `why` can say what is wrong -
 * a menu that silently omits "Merge" teaches nothing.
 */
export function branchMenu(target: BranchTarget, current?: string): MenuEntry[] {
  const ref = target.short;
  const onto = current ?? 'HEAD';
  const isTag = target.kind === 'tag';
  const isRemote = target.kind === 'remote';
  const self = target.current;

  const entries: MenuEntry[] = [
    {
      op: 'checkout',
      label: isRemote ? `Checkout and Track '${ref}'` : 'Checkout',
      icon: 'check',
      disabled: self,
      why: self ? 'Already checked out' : undefined,
    },
    {
      op: 'checkoutDetach',
      label: 'Checkout Tip Commit (--detach)',
      breakAfter: true,
    },
    {
      op: 'createBranch',
      label: 'New Local Branch From…',
      icon: 'git-branch',
    },
    {
      op: 'merge',
      label: `Merge '${ref}' into '${onto}'`,
      icon: 'git-merge',
      disabled: self || !current,
      why: self ? 'A branch cannot be merged into itself' : !current ? 'HEAD is detached' : undefined,
    },
    {
      op: 'rebase',
      label: `Rebase '${onto}' onto '${ref}'`,
      disabled: self || !current,
      why: self ? 'A branch cannot be rebased onto itself' : !current ? 'HEAD is detached' : undefined,
    },
    { op: 'resetSoft', label: `Reset — Keep Changes Staged (--soft)` },
    { op: 'resetMixed', label: `Reset — Keep Changes (--mixed)` },
    { op: 'resetHard', label: `Reset — Discard Changes (--hard)` },
    {
      op: 'cherryPick',
      label: 'Cherry-Pick',
      breakAfter: true,
    },
    {
      op: 'rename',
      label: 'Rename…',
      icon: 'edit',
      disabled: isRemote || isTag,
      why: isRemote ? 'Rename it locally instead' : isTag ? 'Tags cannot be renamed' : undefined,
    },
    {
      op: 'delete',
      label: 'Delete',
      icon: 'trash',
      disabled: self,
      why: self ? 'The checked-out branch cannot be deleted' : undefined,
      breakAfter: true,
    },
    { op: 'viewHistory', label: 'View History', icon: 'history' },
    {
      op: 'compare',
      label: `Compare '${ref}' with '${onto}'…`,
      icon: 'diff',
      disabled: self || !current,
      why: self ? 'It is the current branch' : !current ? 'HEAD is detached' : undefined,
    },
    {
      op: 'toggleInHistory',
      label: 'Toggle Branch in History',
      icon: 'eye',
      breakAfter: true,
    },
    { op: 'fetch', label: 'Fetch', icon: 'cloud-download' },
    {
      op: 'pull',
      label: 'Pull',
      icon: 'arrow-down',
      disabled: !self || !target.upstream,
      why: !self ? 'Checkout the branch first' : 'It has no upstream',
    },
    {
      op: 'push',
      label: 'Push',
      icon: 'arrow-up',
      disabled: !self,
      why: !self ? 'Checkout the branch first' : undefined,
    },
    {
      op: 'sync',
      label: 'Sync (Pull then Push)',
      icon: 'sync',
      disabled: !self || !target.upstream,
      why: !self ? 'Checkout the branch first' : 'It has no upstream',
      breakAfter: true,
    },
    { op: 'newWorktree', label: 'New Worktree From…', icon: 'new-folder' },
  ];

  // A tag is a place in history, not a line of work: the operations that move
  // it or push it have no meaning.
  return isTag
    ? entries.filter((entry) => !['merge', 'rename', 'pull', 'push', 'sync'].includes(entry.op))
    : entries;
}
