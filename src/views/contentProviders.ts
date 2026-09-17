/**
 * The two read-only document schemes the Git Repository window opens editors
 * with. Both exist so that history can be handed to VS Code's own viewers -
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
