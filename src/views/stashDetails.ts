/**
 * Visual Studio's Stash Details window: what the stash was made on, then the
 * files it holds as a folder tree, each opening a diff.
 *
 * A native tree view rather than a webview, because only a tree item can show
 * the theme's file icons - the C# and SQL icons the real window has - and the
 * tree virtualises its rows for nothing. The header Visual Studio draws above
 * the tree becomes the tree's first rows and the view's message.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { ChangePair, pairStatus, readStashChanges, StashChanges, stashIndexOf } from '../git/compare';
import { buildTree, FileNode, FolderNode, TreeNode } from '../git/tree';
import { BLOB_SCHEME, blobUri, openChanges } from './contentProviders';

export const STASH_DETAILS_VIEW = 'vsGitStyle.stashDetails';
const OPEN_CONTEXT = 'vsGitStyle.stashDetailsOpen';

type Item =
  | { kind: 'info'; label: string; value: string; tooltip?: string }
  | { kind: 'changes' }
  | { kind: 'folder'; node: FolderNode }
  | { kind: 'file'; node: FileNode; pair: ChangePair };

const STATUS: Record<string, { letter: string; color: string; status: 'added' | 'deleted' | 'renamed' | 'modified' }> = {
  A: { letter: 'A', color: 'gitDecoration.addedResourceForeground', status: 'added' },
  D: { letter: 'D', color: 'gitDecoration.deletedResourceForeground', status: 'deleted' },
  R: { letter: 'R', color: 'gitDecoration.renamedResourceForeground', status: 'renamed' },
  M: { letter: 'M', color: 'gitDecoration.modifiedResourceForeground', status: 'modified' },
};

interface Shown {
  root: string;
  index: number;
  stash: StashChanges;
  tree: TreeNode[];
  pairs: Map<string, ChangePair>;
}

export class StashDetails implements vscode.TreeDataProvider<Item>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;

  private readonly view: vscode.TreeView<Item>;
  private readonly disposables: vscode.Disposable[] = [];
  private shown?: Shown;

  constructor(private readonly git: Git) {
    this.view = vscode.window.createTreeView(STASH_DETAILS_VIEW, { treeDataProvider: this });
    this.disposables.push(
      this.view,
      this.changed,
      this.decorationsChanged,
      vscode.window.registerFileDecorationProvider(this),
      vscode.commands.registerCommand('vsGitStyle.showStash', (root: string, index: number) =>
        this.show(root, index)
      ),
      vscode.commands.registerCommand('vsGitStyle.stashDetails.apply', () => this.run('apply')),
      vscode.commands.registerCommand('vsGitStyle.stashDetails.pop', () => this.run('pop')),
      vscode.commands.registerCommand('vsGitStyle.stashDetails.drop', () => this.run('drop')),
      vscode.commands.registerCommand('vsGitStyle.stashDetails.openAll', () => this.openAll()),
      vscode.commands.registerCommand('vsGitStyle.stashDetails.close', () => this.close()),
      vscode.commands.registerCommand('vsGitStyle.stashDetails.openFile', (pair: ChangePair) =>
        this.openFile(pair)
      )
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  async show(root: string, index: number): Promise<void> {
    const stash = await readStashChanges(this.git, root, index);
    if (!stash) {
      throw new Error(`Stash {${index}} no longer exists.`);
    }
    const files = stash.pairs.map((pair) => ({
      path: pair.path,
      status: STATUS[pairStatus(pair)].status,
      staged: false,
    }));
    this.shown = {
      root,
      index,
      stash,
      tree: buildTree(files, path.sep),
      pairs: new Map(stash.pairs.map((pair) => [pair.path, pair])),
    };
    this.view.title = 'Stash Details';
    this.view.description = `stash@{${index}}`;
    this.view.message = stash.subject;
    this.changed.fire(undefined);
    this.decorationsChanged.fire(undefined);
    await vscode.commands.executeCommand('setContext', OPEN_CONTEXT, true);
    await vscode.commands.executeCommand(`${STASH_DETAILS_VIEW}.focus`);
  }

  private async close(): Promise<void> {
    this.shown = undefined;
    this.view.message = undefined;
    this.view.description = undefined;
    this.changed.fire(undefined);
    await vscode.commands.executeCommand('setContext', OPEN_CONTEXT, false);
  }

  getChildren(item?: Item): Item[] {
    const shown = this.shown;
    if (!shown) {
      return [];
    }
    if (!item) {
      const { stash, index } = shown;
      const created = new Date(stash.created);
      return [
        {
          kind: 'info',
          label: 'Created date:',
          value: isNaN(created.getTime()) ? stash.created : created.toLocaleString(),
        },
        { kind: 'info', label: 'Stash revision:', value: `stash@{${index}}`, tooltip: stash.hash },
        { kind: 'info', label: 'Based on:', value: stash.base.slice(0, 8), tooltip: stash.base },
        { kind: 'changes' },
      ];
    }
    const nodes =
      item.kind === 'changes' ? shown.tree : item.kind === 'folder' ? item.node.children : [];
    return nodes.map((node): Item =>
      node.kind === 'folder'
        ? { kind: 'folder', node }
        : { kind: 'file', node, pair: shown.pairs.get(node.change.path)! }
    );
  }

  getTreeItem(item: Item): vscode.TreeItem {
    const shown = this.shown!;
    // Ids carry the stash's hash so one stash's expanded folders are not
    // carried over to the next stash opened.
    const id = (key: string) => `${shown.stash.hash}:${key}`;
    switch (item.kind) {
      case 'info': {
        const tree = new vscode.TreeItem(item.label);
        tree.id = id(`info:${item.label}`);
        tree.description = item.value;
        tree.tooltip = item.tooltip ?? item.value;
        return tree;
      }
      case 'changes': {
        const tree = new vscode.TreeItem(
          `Changes (${shown.stash.pairs.length})`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        tree.id = id('changes');
        tree.contextValue = 'stashChanges';
        return tree;
      }
      case 'folder': {
        const tree = new vscode.TreeItem(item.node.label, vscode.TreeItemCollapsibleState.Expanded);
        tree.id = id(`folder:${item.node.key}`);
        tree.iconPath = vscode.ThemeIcon.Folder;
        // Gives the icon theme a folder name to pick its icon by.
        tree.resourceUri = vscode.Uri.file(path.join(shown.root, item.node.key)).with({
          scheme: BLOB_SCHEME,
        });
        tree.tooltip = item.node.key.split('/').join(path.sep);
        return tree;
      }
      case 'file': {
        const tree = new vscode.TreeItem(item.node.label);
        tree.id = id(`file:${item.node.key}`);
        tree.iconPath = vscode.ThemeIcon.File;
        tree.resourceUri = this.decoratedUri(shown, item.pair);
        tree.tooltip = item.pair.path.split('/').join(path.sep);
        tree.command = {
          command: 'vsGitStyle.stashDetails.openFile',
          title: 'Open Changes',
          arguments: [item.pair],
        };
        return tree;
      }
    }
  }

  /**
   * The status letter Visual Studio puts at the end of a file's row. A file
   * decoration is the only way a tree item gets one right-aligned and coloured,
   * and the provider only answers URIs carrying `stashStatus`, which nothing
   * but this tree builds - so diff editors opened on the same blobs stay plain.
   */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== BLOB_SCHEME) {
      return undefined;
    }
    const status = STATUS[new URLSearchParams(uri.query).get('stashStatus') ?? ''];
    return status && new vscode.FileDecoration(status.letter, undefined, new vscode.ThemeColor(status.color));
  }

  private decoratedUri(shown: Shown, pair: ChangePair): vscode.Uri {
    const uri = vscode.Uri.file(path.join(shown.root, pair.path)).with({ scheme: BLOB_SCHEME });
    return uri.with({
      query: new URLSearchParams({ stash: shown.stash.hash, stashStatus: pairStatus(pair) }).toString(),
    });
  }

  private async openFile(pair: ChangePair): Promise<void> {
    const shown = this.shown;
    if (!shown) {
      return;
    }
    const { root, stash } = shown;
    // A missing side - the stash added or deleted the file - reads back empty
    // from the blob provider, which a single diff shows as all added or all
    // removed.
    const left = pair.left ?? { rev: stash.base, path: pair.path };
    const right = pair.right ?? { rev: stash.hash, path: pair.path };
    const name = pair.path.split('/').pop() ?? pair.path;
    await vscode.commands.executeCommand(
      'vscode.diff',
      blobUri(root, left.rev, left.path),
      blobUri(root, right.rev, right.path),
      `${name} (stash@{${shown.index}})`,
      { preview: true }
    );
  }

  private async openAll(): Promise<void> {
    const shown = this.shown;
    if (shown) {
      await openChanges(shown.root, `stash@{${shown.index}}: ${shown.stash.subject}`, shown.stash.pairs);
    }
  }

  private async run(op: 'apply' | 'pop' | 'drop'): Promise<void> {
    const shown = this.shown;
    if (!shown) {
      return;
    }
    try {
      const index = await stashIndexOf(this.git, shown.root, shown.stash.hash);
      if (index === undefined) {
        await this.close();
        throw new Error('This stash no longer exists.');
      }
      if (op === 'drop') {
        const answer = await vscode.window.showWarningMessage(
          `Drop stash {${index}}? This cannot be undone.`,
          { modal: true },
          'Drop'
        );
        if (answer !== 'Drop') {
          return;
        }
      }
      await (op === 'apply'
        ? this.git.stashApply(shown.root, index)
        : op === 'pop'
          ? this.git.stashPop(shown.root, index)
          : this.git.stashDrop(shown.root, index));
      if (op !== 'apply') {
        await this.close();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      await vscode.commands.executeCommand('vsGitStyle.refresh');
    }
  }
}
