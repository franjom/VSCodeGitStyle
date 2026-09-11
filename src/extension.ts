import * as vscode from 'vscode';
import { ChangesViewProvider } from './changesView';
import { Git } from './git';
import { activateGitApi } from './gitExtension';
import {
  BlobContentProvider,
  BLOB_SCHEME,
  CommitContentProvider,
  COMMIT_SCHEME,
  RepositoryWindow,
} from './repositoryWindow';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const api = await activateGitApi();
  if (!api) {
    void vscode.window.showWarningMessage(
      'VS Git Style needs the built-in Git extension to be installed and enabled.'
    );
    return;
  }

  const git = new Git(api.git.path);
  const provider = new ChangesViewProvider(context.extensionUri, api, git);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(ChangesViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      COMMIT_SCHEME,
      new CommitContentProvider(git)
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      BLOB_SCHEME,
      new BlobContentProvider(git)
    ),
    vscode.commands.registerCommand('vsGitStyle.refresh', () => provider.scheduleRefresh(0)),
    vscode.commands.registerCommand('vsGitStyle.openRepositoryWindow', () =>
      RepositoryWindow.show(context.extensionUri, api, git)
    )
  );

  // The built-in git extension only fires state changes for things it notices;
  // a save or an external git command outside the workspace still needs a nudge.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => provider.scheduleRefresh()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        provider.scheduleRefresh(300);
      }
    })
  );
}

export function deactivate(): void {
  /* nothing to tear down beyond context.subscriptions */
}
