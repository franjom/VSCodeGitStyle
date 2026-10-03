import * as vscode from 'vscode';
import { ChangesViewProvider } from './views/changesView';
import { Git } from './git/git';
import { createDiagnostics, registerDiagnosticsCommand } from './diagnosticsFile';
import { GitApi, whenGitApiReady } from './gitExtension';
import {
  BlobFileSystem,
  BLOB_SCHEME,
  CommitContentProvider,
  COMMIT_SCHEME,
} from './views/contentProviders';
import { RepositoryWindow } from './views/repositoryWindow';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outcome = await whenGitApiReady(context, (api) => start(context, api));
  if (outcome !== 'started') {
    void vscode.window.showWarningMessage(
      outcome === 'missing'
        ? 'VS Git Style needs the built-in Git extension to be installed and enabled.'
        : 'VS Git Style will start once Git is enabled (the git.enabled setting).'
    );
  }
}

function start(context: vscode.ExtensionContext, api: GitApi): void {
  const diagnostics = createDiagnostics(context);
  const git = new Git(api.git.path);
  const provider = new ChangesViewProvider(context.extensionUri, api, git);
  const blobs = new BlobFileSystem(git);

  context.subscriptions.push(
    registerDiagnosticsCommand(context),
    provider,
    vscode.window.registerWebviewViewProvider(ChangesViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      COMMIT_SCHEME,
      new CommitContentProvider(git)
    ),
    blobs,
    // Case-sensitive because git's paths are, whatever the disk under them is.
    vscode.workspace.registerFileSystemProvider(BLOB_SCHEME, blobs, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
    vscode.commands.registerCommand('vsGitStyle.refresh', () => provider.scheduleRefresh(0)),
    vscode.commands.registerCommand('vsGitStyle.openRepositoryWindow', () =>
      RepositoryWindow.show(
        context.extensionUri,
        api,
        git,
        provider.selectedRoot,
        undefined,
        diagnostics
      )
    ),
    vscode.commands.registerCommand('vsGitStyle.viewFileHistory', (file?: string) =>
      RepositoryWindow.show(context.extensionUri, api, git, provider.selectedRoot, file, diagnostics)
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
