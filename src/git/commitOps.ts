/**
 * What the commit context menu offers, and the git command behind each entry.
 *
 * The same split as branchOps.ts: which entries apply, what they are called,
 * which are disabled and what has to be confirmed are decisions, tested here;
 * the window is left with the prompting and the running.
 */

export type CommitOp =
  | 'checkoutDetach'
  | 'viewDetails'
  | 'compare'
  | 'newBranch'
  | 'newTag'
  | 'revert'
  | 'resetSoft'
  | 'resetMixed'
  | 'resetHard'
  | 'cherryPick'
  | 'goToChild'
  | 'goToParent'
  | 'refresh'
  | 'outgoingOnly'
  | 'newWorktree'
  | 'copyId'
  | 'viewPatch';

export interface CommitTarget {
  hash: string;
  shortHash: string;
  subject: string;
  parents: string[];
  /** True when the row is one of the commits not yet pushed. */
  outgoing?: boolean;
  /** True when this commit is what HEAD points at. */
  isHead?: boolean;
}

export interface CommitContext {
  target: CommitTarget;
  /** The checked-out branch, or undefined when HEAD is detached. */
  current?: string;
  /** A branch or tag name, for the two that create one. */
  name?: string;
  /** A message, for an annotated tag. */
  message?: string;
  path?: string;
  /** The other commit, for a comparison. */
  other?: string;
  /** Whether the graph is already filtered to outgoing and incoming commits. */
  filtered?: boolean;
}

export interface CommitMenuEntry {
  op: CommitOp;
  label: string;
  icon?: string;
  /** Shown beside the label, as Visual Studio shows its shortcuts. */
  shortcut?: string;
  disabled?: boolean;
  why?: string;
  breakAfter?: boolean;
  /** Drawn with a tick, for the entries that are a state rather than an action. */
  checked?: boolean;
}

/**
 * The git invocation, or null for the entries the window handles itself.
 *
 * A hash is always passed as its own argument, never built into a string.
 */
export function commitArgs(op: CommitOp, ctx: CommitContext): string[] | null {
  const hash = ctx.target.hash;
  switch (op) {
    case 'checkoutDetach':
      return ['checkout', '--detach', hash];
    case 'newBranch':
      return ctx.name ? ['branch', ctx.name, hash] : null;
    case 'newTag':
      // An annotated tag when there is something to say, a lightweight one
      // otherwise: -m on its own would make every tag annotated with an empty
      // message, which git records as a tag object with nothing in it.
      return ctx.name
        ? ctx.message
          ? ['tag', '-a', ctx.name, '-m', ctx.message, hash]
          : ['tag', ctx.name, hash]
        : null;
    case 'revert':
      // A merge has no single "before" to undo against, so -m 1 says to undo
      // it as it looked from the branch it was merged into.
      return ctx.target.parents.length > 1
        ? ['revert', '--no-edit', '-m', '1', hash]
        : ['revert', '--no-edit', hash];
    case 'resetSoft':
      return ['reset', '--soft', hash];
    case 'resetMixed':
      return ['reset', '--mixed', hash];
    case 'resetHard':
      return ['reset', '--hard', hash];
    case 'cherryPick':
      return ctx.target.parents.length > 1
        ? ['cherry-pick', '-m', '1', hash]
        : ['cherry-pick', hash];
    case 'newWorktree':
      return ctx.path ? ['worktree', 'add', '--detach', ctx.path, hash] : null;
    case 'viewDetails':
    case 'compare':
    case 'goToChild':
    case 'goToParent':
    case 'refresh':
    case 'outgoingOnly':
    case 'copyId':
    case 'viewPatch':
      return null;
  }
}

export interface CommitConfirmation {
  message: string;
  detail: string;
  confirm: string;
  destructive?: boolean;
}

