import * as vscode from 'vscode';

/**
 * Minimal structural typing for the bits of the built-in `vscode.git`
 * extension API we rely on. We only need repository discovery, change
 * notifications and the resolved git binary path - everything else is done by
 * shelling out (see git.ts) or by delegating to the built-in commands.
 */

export interface ApiRepositoryState {
  readonly onDidChange: vscode.Event<void>;
}

export interface ApiRepository {
  readonly rootUri: vscode.Uri;
  readonly state: ApiRepositoryState;
}

export interface GitApi {
  readonly repositories: ApiRepository[];
  readonly onDidOpenRepository: vscode.Event<ApiRepository>;
  readonly onDidCloseRepository: vscode.Event<ApiRepository>;
  readonly git: { readonly path: string };
}

export interface GitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

export async function activateGitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (!exports.enabled) {
    return undefined;
  }
  return exports.getAPI(1);
}
