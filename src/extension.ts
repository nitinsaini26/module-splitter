/**
 * ASTra v3 — Extension Entry Point
 */

import * as vscode from "vscode";
import {
  registerAnalyseCommand,
  registerApplyCommand,
  setHasPlanContext,
} from "./commands/analyse";
import { registerMetricsCommand } from "./commands/metrics";
import { AstraStatusBar } from "./statusbar/statusBar";
import { AstraDiagnosticProvider } from "./providers/diagnosticProvider";
import { regionCache } from "./splitter/cache/regionCache";

export function activate(ctx: vscode.ExtensionContext): void {
  const diagCollection = vscode.languages.createDiagnosticCollection("astra");
  const diagnosticProvider = new AstraDiagnosticProvider(diagCollection);
  const statusBar = new AstraStatusBar(ctx);

  ctx.subscriptions.push(diagCollection);

  registerAnalyseCommand(ctx, diagnosticProvider, statusBar);
  registerApplyCommand(ctx);
  registerMetricsCommand(ctx);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("astra.clearDiagnostics", () => {
      diagCollection.clear();
      vscode.window.showInformationMessage("ASTra: Diagnostics cleared.");
    }),
  );

  // Auto-run on save
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const cfg = vscode.workspace.getConfiguration("astra");
      if (!cfg.get<boolean>("showOnSave")) return;
      if (!/\.(ts|tsx|js|jsx|vue|svelte)$/.test(doc.fileName)) return;
      await vscode.commands.executeCommand("astra.analyseFile", doc.uri, {
        showPanel: false,
        showNotification: true,
        reason: "save",
      });
    }),
  );

  // Undo-aware cache invalidation
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.reason !== vscode.TextDocumentChangeReason.Undo) return;
      if (!/\.(ts|tsx|js|jsx|vue|svelte)$/.test(event.document.fileName))
        return;
      regionCache.invalidateFile(event.document.fileName);
    }),
  );

  // Status bar — update on editor switch
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      statusBar.update(editor);
    }),
  );

  statusBar.update(vscode.window.activeTextEditor);

  // Set initial context
  setHasPlanContext(false);
}

export function deactivate(): void {
  // subscriptions cleaned up automatically
}