/** What to ask before going ahead, or null where the action is its own undo. */
export function commitConfirmation(
  op: CommitOp,
  ctx: CommitContext
): CommitConfirmation | null {
  const at = `${ctx.target.shortHash} ${ctx.target.subject}`;
  const onto = ctx.current ?? 'HEAD';
  switch (op) {
    case 'revert':
      return {
        message: `Revert ${ctx.target.shortHash}?`,
        detail: `A new commit undoing "${ctx.target.subject}" is added to '${onto}'. The original is left in place.`,
        confirm: 'Revert',
      };
    case 'cherryPick':
      return {
        message: `Cherry-pick ${ctx.target.shortHash} onto '${onto}'?`,
        detail: `"${ctx.target.subject}" is applied here as a new commit.`,
        confirm: 'Cherry-Pick',
      };
    case 'resetSoft':
      return {
        message: `Reset '${onto}' to ${at}, keeping the changes staged?`,
        detail: 'The working tree and the index are left alone.',
        confirm: 'Reset',
      };
    case 'resetMixed':
      return {
        message: `Reset '${onto}' to ${at}, keeping the changes unstaged?`,
        detail: 'The working tree is left alone; the index is not.',
        confirm: 'Reset',
      };
    case 'resetHard':
      return {
        message: `Reset '${onto}' to ${at} and discard all changes?`,
        detail: 'Uncommitted work in the working tree is lost. Git cannot bring it back.',
        confirm: 'Discard and Reset',
        destructive: true,
      };
    case 'checkoutDetach':
      return {
        message: `Check out ${ctx.target.shortHash} directly?`,
        detail:
          'HEAD will not be on a branch. Commits made here are reachable only by their hash until a branch is made for them.',
        confirm: 'Checkout',
      };
    default:
      return null;
  }
}

/**
 * The menu for one commit, in Visual Studio's order.
 *
 * Two of its entries are not here. "Add to Chat" was not asked for, and
 * "Review Commit" and "Squash Commits…" would each be a button for something
 * this extension does not do - a menu that offers what it cannot deliver is
 * worse than one that is shorter.
 */
export function commitMenu(target: CommitTarget, ctx: Partial<CommitContext> = {}): CommitMenuEntry[] {
  const merge = target.parents.length > 1;
  const root = target.parents.length === 0;
  const current = ctx.current;

  return [
    {
      op: 'checkoutDetach',
      label: 'Checkout (--detach)',
      disabled: target.isHead,
      why: target.isHead ? 'HEAD is already here' : undefined,
    },
    { op: 'viewDetails', label: 'View Commit Details', icon: 'git-commit' },
    { op: 'viewPatch', label: 'View Full Patch' },
    {
      op: 'compare',
      label: 'Compare Commits…',
      icon: 'diff',
      breakAfter: true,
    },
    { op: 'newBranch', label: 'New Branch…', icon: 'git-branch' },
    { op: 'newTag', label: 'New Tag…', icon: 'tag', breakAfter: true },
    {
      op: 'revert',
      label: merge ? 'Revert (against the first parent)' : 'Revert',
      disabled: root,
      why: root ? 'The first commit has nothing to undo against' : undefined,
    },
    { op: 'resetSoft', label: 'Reset — Keep Changes Staged (--soft)' },
    { op: 'resetMixed', label: 'Reset — Keep Changes (--mixed)' },
    { op: 'resetHard', label: 'Reset — Discard Changes (--hard)' },
    {
      op: 'cherryPick',
      label: merge ? 'Cherry-Pick (against the first parent)' : 'Cherry-Pick',
      disabled: root || target.isHead,
      why: root
        ? 'The first commit has no changes to carry'
        : target.isHead
          ? 'It is already here'
          : undefined,
      breakAfter: true,
    },
    {
      op: 'goToChild',
      label: 'Go to Child',
      icon: 'arrow-up',
      shortcut: 'Alt+PgUp',
    },
    {
      op: 'goToParent',
      label: 'Go to Parent',
      icon: 'arrow-down',
      shortcut: 'Alt+PgDn',
      disabled: root,
      why: root ? 'The first commit has no parent' : undefined,
      breakAfter: true,
    },
    { op: 'copyId', label: 'Copy Commit ID', icon: 'copy' },
    { op: 'refresh', label: 'Refresh', icon: 'refresh' },
    {
      op: 'outgoingOnly',
      label: 'Show Outgoing / Incoming Only',
      checked: !!ctx.filtered,
      disabled: !current,
      why: !current ? 'HEAD is detached, so there is nothing to compare against' : undefined,
      breakAfter: true,
    },
    { op: 'newWorktree', label: 'New Worktree From…', icon: 'new-folder' },
  ];
}

/**
 * The commit a "Go to Parent" or "Go to Child" lands on.
 *
 * Parent is the first one: on a merge that is the branch it was merged into,
 * which is the line the eye is already following. A child has to be searched
 * for, because a commit does not record them - the newest is taken, so
 * repeated steps walk back up the way the history is drawn.
 *
 * Returns null when there is nowhere to go, which the caller reports rather
 * than silently doing nothing.
 */
export function stepTo(
  direction: 'parent' | 'child',
  hash: string,
  rows: { hash: string; parents: string[] }[]
): string | null {
  if (direction === 'parent') {
    const row = rows.find((candidate) => candidate.hash === hash);
    return row?.parents[0] ?? null;
  }
  const child = rows.find((candidate) => candidate.parents.includes(hash));
  return child?.hash ?? null;
}
