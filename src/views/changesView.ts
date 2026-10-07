import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { countChanges, Git, RepoSnapshot } from '../git/git';
import { ApiRepository, GitApi } from '../gitExtension';
import { buildTree, isUnder, planFolderDiscard, resolveInside, ROOT, TreeNode } from '../git/tree';
import { newNonce } from './nonce';
import { COMMIT_MESSAGE_PROMPT, fitDiff } from '../commitMessage';

/** VS Code's own git blame toggle, present from 1.96. */
const BLAME_COMMAND = 'git.blame.toggleEditorDecoration';

interface ViewModel {
  repos: { root: string; name: string }[];
  active?: RepoSnapshot & {
    /** Trees for the sections; kept apart so each expands independently. */
    unstagedTree: TreeNode[];
    stagedTree: TreeNode[];
    conflictsTree: TreeNode[];
    displayRoot: string;
  };
  separator: string;
  canGenerateMessage: boolean;
  /**
   * Why the snapshot could not be read. It travels in the model, not as a
   * message of its own, because the model posted right behind such a message
   * replaced it before anyone could read it.
   */
  error?: string;
}

type Inbound =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'setRepo'; root: string }
  | { type: 'checkout'; branch: string }
  | { type: 'remote'; op: 'fetch' | 'pull' | 'push' | 'sync' }
  | {
      type: 'commit';
      message: string;
      amend: boolean;
      /** "all" stages everything first; "staged" commits the index as it is. */
      mode: 'all' | 'staged';
      after: 'none' | 'push' | 'sync';
    }
  | { type: 'openChange'; path: string }
  | { type: 'stage'; paths: string[] }
  | { type: 'unstage'; paths: string[] }
  | { type: 'openFile'; path: string }
  | { type: 'revealInExplorer'; path: string }
  | { type: 'viewHistory'; path: string }
  | { type: 'blame'; path: string }
  | { type: 'ignoreAndUntrack'; path: string }
  | { type: 'deleteFile'; path: string }
  | { type: 'discard'; path: string }
  | { type: 'discardFolder'; path: string }
  | { type: 'resolveConflict'; path: string; side: 'ours' | 'theirs' }
  | { type: 'markResolved'; path: string }
  | { type: 'openMergeEditor'; path: string }
  | { type: 'abortOperation' }
  | { type: 'stashPush' }
  | { type: 'stash'; op: 'apply' | 'pop' | 'drop'; index: number }
  | { type: 'stashClear' }
  | { type: 'stashView'; index: number }
  | { type: 'generateMessage' }
  | { type: 'openRepositoryWindow' };

