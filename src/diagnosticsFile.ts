/**
 * The file the diagnostics log is kept in, and the command that opens it.
 *
 * Separated from diagnostics.ts so that the recording itself stays free of both
 * vscode and the filesystem, and can be tested.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Diagnostics, MAX_LOG_BYTES, trimToLimit } from './diagnostics';

const FILE_NAME = 'diagnostics.log';

/**
 * Opens the log for appending, trimming it if the last session left it large.
 *
 * Writes are synchronous. That is the point: an OutputChannel, or a buffered
 * stream, loses exactly the records worth having when the window is killed.
 * Each line is a few hundred bytes and they are written only around operations
 * a person started, so the cost does not show.
 */
export function createDiagnostics(context: vscode.ExtensionContext): Diagnostics {
  const dir = context.globalStorageUri.fsPath;
  const file = path.join(dir, FILE_NAME);

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.writeFileSync(file, trimToLimit(fs.readFileSync(file, 'utf8'), MAX_LOG_BYTES / 2), 'utf8');
    }
  } catch {
    // Nothing here is worth failing activation over.
  }

  const diagnostics = new Diagnostics({
    write(line: string) {
      fs.appendFileSync(file, line, 'utf8');
    },
  });

  diagnostics.note('session started', {
    extension: context.extension?.packageJSON?.version ?? 'unknown',
    vscode: vscode.version,
    platform: process.platform,
  });

  return diagnostics;
}

/** Registers `VS Git Style: Open Diagnostics Log`. */
export function registerDiagnosticsCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('vsGitStyle.openDiagnostics', async () => {
    const file = path.join(context.globalStorageUri.fsPath, FILE_NAME);
    if (!fs.existsSync(file)) {
      void vscode.window.showInformationMessage('VS Git Style has not recorded anything yet.');
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: false });
  });
}
