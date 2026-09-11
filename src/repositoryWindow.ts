import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from './git';
import { GitApi } from './gitExtension';
import {
  GraphModel,
  readGraph,
  readRefs,
  readReviewInfo,
  RefEntry,
  ReviewInfo,
  ReviewProvider,
} from './graph';

export const COMMIT_SCHEME = 'vsgitstyle-commit';

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
  | { type: 'loadMore' }
  | { type: 'remote'; op: 'fetch' | 'pull' | 'push' | 'sync' }
  | { type: 'checkout'; ref: string }
  | { type: 'copyId'; hash: string }
  | { type: 'showCommit'; hash: string }
  | { type: 'branchFrom'; hash: string };

/**
 * The Git Repository window: Visual Studio's full-screen commit graph, as a
 * WebviewPanel in the editor area.
 */
export class RepositoryWindow {
  private static current: RepositoryWindow | undefined;

  static show(extensionUri: vscode.Uri, gitApi: GitApi, git: Git): void {
    if (RepositoryWindow.current) {
      RepositoryWindow.current.panel.reveal();
      return;
    }
    const root = gitApi.repositories[0]?.rootUri.fsPath;
    if (!root) {
      void vscode.window.showWarningMessage('No Git repository is open.');
      return;
    }
    RepositoryWindow.current = new RepositoryWindow(extensionUri, git, root);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private scope: string | undefined;
  private limit = pageSize();

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: Git,
    private readonly root: string
  ) {
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
  }

  private dispose(): void {
    RepositoryWindow.current = undefined;
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
    const graph = await readGraph(this.git, this.root, this.scope, this.limit);
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
<script nonce="${nonce}" src="${asset('repo.js')}"></script>
</body>
</html>`;
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
