/**
 * The two read-only document schemes the Git Repository window opens editors
 * with - one a file system, so file content reaches VS Code as bytes, and one a
 * content provider for the patch text git itself writes. Both exist so that history can be handed to VS Code's own viewers -
 * `vscode.diff` and an ordinary editor tab - rather than reimplemented.
 *
 * They are registered once in extension.ts and are otherwise addressed only
 * through the URIs the window builds.
 */

import * as vscode from 'vscode';
import { Git } from '../git/git';

export const COMMIT_SCHEME = 'vsgitstyle-commit';
export const BLOB_SCHEME = 'vsgitstyle-blob';

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
