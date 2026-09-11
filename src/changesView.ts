import * as path from 'path';
import * as vscode from 'vscode';
import { Git, RepoSnapshot } from './git';
import { ApiRepository, GitApi } from './gitExtension';
import { buildTree, TreeNode } from './tree';

interface ViewModel {
  repos: { root: string; name: string }[];
  active?: RepoSnapshot & {
    /** Trees for the two sections; kept apart so each expands independently. */
    unstagedTree: TreeNode[];
    stagedTree: TreeNode[];
    displayRoot: string;
  };
  separator: string;
  canGenerateMessage: boolean;
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
  | { type: 'discard'; path: string }
  | { type: 'stashPush' }
  | { type: 'stash'; op: 'apply' | 'pop' | 'drop'; index: number }
  | { type: 'stashClear' }
  | { type: 'generateMessage' }
  | { type: 'openRepositoryWindow' };

export class ChangesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vsGitStyle.changes';

  private view?: vscode.WebviewView;
  private activeRoot?: string;
  private refreshTimer?: NodeJS.Timeout;
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
      })
    );

    for (const repo of this.gitApi.repositories) {
      this.watch(repo);
    }
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
    if (!this.view?.visible) {
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
        model.active = {
          ...snapshot,
          unstagedTree: buildTree(snapshot.unstaged, separator),
          stagedTree: buildTree(snapshot.staged, separator),
          displayRoot: this.activeRoot,
        };
      } catch (err) {
        this.post({ type: 'error', message: describe(err) });
      }
    }

    this.post({ type: 'model', model });
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

        case 'stage':
          await this.git.stage(root, message.paths);
          break;

        case 'unstage':
          await this.git.unstage(root, message.paths);
          break;

        case 'discard':
          await this.discard(root, message.path);
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
      }
    } catch (err) {
      void vscode.window.showErrorMessage(describe(err));
    } finally {
      this.busy(false);
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

    const confirm = vscode.workspace
      .getConfiguration('vsGitStyle')
      .get<boolean>('confirmDiscard', true);
    if (confirm) {
      const answer = await vscode.window.showWarningMessage(
        `Discard changes in ${change.path}? This cannot be undone.`,
        { modal: true },
        'Discard Changes'
      );
      if (answer !== 'Discard Changes') {
        return;
      }
    }

    await this.git.discard(root, change);
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

    const models = await vscode.lm.selectChatModels({});
    if (models.length === 0) {
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

    this.post({ type: 'generating', generating: true });
    try {
      const response = await models[0].sendRequest(
        [
          vscode.LanguageModelChatMessage.User(
            'Write a git commit message for the diff below. Use a short imperative subject ' +
              'line of at most 72 characters. Add a blank line and a brief body only if the ' +
              'change is not self-explanatory. Reply with the message only.\n\n' +
              diff
          ),
        ],
        {},
        new vscode.CancellationTokenSource().token
      );

      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }
      this.post({ type: 'message', message: text.trim() });
    } catch (err) {
      void vscode.window.showErrorMessage(describe(err));
    } finally {
      this.post({ type: 'generating', generating: false });
    }
  }

  // ------------------------------------------------------------------ html ---

  private html(webview: vscode.Webview): string {
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...parts));
    const nonce = nonceString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('codicon.css')}" rel="stylesheet">
<link href="${asset('main.css')}" rel="stylesheet">
<title>Git Changes</title>
</head>
<body>
<div id="root" class="shell"></div>
<div id="menu" class="context-menu" hidden></div>
<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }
}

function nonceString(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