export class ChangesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vsGitStyle.changes';

  private view?: vscode.WebviewView;
  private activeRoot?: string;
  private refreshTimer?: NodeJS.Timeout;
  /** Git work under way, for the activity bar spinner; see beginWork(). */
  private inFlight = 0;
  private endProgress?: () => void;
  /** The commit message request in flight, if any; see generateMessage(). */
  private generation?: vscode.CancellationTokenSource;
  private readonly repoListeners = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly gitApi: GitApi,
    private readonly git: Git
  ) {
    this.disposables.push(
      this.gitApi.onDidOpenRepository((repo) => {
        this.watch(repo);
        this.scheduleRefresh();
      }),
      this.gitApi.onDidCloseRepository((repo) => {
        const key = repo.rootUri.fsPath;
        this.repoListeners.get(key)?.dispose();
        this.repoListeners.delete(key);
        if (this.activeRoot === key) {
          this.activeRoot = undefined;
        }
        this.scheduleRefresh();
      }),
      // Settings are read as the view is built, so a change would otherwise
      // wait for some unrelated event to redraw it and look as though it had
      // not taken. confirmDiscard is read when it is asked, and needs nothing.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('vsGitStyle.showIgnoredFiles')) {
          this.scheduleRefresh(0);
        }
      })
    );

    for (const repo of this.gitApi.repositories) {
      this.watch(repo);
    }
  }

  /** The repository the view is showing, which the Git Repository window follows. */
  get selectedRoot(): string | undefined {
    return this.activeRoot;
  }

  dispose(): void {
    for (const listener of this.repoListeners.values()) {
      listener.dispose();
    }
    this.repoListeners.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    // Work still in flight would otherwise hold the progress task open past
    // the provider that started it.
    this.endProgress?.();
    this.endProgress = undefined;
    this.generation?.cancel();
  }

  private watch(repo: ApiRepository): void {
    const key = repo.rootUri.fsPath;
    if (this.repoListeners.has(key)) {
      return;
    }
    this.repoListeners.set(
      key,
      repo.state.onDidChange(() => this.scheduleRefresh())
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: Inbound) => this.handle(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.scheduleRefresh(50);
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  // --------------------------------------------------------------- refresh ---

  scheduleRefresh(delay = 200): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    const done = this.beginWork();
    try {
      await this.refreshNow();
    } finally {
      done();
    }
  }

  /**
   * The spinner the stock Source Control icon wears while git runs. There is no
   * badge for it in the API: VS Code draws it over a view's activity bar icon
   * while a progress task is reported against that view, so one task is held
   * open for as long as anything is in flight. Opening one per operation would
   * stack them, and the first to finish would not end the spinner.
   *
   * VS Code refuses a view whose pane does not exist yet, which is only a lost
   * spinner, so the refusal is swallowed.
   */
  private beginWork(): () => void {
    this.inFlight++;
    if (this.inFlight === 1) {
      vscode.window
        .withProgress(
          { location: { viewId: ChangesViewProvider.viewType } },
          () => new Promise<void>((resolve) => (this.endProgress = resolve))
        )
        .then(undefined, () => undefined);
    }
    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      this.inFlight--;
      if (this.inFlight === 0) {
        this.endProgress?.();
        this.endProgress = undefined;
      }
    };
  }

  private async refreshNow(): Promise<void> {
    if (!this.view) {
      return;
    }
    if (!this.view.visible) {
      // Collapsed panel: the lists are not worth rebuilding, but the badge on
      // the activity bar icon still has to be right.
      await this.refreshBadge();
      return;
    }

    const repos = this.gitApi.repositories.map((repo) => ({
      root: repo.rootUri.fsPath,
      name: path.basename(repo.rootUri.fsPath),
    }));

    if (!this.activeRoot || !repos.some((r) => r.root === this.activeRoot)) {
      this.activeRoot = repos[0]?.root;
    }

    const separator = process.platform === 'win32' ? '\\' : '/';
    const model: ViewModel = {
      repos,
      separator,
      canGenerateMessage: typeof vscode.lm?.selectChatModels === 'function',
    };

    if (this.activeRoot) {
      try {
        const includeIgnored = vscode.workspace
          .getConfiguration('vsGitStyle')
          .get<boolean>('showIgnoredFiles', false);
        const snapshot = await this.git.snapshot(this.activeRoot, includeIgnored);
        this.setBadge(countChanges(snapshot));
        model.active = {
          ...snapshot,
          unstagedTree: buildTree(snapshot.unstaged, separator),
          stagedTree: buildTree(snapshot.staged, separator),
          conflictsTree: buildTree(snapshot.conflicts, separator),
          displayRoot: this.activeRoot,
        };
      } catch (err) {
        model.error = describe(err);
      }
    } else {
      this.setBadge(0);
    }

    this.post({ type: 'model', model });
  }

  /**
   * Reads the count on its own, for when the panel is collapsed and there is
   * no model to derive it from.
   */
  private async refreshBadge(): Promise<void> {
    const root = this.activeRoot ?? this.gitApi.repositories[0]?.rootUri.fsPath;
    if (!root) {
      this.setBadge(0);
      return;
    }
    try {
      this.setBadge(await this.git.changeCount(root));
    } catch {
      // A read can lose a race with git's own index lock. Leaving the number
      // as it was would strand a badge that no later event comes back to fix,
      // because a failed read is not a repository change - so ask again.
      this.scheduleRefresh(2000);
    }
  }

  /**
   * Puts the number of changed files on the activity bar icon, the way Visual
   * Studio marks its Git Changes tool window. Zero changes means no badge.
   *
   * Clearing takes two writes, which needs explaining. VS Code drops a badge
   * assignment whose value and tooltip both match the one it already holds, and
   * it holds that on the view object rather than on the icon:
   *
   *   set badge(e) { !(e?.value === this.#d?.value &&
   *                    e?.tooltip === this.#d?.tooltip) && (... send ...) }
   *
   * A view VS Code has resolved afresh starts with that cache empty while the
   * icon still carries the badge the previous instance put there, so assigning
   * undefined matches the empty cache, is dropped, and the stale number stays
   * on the icon with nothing able to shift it. Assigning zero first is not
   * dropped, and a zero badge is never drawn - the activity bar sums its number
   * badges and only renders a total above zero - so the icon clears and the
   * cache is left holding something undefined is certain to differ from.
   */
  private setBadge(count: number): void {
    if (!this.view) {
      return;
    }
    try {
      if (count > 0) {
        this.view.badge = {
          value: count,
          tooltip: count === 1 ? '1 changed file' : `${count} changed files`,
        };
        return;
      }
      this.view.badge = { value: 0, tooltip: 'No changes' };
      this.view.badge = undefined;
    } catch {
      // Writing to a view that has just been disposed throws. The badge is not
      // worth failing a refresh over, and the next one will set it anyway.
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private busy(busy: boolean): void {
    this.post({ type: 'busy', busy });
  }

  // -------------------------------------------------------------- handlers ---

  private async handle(message: Inbound): Promise<void> {
    const root = this.activeRoot;
    let done: (() => void) | undefined;
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.refresh();
          return;

        case 'setRepo':
          this.activeRoot = message.root;
          await this.refresh();
          return;

        case 'openRepositoryWindow':
          await vscode.commands.executeCommand('vsGitStyle.openRepositoryWindow');
          return;

        case 'generateMessage':
          await this.generateMessage(root);
          return;
      }

      if (!root) {
        return;
      }

      this.busy(true);
      done = this.beginWork();
      switch (message.type) {
        case 'checkout':
          await this.git.checkout(root, message.branch);
          break;

        case 'remote':
          await this.runRemote(message.op, root);
          break;

        case 'commit':
          await this.commit(root, message);
          break;

        case 'openChange':
          await this.openChange(root, message.path);
          break;

        case 'openFile':
          await vscode.window.showTextDocument(
            vscode.Uri.file(path.join(root, message.path)),
            { preview: true }
          );
          break;

        case 'revealInExplorer': {
          // VS Code's own command, which opens the containing folder with the
          // file selected and knows what the file manager is called on each
          // platform - Explorer, Finder, or whatever is configured here.
          //
          // A deleted file is still listed here and has nothing left to select,
          // so the folder that held it is revealed instead. Walking up rather
          // than stopping at the first missing directory, because a deletion
          // that emptied a folder takes the folder with it.
          const full = path.join(root, message.path);
          let target = full;
          while (target !== root && !fs.existsSync(target)) {
            target = path.dirname(target);
          }
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
          break;
        }

        case 'viewHistory':
          await vscode.commands.executeCommand('vsGitStyle.viewFileHistory', message.path);
          break;

        case 'blame':
          await this.blame(root, message.path);
          break;

        case 'ignoreAndUntrack':
          await this.ignoreAndUntrack(root, message.path);
          break;

        case 'deleteFile':
          await this.deleteFile(root, message.path);
          break;

        case 'stage':
          await this.git.stage(root, message.paths);
          break;

        case 'unstage':
          await this.git.unstage(root, message.paths);
          break;

        case 'discard':
          await this.discard(root, message.path);
          break;

        case 'discardFolder':
          await this.discardFolder(root, message.path);
          break;

        case 'resolveConflict':
          await this.git.resolveWith(root, message.path, message.side);
          break;

        case 'markResolved':
          await this.git.markResolved(root, message.path);
          break;

        case 'openMergeEditor':
          await this.openMergeEditor(root, message.path);
          break;

        case 'abortOperation':
          await this.abortOperation(root);
          break;

        case 'stashPush':
          await this.stashPush(root);
          break;

        case 'stash':
          await this.stashOp(root, message.op, message.index);
          break;

        case 'stashClear':
          await this.stashClear(root);
          break;

        case 'stashView':
          // Stash Details owns the stash from here; see stashDetails.ts.
          await vscode.commands.executeCommand('vsGitStyle.showStash', root, message.index);
          break;
      }
    } catch (err) {
      // Shown in the view, as Visual Studio shows a failed commit in the Git
      // Changes window. A toast was easy to miss, and gone once dismissed,
      // while hook output often needs reading more than once.
      this.post({ type: 'error', message: describe(err) });
    } finally {
      this.busy(false);
      done?.();
      this.scheduleRefresh(50);
    }
  }

  /**
   * Network operations go through the built-in git commands rather than a raw
   * child process so that VS Code's credential helpers and auth providers are
   * used. The command decorators resolve a repository from a Uri hint.
   */
  private async runRemote(op: 'fetch' | 'pull' | 'push' | 'sync', root: string): Promise<void> {
    await vscode.commands.executeCommand(`git.${op}`, vscode.Uri.file(root));
  }

  private async commit(
    root: string,
    message: Extract<Inbound, { type: 'commit' }>
  ): Promise<void> {
    const text = message.message.trim();
    if (!text && !message.amend) {
      void vscode.window.showWarningMessage('Enter a commit message first.');
      return;
    }

    if (message.mode === 'all') {
      await this.git.stageAll(root);
    }

    await this.git.commit(root, text, message.amend);
    this.post({ type: 'committed' });

    if (message.after === 'push') {
      await this.runRemote('push', root);
    } else if (message.after === 'sync') {
      await this.runRemote('sync', root);
    }
  }

  private async openChange(root: string, relPath: string): Promise<void> {
    const uri = vscode.Uri.file(path.join(root, relPath));
    try {
      await vscode.commands.executeCommand('git.openChange', uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  /**
   * Visual Studio's "Blame (Annotate)". VS Code grew its own git blame in 1.96,
   * so the file is opened and that is switched on rather than a blame view of
   * our own being built. The command is a toggle, so a blame already showing
   * would otherwise be turned off by asking for it.
   */
  private async blame(root: string, relPath: string): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, relPath)), {
      preview: true,
    });

    const enabled = vscode.workspace
      .getConfiguration('git')
      .get<boolean>('blame.editorDecoration.enabled', false);
    if (enabled) {
      return;
    }

    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(BLAME_COMMAND)) {
      void vscode.window.showInformationMessage(
        'This version of VS Code has no built-in git blame. Update VS Code, or install a blame extension.'
      );
      return;
    }
    await vscode.commands.executeCommand(BLAME_COMMAND);
  }

  /**
   * Visual Studio's "Ignore and Untrack item". Both halves are destructive in
   * their own way - the file stops being tracked, and .gitignore gains a line -
   * so it is confirmed first, the same as discarding.
   */
  private async ignoreAndUntrack(root: string, relPath: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Ignore and untrack ${path.basename(relPath)}?`,
      {
        modal: true,
        detail:
          `${relPath} will be added to .gitignore and removed from source control. ` +
          'The file itself stays on disk.',
      },
      'Ignore and Untrack'
    );
    if (choice !== 'Ignore and Untrack') {
      return;
    }
    await this.git.ignoreAndUntrack(root, relPath);
  }

  private async deleteFile(root: string, relPath: string): Promise<void> {
    const fate = this.binFate(relPath);
    const choice = await vscode.window.showWarningMessage(
      `Delete ${path.basename(relPath)}?`,
      {
        modal: true,
        detail: this.hasUnsavedChanges(root, [relPath])
          ? `${fate} Its unsaved changes will be lost.`
          : fate,
      },
      'Delete'
    );
    if (choice !== 'Delete') {
      return;
    }
    await this.moveToBin(root, [relPath]);
  }

  /**
   * Deletes files and folders on disk the way the Explorer's own Delete does.
   *
   * That means a workspace edit, not workspace.fs. The Explorer goes through
   * the same bulk edit (`applyBulkEdit` in the shipped workbench bundle), and
   * only that path fires onWillDeleteFiles/onDidDeleteFiles for other
   * extensions; workspace.fs is documented as firing neither. It also settles
   * the two things a confirmation has to state honestly:
   *
   *   useTrash: !skipTrashBin && hasCapability(uri, Trash)
   *             && getValue("files.enableTrash")
   *
   * so the bin is used exactly when the user's setting says so (binFate), and
   * before deleting it soft-reverts any editor holding unsaved changes to a
   * file - those edits are gone, not saved (hasUnsavedChanges).
   *
   * Every path came from the webview, so each must resolve inside the
   * repository before anything is deleted. A path already gone is passed
   * over: the list it came from can be a moment out of date.
   */
  private async moveToBin(root: string, relPaths: string[]): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    for (const relPath of relPaths) {
      const target = resolveInside(root, relPath);
      if (!target) {
        throw new Error(`${relPath} is not inside the repository.`);
      }
      edit.deleteFile(vscode.Uri.file(target), { recursive: true, ignoreIfNotExists: true });
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(
        relPaths.length === 1
          ? `${relPaths[0]} could not be deleted.`
          : `${relPaths.length} files could not be deleted.`
      );
    }
  }

  /** What moveToBin will do with `what`, as the user's files.enableTrash decides. */
  private binFate(what: string): string {
    const toBin = vscode.workspace
      .getConfiguration('files')
      .get<boolean>('enableTrash', true);
    const bin = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
    return toBin ? `${what} will be moved to the ${bin}.` : `${what} will be deleted permanently.`;
  }

  /** Whether an open editor holds unsaved changes to any of these, or beneath them. */
  private hasUnsavedChanges(root: string, relPaths: string[]): boolean {
    const targets = relPaths
      .map((relPath) => resolveInside(root, relPath))
      .filter((target): target is string => target !== undefined)
      .map((target) => vscode.Uri.file(target).fsPath);
    return vscode.workspace.textDocuments.some(
      (doc) =>
        doc.isDirty &&
        doc.uri.scheme === 'file' &&
        targets.some(
          (target) => doc.uri.fsPath === target || doc.uri.fsPath.startsWith(target + path.sep)
        )
    );
  }

  private async discard(root: string, relPath: string): Promise<void> {
    const snapshot = await this.git.snapshot(root, false);
    // Prefer the worktree entry: discarding means reverting the file on disk,
    // and for a file that is in both lists that is the one to act on.
    const change =
      snapshot.unstaged.find((c) => c.path === relPath) ??
      snapshot.staged.find((c) => c.path === relPath);
    if (!change) {
      return;
    }

    // A file git does not track has nothing to revert to, so discarding it
    // deletes it - to the bin, as Delete does, since git holds no copy of it.
    const untracked = change.status === 'untracked' || change.status === 'ignored';
    const confirm = vscode.workspace
      .getConfiguration('vsGitStyle')
      .get<boolean>('confirmDiscard', true);
    if (confirm) {
      const answer = await vscode.window.showWarningMessage(
        `Discard changes in ${change.path}?`,
        {
          modal: true,
          detail: untracked ? this.binFate(change.path) : 'This cannot be undone.',
        },
        'Discard Changes'
      );
      if (answer !== 'Discard Changes') {
        return;
      }
    }

    if (untracked) {
      await this.moveToBin(root, [change.path]);
      return;
    }
    await this.git.discard(root, change);
  }

  /**
   * Reverts every change under one folder. Untracked files inside it can only
   * be "reverted" by deleting them, so they are counted separately and spelled
   * out in the prompt rather than quietly removed - and they go to the bin,
   * where `git clean` used to delete them for good, because git holds no copy
   * of them to get them back from.
   */
  private async discardFolder(root: string, folder: string): Promise<void> {
    const snapshot = await this.git.snapshot(root, false);
    const plan = planFolderDiscard(snapshot.unstaged, snapshot.staged, folder);
    if (plan.affected === 0) {
      return;
    }

    // The root row is asked for as ".", which would read as a typo in a prompt.
    const where = folder === ROOT ? 'the repository' : folder;
    const lines = [`Discard all changes in ${where}?`, ''];
    lines.push(`${plan.affected} file(s) affected.`);
    if (plan.revert) {
      lines.push('Changes to tracked files cannot be undone.');
    }
    if (plan.newFiles.length) {
      lines.push(this.binFate(`${plan.newFiles.length} new file(s)`));
      if (this.hasUnsavedChanges(root, plan.newFiles)) {
        lines.push('Unsaved changes to them will be lost.');
      }
    }

    const answer = await vscode.window.showWarningMessage(
      lines[0],
      { modal: true, detail: lines.slice(2).join(String.fromCharCode(10)) },
      'Discard Changes'
    );
    if (answer !== 'Discard Changes') {
      return;
    }

    if (snapshot.staged.some((c) => isUnder(c.path, folder))) {
      await this.git.unstage(root, [folder]);
    }
    if (plan.revert) {
      await this.git.exec(root, ['checkout', '-q', '--', folder]);
    }
    if (plan.newFiles.length) {
      // Asked after the unstage, so the additions are listed with the rest.
      const toBin = await this.git.untrackedToRemove(root, folder);
      if (toBin.length) {
        await this.moveToBin(root, toBin);
      }
    }
  }

  /**
   * VS Code's own three-way merge editor understands conflict markers in the
   * working tree, so a conflicted file can simply be handed to it.
   */
  private async openMergeEditor(root: string, relPath: string): Promise<void> {
    const uri = vscode.Uri.file(path.join(root, relPath));
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  private async abortOperation(root: string): Promise<void> {
    const snapshot = await this.git.snapshot(root, false);
    const operation = snapshot.operation;
    if (!operation) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Abort the ${operation.kind} in progress?`,
      {
        modal: true,
        detail: 'The working tree returns to how it was before the operation started.',
      },
      `Abort ${operation.kind}`
    );
    if (!answer) {
      return;
    }
    await this.git.exec(root, [operation.kind, '--abort']);
  }

  private async stashPush(root: string): Promise<void> {
    const message = await vscode.window.showInputBox({
      prompt: 'Stash message',
      placeHolder: 'wip',
    });
    if (message === undefined) {
      return;
    }
    await this.git.stashPush(root, message, true);
  }

  private async stashOp(root: string, op: 'apply' | 'pop' | 'drop', index: number): Promise<void> {
    if (op === 'drop') {
      const answer = await vscode.window.showWarningMessage(
        `Drop stash {${index}}? This cannot be undone.`,
        { modal: true },
        'Drop'
      );
      if (answer !== 'Drop') {
        return;
      }
      await this.git.stashDrop(root, index);
      return;
    }
    if (op === 'apply') {
      await this.git.stashApply(root, index);
      return;
    }
    await this.git.stashPop(root, index);
  }

  private async stashClear(root: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      'Drop all stashes? This cannot be undone.',
      { modal: true },
      'Drop All'
    );
    if (answer === 'Drop All') {
      await this.git.stashClear(root);
    }
  }

  /**
   * The sparkle button in Visual Studio's commit box. Uses the VS Code
   * Language Model API when a model is available (Copilot or any other
   * provider); otherwise it tells the user why nothing happened.
   */
  private async generateMessage(root: string | undefined): Promise<void> {
    if (!root) {
      return;
    }
    if (typeof vscode.lm?.selectChatModels !== 'function') {
      void vscode.window.showInformationMessage(
        'Commit message generation needs a language model provider (for example GitHub Copilot).'
      );
      return;
    }

    // Copilot when it is there, so the choice does not depend on the order
    // providers registered in; any other provider when it is not.
    const [model] = [
      ...(await vscode.lm.selectChatModels({ vendor: 'copilot' })),
      ...(await vscode.lm.selectChatModels({})),
    ];
    if (!model) {
      void vscode.window.showInformationMessage(
        'No language model is available. Install and sign in to a chat provider to generate commit messages.'
      );
      return;
    }

    const diff = await this.git.diffForMessage(root);
    if (!diff.trim()) {
      void vscode.window.showInformationMessage('Nothing to describe - there are no changes.');
      return;
    }

    // A second press replaces the first request rather than racing it, and
    // closing the view stops one in flight; see dispose().
    this.generation?.cancel();
    const generation = new vscode.CancellationTokenSource();
    this.generation = generation;
    const token = generation.token;

    this.post({ type: 'generating', generating: true });
    try {
      // The diff is sized against the model's own limit, counted by its own
      // tokenizer; a request over maxInputTokens fails outright.
      const budget =
        model.maxInputTokens -
        (await model.countTokens(COMMIT_MESSAGE_PROMPT, token)) -
        MESSAGE_OVERHEAD_TOKENS;
      const fitted = fitDiff(diff, await model.countTokens(diff, token), budget);

      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(COMMIT_MESSAGE_PROMPT + fitted)],
        {},
        token
      );

      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }
      if (!token.isCancellationRequested) {
        this.post({ type: 'message', message: text.trim() });
      }
    } catch (err) {
      if (!token.isCancellationRequested) {
        void vscode.window.showErrorMessage(describeModelError(err));
      }
    } finally {
      if (this.generation === generation) {
        this.generation = undefined;
        this.post({ type: 'generating', generating: false });
      }
      generation.dispose();
    }
  }

  // ------------------------------------------------------------------ html ---

  private html(webview: vscode.Webview): string {
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...parts));
    const nonce = newNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('codicon.css')}" rel="stylesheet">
