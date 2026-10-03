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

/**
 * Calls `start` with the git API as soon as there is one: at once if git is
 * enabled, otherwise the moment `git.enabled` is switched on. Without the wait
 * a session that started with git off stayed inert until the window was
 * reloaded, however long git had been back on.
 *
 * Resolves to what happened, so the caller can say why nothing is showing yet.
 */
export async function whenGitApiReady(
  context: vscode.ExtensionContext,
  start: (api: GitApi) => void
): Promise<'started' | 'waiting' | 'missing'> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) {
    return 'missing';
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (exports.enabled) {
    start(exports.getAPI(1));
    return 'started';
  }
  const waiting = exports.onDidChangeEnablement((enabled) => {
    if (enabled) {
      // Disposed before starting, so switching git off and on again later
      // cannot start everything a second time.
      waiting.dispose();
      start(exports.getAPI(1));
    }
  });
  context.subscriptions.push(waiting);
  return 'waiting';
}
