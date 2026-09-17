import * as path from 'path';
import * as vscode from 'vscode';
import { readFileDiff } from './diff';
import { Git } from './git';
import { GitApi } from './gitExtension';
import {
  GraphModel,
  readCommitDetails,
  readGraph,
  readRefs,
  readReviewInfo,
  RefEntry,
  ReviewInfo,
  ReviewProvider,
} from './graph';

export const COMMIT_SCHEME = 'vsgitstyle-commit';
export const BLOB_SCHEME = 'vsgitstyle-blob';

const DEFAULT_PAGE_SIZE = 200;

function pageSize(): number {
  return vscode.workspace
    .getConfiguration('vsGitStyle')
    .get<number>('graphPageSize', DEFAULT_PAGE_SIZE);
}

interface WindowModel {
  repoName: string;
  root: string;
  refs: RefEntry[];
  graph: GraphModel;
  review: ReviewInfo;
}

type Inbound =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'setScope'; scope: string }
  | { type: 'clearFile' }
  | { type: 'loadMore' }
  | { type: 'remote'; op: 'fetch' | 'pull' | 'push' | 'sync' }
  | { type: 'checkout'; ref: string }
  | { type: 'copyId'; hash: string }
  | { type: 'showCommit'; hash: string }
  | { type: 'branchFrom'; hash: string }
  | { type: 'selectCommit'; hash: string }
  | {
      type: 'openFileDiff';
      hash: string;
      path: string;
      origPath?: string;
      status: string;
    }
  | { type: 'fileDiff'; hash: string; path: string; origPath?: string };

/**
 * The Git Repository window: Visual Studio's full-screen commit graph, as a
 * WebviewPanel in the editor area.
 */
export class RepositoryWindow {
  private static current: RepositoryWindow | undefined;

  /**
   * `file` scopes the history to one path, the way Visual Studio's "View
   * History" does. Passing it to an already-open window re-scopes that one
   * rather than opening a second.
   */
  static show(extensionUri: vscode.Uri, gitApi: GitApi, git: Git, file?: string): void {
    if (RepositoryWindow.current) {
      RepositoryWindow.current.panel.reveal();
      if (file) {
        void RepositoryWindow.current.showFile(file);
      }
      return;
    }
    const root = gitApi.repositories[0]?.rootUri.fsPath;
    if (!root) {
      void vscode.window.showWarningMessage('No Git repository is open.');
      return;
    }
    RepositoryWindow.current = new RepositoryWindow(extensionUri, gitApi, git, root, file);
  }

