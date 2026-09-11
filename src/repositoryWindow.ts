import * as vscode from 'vscode';

/**
 * PLACEHOLDER - phase 2.
 *
 * This is where the full "Git Repository" window (Visual Studio's commit graph
 * screen) will live: a WebviewPanel in the editor area with
 *
 *   - a left pane of Branches / Tags / Remotes / Pull Requests,
 *   - "Incoming" and "Local History (n Outgoing)" group headers,
 *   - a commit graph rendered as SVG lanes computed from
 *     `git log --all --format=%H|%P|%an|%ad|%s`,
 *   - Message / Author / Date / ID columns and a history filter box.
 *
 * Nothing here is wired up yet; the command exists so the "View all commits"
 * link in the Git Changes view already has a real target to call.
 */
export async function openRepositoryWindow(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'The Git Repository window is not implemented yet. Open the built-in Source Control Graph instead?',
    'Open Source Control Graph',
    'Dismiss'
  );
  if (choice === 'Open Source Control Graph') {
    try {
      await vscode.commands.executeCommand('git.viewHistory');
    } catch {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }
}