<link href="${asset('shell.css')}" rel="stylesheet">
<link href="${asset('main.css')}" rel="stylesheet">
<title>Git Changes</title>
</head>
<body>
<div id="root" class="shell"></div>
<div id="menu" class="context-menu" hidden></div>
<script nonce="${nonce}" src="${asset('format.js')}"></script>
<script nonce="${nonce}" src="${asset('dom.js')}"></script>
<script nonce="${nonce}" src="${asset('changesview.js')}"></script>
<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }
}

/**
 * Room left for what wraps the prompt in a chat request - the role and
 * message framing a provider adds, which countTokens on the text does not see.
 * A few dozen tokens in practice; this leaves a margin rather than fail on it.
 */
const MESSAGE_OVERHEAD_TOKENS = 100;

/**
 * The language model's failures in words that say what to do. The API names
 * them by code; the message it carries is written for developers.
 */
function describeModelError(err: unknown): string {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return 'VS Git Style has not been allowed to use the language model. Allow it when VS Code asks, then try again.';
      case vscode.LanguageModelError.Blocked.name:
        return 'The language model refused the request, possibly for a usage limit. Try again later.';
      case vscode.LanguageModelError.NotFound.name:
        return 'The language model is no longer available. Check the chat provider is installed and signed in.';
    }
  }
  return describe(err);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