  /** Re-scopes an open window to one file's history. */
  private async showFile(file: string): Promise<void> {
    this.file = file;
    this.limit = pageSize();
    await this.load();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private scope: string | undefined;
  /** Repo-relative path when the window is showing one file's history. */
  private file: string | undefined;
  private limit = pageSize();
  private loadTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    gitApi: GitApi,
    private readonly git: Git,
    private readonly root: string,
    file?: string
  ) {
    this.file = file;
    this.panel = vscode.window.createWebviewPanel(
      'vsGitStyle.repository',
      `Git Repository - ${path.basename(root)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'activity-icon.svg');
    this.panel.webview.html = this.html(this.panel.webview);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: Inbound) => this.handle(message)),
      this.panel.onDidDispose(() => this.dispose())
    );

    // Without this the window only reloads for its own actions, so a fetch or
    // commit made anywhere else - the Git Changes view, a terminal, another
    // editor - leaves the graph and the incoming/outgoing counts stale and
    // disagreeing with the sidebar.
    const repository = gitApi.repositories.find((r) => r.rootUri.fsPath === root);
    if (repository) {
      this.disposables.push(repository.state.onDidChange(() => this.scheduleLoad()));
    }
    this.disposables.push(
      this.panel.onDidChangeViewState(() => {
        if (this.panel.visible) {
          this.scheduleLoad(100);
        }
      })
    );
  }

  /**
   * Repository state can fire repeatedly during a fetch, and a reload costs
   * several git invocations, so coalesce them.
   */
  private scheduleLoad(delay = 400): void {
    if (this.loadTimer) {
      clearTimeout(this.loadTimer);
    }
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined;
      if (this.panel.visible) {
        void this.load().catch(() => {
          /* surfaced by handle() for user-initiated loads */
        });
      }
    }, delay);
  }

  private dispose(): void {
    RepositoryWindow.current = undefined;
    if (this.loadTimer) {
      clearTimeout(this.loadTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  // --------------------------------------------------------------- handlers ---

  private async handle(message: Inbound): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.load();
          return;

        case 'setScope':
          this.scope = message.scope;
          // Picking a branch means leaving one file's history behind.
          this.file = undefined;
          this.limit = pageSize();
          await this.load();
          return;

        case 'clearFile':
          this.file = undefined;
          this.limit = pageSize();
          await this.load();
          return;

        case 'loadMore':
          this.limit += pageSize();
          await this.load();
          return;

        case 'remote':
          await vscode.commands.executeCommand(
            `git.${message.op}`,
            vscode.Uri.file(this.root)
          );
          await this.load();
          return;

        case 'checkout':
          await this.git.checkout(this.root, message.ref);
          this.scope = message.ref;
          await this.load();
          return;

        case 'copyId':
          await vscode.env.clipboard.writeText(message.hash);
          void vscode.window.setStatusBarMessage(
            `Copied ${message.hash.slice(0, 7)}`,
            2000
          );
          return;

        case 'showCommit':
          await this.showCommit(message.hash);
          return;

        case 'branchFrom':
          await this.branchFrom(message.hash);
          return;

        case 'selectCommit':
          await this.sendDetails(message.hash);
          return;

        case 'openFileDiff':
          await this.openFileDiff(message);
          return;

        case 'fileDiff':
          await this.sendFileDiff(message);
          return;
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err)
      );
      this.post({ type: 'busy', busy: false });
    }
  }

  private async load(): Promise<void> {
    this.post({ type: 'busy', busy: true });
    const refs = await readRefs(this.git, this.root);
    if (!this.scope || !refs.some((r) => r.short === this.scope)) {
      this.scope = refs.find((r) => r.current)?.short ?? 'HEAD';
    }
    const graph = await readGraph(this.git, this.root, this.scope, this.limit, this.file);
    const configured = vscode.workspace
      .getConfiguration('vsGitStyle')
      .get<ReviewProvider | 'auto'>('reviewProvider', 'auto');
    const review = await readReviewInfo(this.git, this.root, configured);

    const model: WindowModel = {
      repoName: path.basename(this.root),
      root: this.root,
      refs,
      graph,
      review,
    };
    this.post({ type: 'model', model });
    this.post({ type: 'busy', busy: false });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async sendDetails(hash: string): Promise<void> {
    try {
      const details = await readCommitDetails(this.git, this.root, hash);
      this.post({ type: 'commitDetails', details });
    } catch (err) {
      this.post({
        type: 'commitDetails',
        details: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The side-by-side diff drawn inside the details pane. Errors travel to the
   * webview rather than to a notification: the pane has a place to show one,
   * and a file that cannot be read should not take the whole window with it.
   */
  private async sendFileDiff(
    message: Extract<Inbound, { type: 'fileDiff' }>
  ): Promise<void> {
    try {
      const diff = await readFileDiff(
        this.git,
        this.root,
        message.hash,
        message.path,
        message.origPath
      );
      this.post({ type: 'fileDiff', hash: message.hash, path: message.path, diff });
    } catch (err) {
      this.post({
        type: 'fileDiff',
        hash: message.hash,
        path: message.path,
        diff: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private blobUri(rev: string, filePath: string): vscode.Uri {
    // The published path keeps the file name so the editor picks a language,
    // and the revision prefix keeps the two sides of a diff distinct.
    return vscode.Uri.from({
      scheme: BLOB_SCHEME,
      path: `/${rev.replace(/[^\w.-]/g, '_')}/${filePath}`,
      query: new URLSearchParams({ root: this.root, rev, path: filePath }).toString(),
    });
  }

  private async openFileDiff(
    message: Extract<Inbound, { type: 'openFileDiff' }>
  ): Promise<void> {
    const previous = message.origPath ?? message.path;
    const left = this.blobUri(`${message.hash}^`, previous);
    const right = this.blobUri(message.hash, message.path);
    const name = message.path.split('/').pop() ?? message.path;
    const short = message.hash.slice(0, 7);
    const title =
      message.origPath && message.origPath !== message.path
        ? `${name} (${short}) ← ${message.origPath.split('/').pop()}`
        : `${name} (${short})`;
    // A missing side - an added file, a deleted file, or the root commit's
    // absent parent - comes back empty from the blob provider, which reads as
    // an all-added or all-removed diff.
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  }

  private async showCommit(hash: string): Promise<void> {
    const uri = vscode.Uri.from({
      scheme: COMMIT_SCHEME,
      path: `/${hash.slice(0, 7)}.diff`,
      query: new URLSearchParams({ root: this.root, hash }).toString(),
    });
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async branchFrom(hash: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `New branch at ${hash.slice(0, 7)}`,
      placeHolder: 'branch name',
      validateInput: (value) =>
        value.trim() ? undefined : 'Enter a branch name.',
    });
    if (!name) {
      return;
    }
    await this.git.exec(this.root, ['branch', name.trim(), hash]);
    void vscode.window.showInformationMessage(
      `Created ${name.trim()} at ${hash.slice(0, 7)}.`
    );
    await this.load();
  }

  // ------------------------------------------------------------------ html ---

  private html(webview: vscode.Webview): string {
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...parts));
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62)
      )
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('codicon.css')}" rel="stylesheet">
<link href="${asset('repo.css')}" rel="stylesheet">
<title>Git Repository</title>
</head>
<body>
<div id="root" class="repo-shell"></div>
<div id="menu" class="context-menu" hidden></div>
<script nonce="${nonce}" src="${asset('virtual.js')}"></script>
<script nonce="${nonce}" src="${asset('diffview.js')}"></script>
<script nonce="${nonce}" src="${asset('syntax.js')}"></script>
<script nonce="${nonce}" src="${asset('repo.js')}"></script>
</body>
</html>`;
  }
}

/**
 * Backs the `vsgitstyle-blob:` scheme, so one file at one revision can be shown
 * as a read-only document and fed to `vscode.diff`.
 */
export class BlobContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: Git) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const root = params.get('root');
    const rev = params.get('rev');
    const filePath = params.get('path');
    if (!root || !rev || !filePath) {
      return '';
    }
    try {
      return await this.git.exec(root, ['show', `${rev}:${filePath}`]);
    } catch {
      // The path does not exist at that revision, or the revision does not
      // exist at all (the root commit's parent). An empty side is correct.
      return '';
    }
  }
}

/**
 * Backs the `vsgitstyle-commit:` scheme used by "View Commit Details", so a
 * commit opens as an ordinary read-only diff document.
 */
export class CommitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: Git) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const root = params.get('root');
    const hash = params.get('hash');
    if (!root || !hash) {
      return '';
    }
    try {
      return await this.git.exec(root, [
        'show',
        '--stat',
        '--patch',
        '--no-color',
        hash,
      ]);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}
