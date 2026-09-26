import * as path from 'path';
import * as vscode from 'vscode';
import { readFileDiff } from '../git/diff';
import { Git } from '../git/git';
import { Diagnostics } from '../diagnostics';
import {
  BranchOp,
  branchArgs,
  branchMenu,
  confirmation,
  MenuEntry,
  OpContext,
} from '../git/branchOps';
import { GitApi } from '../gitExtension';
import { BLOB_SCHEME, COMMIT_SCHEME } from './contentProviders';
import {
  GraphModel,
  readCommitDetails,
  parseNameStatus,
  readGraph,
  readRefs,
  readReviewInfo,
  RefEntry,
  ReviewInfo,
  ReviewProvider,
} from '../git/graph';

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
  /**
   * Each branch's context menu, keyed by its short name.
   *
   * Built here rather than in the webview so there is one description of what
   * the menu offers, tested in branchOps.ts. Sending it with the model rather
   * than fetching it on right-click is what keeps the menu instant; it costs a
   * few tens of kilobytes beside a graph already far larger.
   */
  menus: Record<string, MenuEntry[]>;
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
  | { type: 'fileDiff'; hash: string; path: string; origPath?: string }
  | { type: 'diag'; label: string; detail?: Record<string, unknown>; failed?: boolean }
  | { type: 'branchOp'; op: BranchOp; ref: string };

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
  static show(
    extensionUri: vscode.Uri,
    gitApi: GitApi,
    git: Git,
    file?: string,
    diagnostics?: Diagnostics
  ): void {
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
    RepositoryWindow.current = new RepositoryWindow(extensionUri, gitApi, git, root, file, diagnostics);
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
  /** Branches drawn alongside the scope, from the eye toggle in the tree. */
  private extras: string[] = [];
  /** Repo-relative path when the window is showing one file's history. */
  private file: string | undefined;
  private limit = pageSize();
  private loadTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    gitApi: GitApi,
    private readonly git: Git,
    private readonly root: string,
    file?: string,
    private readonly diagnostics?: Diagnostics
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

        case 'diag':
          this.recordFromWebview(message);
          return;

        case 'branchOp':
          await this.branchOp(message);
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
    this.extras = this.extras.filter((ref) => refs.some((entry) => entry.short === ref));
    const graph = await readGraph(
      this.git,
      this.root,
      this.scope,
      this.limit,
      this.file,
      this.extras
    );
    const configured = vscode.workspace
      .getConfiguration('vsGitStyle')
      .get<ReviewProvider | 'auto'>('reviewProvider', 'auto');
    const review = await readReviewInfo(this.git, this.root, configured);

    const model: WindowModel = {
      repoName: path.basename(this.root),
      root: this.root,
      refs,
      menus: Object.fromEntries(
        refs.map((ref) => [ref.short, branchMenu(ref, refs.find((r) => r.current)?.short)])
      ),
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
    // Reading the diff and drawing it are the two places this has hung, so both
    // ends of each are recorded: a log ending in an unmatched "read" blames the
    // extension host, one ending in an unmatched "post" blames the webview.
    const read = this.diagnostics?.begin('fileDiff.read', {
      path: message.path,
      hash: message.hash.slice(0, 7),
    });
    try {
      const diff = await readFileDiff(
        this.git,
        this.root,
        message.hash,
        message.path,
        message.origPath
      );
      const spans = diff.rows.reduce(
        (total, row) => total + (row.oldSpans?.length ?? 0) + (row.newSpans?.length ?? 0),
        0
      );
      read?.({ rows: diff.rows.length, changes: diff.changes, spans, truncated: diff.truncated });

      // Left open deliberately: the webview closes it when it has drawn the
      // diff. A log ending here means the payload went out and nothing came
      // back, which is the renderer wedged rather than us.
      this.pendingRender?.({ abandoned: true });
      this.pendingRender = this.diagnostics?.begin('fileDiff.render', {
        path: message.path,
        rows: diff.rows.length,
      });
      this.post({ type: 'fileDiff', hash: message.hash, path: message.path, diff });
    } catch (err) {
      read?.({ failed: true });
      this.diagnostics?.error('fileDiff.read', err, { path: message.path });
      this.post({
        type: 'fileDiff',
        hash: message.hash,
        path: message.path,
        diff: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Closed by the webview's acknowledgement; see sendFileDiff. */
  private pendingRender: ((extra?: Record<string, unknown>) => void) | undefined;

  /**
   * What the webview reports about its own work. It is the only way to see the
   * renderer's side of a hang: nothing else in this process can observe it.
   */
  private recordFromWebview(message: Extract<Inbound, { type: 'diag' }>): void {
    if (message.label === 'fileDiff.render') {
      this.pendingRender?.(message.detail);
      this.pendingRender = undefined;
      return;
    }
    if (message.failed) {
      this.diagnostics?.error('webview.' + message.label, message.detail?.message ?? 'unknown', message.detail);
      return;
    }
    this.diagnostics?.note('webview.' + message.label, message.detail);
  }

  /**
   * Runs a branch context-menu action.
   *
   * Everything that could cost work asks first, with a wording that names both
   * branches so the direction cannot be misread; what is its own undo goes
   * straight through. The decision of which is which lives in branchOps.ts,
   * where it is tested - this only prompts and runs.
   */
  private async branchOp(message: Extract<Inbound, { type: 'branchOp' }>): Promise<void> {
    const refs = await readRefs(this.git, this.root);
    const target = refs.find((ref) => ref.short === message.ref);
    if (!target) {
      void vscode.window.showWarningMessage(`'${message.ref}' is no longer there.`);
      await this.load();
      return;
    }
    const current = refs.find((ref) => ref.current)?.short;
    const context: OpContext = { target, current };

    // The two that are the window's own business.
    if (message.op === 'viewHistory') {
      this.scope = target.short;
      this.file = undefined;
      this.limit = pageSize();
      await this.load();
      return;
    }
    if (message.op === 'toggleInHistory') {
      this.toggleExtra(target.short);
      await this.load();
      return;
    }
    if (message.op === 'compare') {
      await this.compareBranches(target.short, current);
      return;
    }
    if (message.op === 'sync') {
      await vscode.commands.executeCommand('git.sync', vscode.Uri.file(this.root));
      await this.load();
      return;
    }

    // The ones that need something typed before there is a command at all.
    if (message.op === 'createBranch' || message.op === 'rename') {
      const name = await this.askBranchName(message.op, target.short);
      if (!name) {
        return;
      }
      context.name = name;
    }
    if (message.op === 'newWorktree') {
      const path = await this.askWorktreePath(target.short);
      if (!path) {
        return;
      }
      context.path = path;
    }

    const ask = confirmation(message.op, context);
    if (ask) {
      const chosen = await vscode.window.showWarningMessage(
        ask.message,
        { modal: true, detail: ask.detail },
        ask.confirm
      );
      if (chosen !== ask.confirm) {
        return;
      }
    }

    const args = branchArgs(message.op, context);
    if (!args) {
      return;
    }

    const done = this.diagnostics?.begin('branchOp', { op: message.op, ref: target.short });
    try {
      await this.git.exec(this.root, args);
      done?.();
      await this.afterBranchOp(message.op, context);
    } catch (err) {
      done?.({ failed: true });
      await this.handleBranchOpFailure(message.op, context, err);
    }
    await this.load();
  }

  /**
   * What a successful operation leaves the window looking at.
   *
   * Checking out or renaming moves the branch the history is about, and a
   * window still showing the old name would be quietly wrong.
   */
  private async afterBranchOp(op: BranchOp, context: OpContext): Promise<void> {
    if (op === 'checkout') {
      this.scope = context.target.kind === 'remote'
        ? context.target.short.slice(context.target.short.indexOf('/') + 1)
        : context.target.short;
    }
    if (op === 'rename' && context.name) {
      if (this.scope === context.target.short) {
        this.scope = context.name;
      }
      this.extras = this.extras.map((ref) => (ref === context.target.short ? context.name! : ref));
    }
    if (op === 'delete' || op === 'deleteForce') {
      this.extras = this.extras.filter((ref) => ref !== context.target.short);
    }
    if (op === 'newWorktree' && context.path) {
      const open = await vscode.window.showInformationMessage(
        `Worktree for '${context.target.short}' created.`,
        'Open in New Window'
      );
      if (open) {
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(context.path),
          { forceNewWindow: true }
        );
      }
    }
  }

  /**
   * A failed delete is the one worth a second question: git refuses to drop a
   * branch holding work that is nowhere else, and forcing it is a different
   * decision rather than a retry.
   */
  private async handleBranchOpFailure(
    op: BranchOp,
    context: OpContext,
    err: unknown
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    if (op === 'delete' && context.target.kind !== 'remote' && /not fully merged/i.test(message)) {
      const ask = confirmation('deleteForce', context)!;
      const chosen = await vscode.window.showWarningMessage(
        ask.message,
        { modal: true, detail: ask.detail },
        ask.confirm
      );
      if (chosen === ask.confirm) {
        await this.git.exec(this.root, branchArgs('deleteForce', context)!);
      }
      return;
    }
    this.diagnostics?.error('branchOp', err, { op, ref: context.target.short });
    void vscode.window.showErrorMessage(message);
  }

  private async askBranchName(op: BranchOp, ref: string): Promise<string | undefined> {
    const creating = op === 'createBranch';
    const name = await vscode.window.showInputBox({
      title: creating ? `New branch from '${ref}'` : `Rename '${ref}'`,
      prompt: creating ? 'Name for the new branch' : 'New name for the branch',
      value: creating ? '' : ref,
      // git's own rules, checked here so the error arrives while it can still
      // be corrected rather than as a failed command afterwards.
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Enter a branch name.';
        }
        if (/[\s~^:?*[\\]/.test(trimmed) || trimmed.includes('..') || trimmed.endsWith('.lock')) {
          return 'A branch name cannot contain spaces, "..", or any of ~ ^ : ? * [ \\';
        }
        if (trimmed.startsWith('-') || trimmed.startsWith('/') || trimmed.endsWith('/')) {
          return 'A branch name cannot start with "-" or "/", or end with "/".';
        }
        return undefined;
      },
    });
    return name?.trim() || undefined;
  }

  private async askWorktreePath(ref: string): Promise<string | undefined> {
    const parent = await vscode.window.showOpenDialog({
      title: `Where should the worktree for '${ref}' go?`,
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'Create Worktree Here',
    });
    if (!parent?.length) {
      return undefined;
    }
    // A worktree needs its own directory, and git will not use one that exists.
    return path.join(parent[0]!.fsPath, ref.replace(/[\\/]/g, '-'));
  }

  /**
   * The changed files between two branches, opened as ordinary editor diffs.
   *
   * Two dots rather than three: Visual Studio's comparison is what the two
   * branches look like side by side now, not what one has done since they last
   * agreed.
   */
  private async compareBranches(ref: string, current?: string): Promise<void> {
    if (!current) {
      return;
    }
    const done = this.diagnostics?.begin('compare', { ref, current });
    const out = await this.git.exec(this.root, [
      'diff',
      '--name-status',
      '-z',
      '-M',
      `${current}..${ref}`,
    ]);
    const files = parseNameStatus(out);
    done?.({ files: files.length });

    if (!files.length) {
      void vscode.window.showInformationMessage(
        `'${ref}' and '${current}' have the same content.`
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      files.map((file) => ({
        label: file.path.split('/').pop() ?? file.path,
        description: file.status,
        detail: file.path,
        file,
      })),
      {
        title: `${files.length} file(s) differ between '${current}' and '${ref}'`,
        placeHolder: 'Pick a file to see the difference',
        matchOnDetail: true,
      }
    );
    if (!picked) {
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      this.blobUri(current, picked.file.origPath ?? picked.file.path),
      this.blobUri(ref, picked.file.path),
      `${picked.label} (${current} ↔ ${ref})`
    );
  }

  /** Adds or removes a branch from the set the graph is drawing. */
  private toggleExtra(ref: string): void {
    this.extras = this.extras.includes(ref)
      ? this.extras.filter((other) => other !== ref)
      : [...this.extras, ref];
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
<link href="${asset('shell.css')}" rel="stylesheet">
<link href="${asset('repo.css')}" rel="stylesheet">
<title>Git Repository</title>
</head>
<body>
<div id="root" class="repo-shell"></div>
<div id="menu" class="context-menu" hidden></div>
<script nonce="${nonce}" src="${asset('format.js')}"></script>
<script nonce="${nonce}" src="${asset('dom.js')}"></script>
<script nonce="${nonce}" src="${asset('virtual.js')}"></script>
<script nonce="${nonce}" src="${asset('graphview.js')}"></script>
<script nonce="${nonce}" src="${asset('diffview.js')}"></script>
<script nonce="${nonce}" src="${asset('syntax.js')}"></script>
<script nonce="${nonce}" src="${asset('repo.js')}"></script>
</body>
</html>`;
  }
}
