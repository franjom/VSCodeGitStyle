/**
 * The two read-only document schemes the Git Repository window opens editors
 * with - one a file system, so file content reaches VS Code as bytes, and one a
 * content provider for the patch text git itself writes. Both exist so that history can be handed to VS Code's own viewers -
 * `vscode.diff` and an ordinary editor tab - rather than reimplemented.
 *
 * They are registered once in extension.ts and are otherwise addressed only
 * through the URIs built here.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { ChangePair, Side } from '../git/compare';

export const COMMIT_SCHEME = 'vsgitstyle-commit';
export const BLOB_SCHEME = 'vsgitstyle-blob';

/**
 * One file at one revision. The path is the file's own on disk, as the
 * built-in `git:` scheme's is, and the revision lives only in the query.
 *
 * The changes editor calls an entry renamed whenever its two sides' paths
 * differ (`modifiedUri.path!==originalUri.path`, VS Code 1.140's bundle), so a
 * revision in the path made every file in a comparison an "R" with a hash for
 * a folder. With the real path, the resourceLabelFormatter in package.json
 * lets the label service show it relative to the workspace folder it is in.
 */
export function blobUri(root: string, rev: string, filePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BLOB_SCHEME,
    path: vscode.Uri.file(path.join(root, filePath)).path,
    query: new URLSearchParams({ root, rev, path: filePath }).toString(),
  });
}

/**
 * Opens every changed file at once in VS Code's multi-file changes editor,
 * which is how Visual Studio presents a comparison: the whole set, scrolled
 * through, rather than a list to pick from one file at a time. It renders
 * only the files in view, so a large comparison costs what is on screen.
 *
 * Each entry's first URI names the file in the working tree: the editor
 * labels the entry and picks its icon from it, while the two blob URIs are
 * what is compared.
 */
export async function openChanges(root: string, title: string, pairs: ChangePair[]): Promise<void> {
  const side = (s: Side | undefined) => (s ? blobUri(root, s.rev, s.path) : undefined);
  await vscode.commands.executeCommand(
    'vscode.changes',
    title,
    pairs.map((pair) => [vscode.Uri.file(path.join(root, pair.path)), side(pair.left), side(pair.right)])
  );
}

/**
 * Backs the `vsgitstyle-blob:` scheme, so one file at one revision can be shown
 * as a read-only document and fed to `vscode.diff`.
 *
 * A read-only file system rather than a TextDocumentContentProvider, because a
 * content provider has to hand VS Code a string - so the decoding was ours, and
 * it was UTF-8 whatever the file had been saved in. A Windows-1250 or UTF-16
 * file then disagreed with its own copy on disk on every line. Given bytes,
 * VS Code decodes the way it decodes the file on disk (files.encoding, a BOM,
 * autoGuessEncoding) and recognises a binary file rather than showing it as
 * text. The built-in git extension serves its `git:` scheme the same way.
 *
 * Every address names a commit, never a name that moves (Git.resolveCommit),
 * so the content of one never changes and nothing is ever announced on
 * onDidChangeFile.
 */
export class BlobFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  constructor(private readonly git: Git) {}

  dispose(): void {
    this.changes.dispose();
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const blob = parseBlobUri(uri);
    const size = blob
      ? Number(
          (await this.git.exec(blob.root, ['cat-file', '-s', blob.spec]).catch(() => '0')).trim()
        ) || 0
      : 0;
    // A blob has no time of its own, and with immutable content none is needed.
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const blob = parseBlobUri(uri);
    if (!blob) {
      return new Uint8Array();
    }
    try {
      return await this.git.execBytes(blob.root, ['cat-file', 'blob', blob.spec]);
    } catch {
      // The path does not exist at that revision, or the revision does not
      // exist at all (the root commit's parent). An empty side is correct.
      return new Uint8Array();
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }
}

function parseBlobUri(uri: vscode.Uri): { root: string; spec: string } | undefined {
  const params = new URLSearchParams(uri.query);
  const root = params.get('root');
  const rev = params.get('rev');
  const filePath = params.get('path');
  return root && rev && filePath ? { root, spec: `${rev}:${filePath}` } : undefined;
}

/**
 * Backs the `vsgitstyle-commit:` scheme, so a commit opens as an ordinary
 * read-only diff document.
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
      return await this.git.exec(root, ['show', '--stat', '--patch', '--no-color', hash]);
    } catch (err) {
      // Shown in the editor that was opened for it: better a visible reason
      // than a blank tab.
      return err instanceof Error ? err.message : String(err);
    }
  }
}
