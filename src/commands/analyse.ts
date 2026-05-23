/**
 * ASTra v3 — Analyse & Apply Commands
 *
 * Key fixes over previous version:
 *   1. `astra.analyseFile` accepts an optional `uri` argument (passed by
 *      Explorer right-click). When no active editor exists, the file is opened
 *      first then analysed — so the command works from the Explorer tree.
 *   2. `astra.applySplit` remembers which document was analysed and always
 *      applies to that document, not whatever is currently active.
 *   3. The webview "Apply" postMessage is handled here and routes straight
 *      to the executor without requiring an active editor focus.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as ts from "typescript";
import { moduleSplitter } from "../splitter/core/moduleSplitter";
import { renderSplitPlanHtml } from "../splitter/core/webviewRenderer";
import { workspaceGraphBuilder } from "../splitter/workspace/workspaceGraph";
import { refactoringExecutor } from "../refactor/refactoringExecutor";
import type {
  SplitPlan,
  WorkspaceContext,
  TsConfigInfo,
} from "../splitter/types";
import type { AstraDiagnosticProvider } from "../providers/diagnosticProvider";
import type { AstraStatusBar } from "../statusbar/statusBar";

// ─── Module-level state ───────────────────────────────────────────────────────
let _panel: vscode.WebviewPanel | undefined;
let _plan: SplitPlan | undefined;
/** The document that was last analysed — Apply always targets this. */
let _sourceDoc: vscode.TextDocument | undefined;
let _ctx: vscode.ExtensionContext;

/** Set the `astraHasPlan` context key — controls when Apply keybinding is active */
export function setHasPlanContext(value: boolean): void {
  vscode.commands.executeCommand("setContext", "astraHasPlan", value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Register: analyse
// ─────────────────────────────────────────────────────────────────────────────

export function registerAnalyseCommand(
  ctx: vscode.ExtensionContext,
  diag: AstraDiagnosticProvider,
  sb: AstraStatusBar,
): void {
  _ctx = ctx;

  ctx.subscriptions.push(
    // The command can be invoked three ways:
    //   a) Command Palette / keybinding  → uri is undefined
    //   b) Editor title button           → uri is undefined (active editor is set)
    //   c) Explorer context menu         → uri is the clicked file's Uri
    vscode.commands.registerCommand(
      "astra.analyseFile",
      async (uri?: vscode.Uri) => {
        // ── Resolve the document to analyse ──────────────────────────────
        let doc: vscode.TextDocument | undefined;

        if (uri) {
          // Opened from Explorer right-click — uri is the file path
          try {
            doc = await vscode.workspace.openTextDocument(uri);
            // Show the file in editor so the user can see it,
            // but preserve focus on wherever it was
            await vscode.window.showTextDocument(doc, {
              preview: true,
              preserveFocus: true,
            });
          } catch (e) {
            vscode.window.showErrorMessage(
              `ASTra: Cannot open file — ${String(e)}`,
            );
            return;
          }
        } else {
          // No uri argument — use the active editor
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            vscode.window.showWarningMessage(
              "ASTra: No file selected. Right-click a file in Explorer or open one in the editor.",
            );
            return;
          }
          doc = editor.document;
        }

        // ── Validate extension ────────────────────────────────────────────
        if (!/\.(ts|tsx|js|jsx|vue|svelte)$/.test(doc.fileName)) {
          vscode.window.showWarningMessage(
            "ASTra: Supported file types: .ts  .tsx  .js  .jsx  .vue  .svelte",
          );
          return;
        }

        const fileName = path.basename(doc.fileName);
        _sourceDoc = doc; // remember for Apply

        // ── Run analysis pipeline ─────────────────────────────────────────
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `ASTra: Analysing ${fileName}`,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ increment: 10, message: "Parsing AST…" });
            const source = doc!.getText();
            const wsCtx = await buildWorkspaceContext(doc!.fileName);
            const userThresh =
              vscode.workspace
                .getConfiguration("astra")
                .get<number>("extractionThreshold") ?? 0.35;

            progress.report({
              increment: 25,
              message: "Building workspace graph…",
            });
            const wsFolder =
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
            const allFiles = await vscode.workspace.findFiles(
              "**/*.{ts,tsx,js,jsx}",
              "{**/node_modules/**,**/dist/**,**/out/**}",
              800,
            );
            const wsGraph = await workspaceGraphBuilder.build(
              wsFolder,
              allFiles.map((u) => u.fsPath),
            );

            progress.report({
              increment: 55,
              message: "Computing metrics & smells…",
            });
            _plan = moduleSplitter.analyse(
              source,
              fileName,
              wsCtx,
              userThresh,
              doc!.fileName,
              wsGraph,
            );

            progress.report({
              increment: 80,
              message: "Publishing diagnostics…",
            });
            diag.publish(doc!.uri, _plan);
            sb.updateFromPlan(doc!, _plan);

            progress.report({ increment: 95, message: "Rendering panel…" });

            // Set context key so the Apply keybinding activates
            setHasPlanContext(_plan.proposedFiles.length > 0);

            const cfg = vscode.workspace.getConfiguration("astra");
            if (
              cfg.get<boolean>("autoApply") &&
              _plan.proposedFiles.length > 0
            ) {
              const result = await refactoringExecutor.apply(_plan, doc!);
              workspaceGraphBuilder.invalidate();
              refactoringExecutor.showResult(result);
            } else {
              _showPanel(_plan);
            }

            progress.report({ increment: 100 });
          },
        );
      },
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Register: apply
// ─────────────────────────────────────────────────────────────────────────────

export function registerApplyCommand(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("astra.applySplit", async () => {
      await _doApply();
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: perform the apply operation
// Used both by the registered command AND by the webview postMessage handler
// ─────────────────────────────────────────────────────────────────────────────

async function _doApply(): Promise<void> {
  if (!_plan || !_sourceDoc) {
    vscode.window.showWarningMessage(
      'ASTra: Run "Analyse & Split This Module" on a file first.',
    );
    return;
  }

  if (_plan.proposedFiles.length === 0) {
    vscode.window.showInformationMessage(
      "ASTra: Nothing to extract — this file is already well-structured.",
    );
    return;
  }

  // Confirm with the user
  const fileWord = _plan.proposedFiles.length === 1 ? "file" : "files";
  const answer = await vscode.window.showWarningMessage(
    `ASTra: Create ${_plan.proposedFiles.length} ${fileWord} and update ` +
      `${path.basename(_sourceDoc.fileName)}?\n` +
      `This is a single undo step — Ctrl+Z reverts everything.`,
    { modal: true },
    "Apply",
    "Cancel",
  );
  if (answer !== "Apply") return;

  // Execute atomically
  const result = await refactoringExecutor.apply(_plan, _sourceDoc);

  // Refresh workspace graph so the next analysis picks up new files
  workspaceGraphBuilder.invalidate();

  refactoringExecutor.showResult(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: show / reuse the webview panel
// ─────────────────────────────────────────────────────────────────────────────

function _showPanel(plan: SplitPlan): void {
  const title = `ASTra — ${path.basename(plan.sourceFile)}`;

  if (_panel) {
    _panel.title = title;
    _panel.webview.html = renderSplitPlanHtml(plan);
    _panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  _panel = vscode.window.createWebviewPanel(
    "astraPanel",
    title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  _panel.webview.html = renderSplitPlanHtml(plan);

  // Handle the "Apply" button click inside the webview
  _panel.webview.onDidReceiveMessage(
    async (msg: { command: string }) => {
      if (msg.command === "apply") {
        await _doApply();
      }
    },
    undefined,
    _ctx.subscriptions,
  );

  _panel.onDidDispose(
    () => {
      _panel = undefined;
    },
    null,
    _ctx.subscriptions,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace context helpers
// ─────────────────────────────────────────────────────────────────────────────

async function buildWorkspaceContext(
  filePath: string,
): Promise<Partial<WorkspaceContext>> {
  const cfg = vscode.workspace.getConfiguration("astra");
  const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  const [typeFiles, hookFiles, utilFiles, indexFiles, testFiles] =
    await Promise.all([
      _findFiles("**/{types,interfaces,global.d}.ts", 30),
      _findFiles("**/use*.{ts,tsx}", 30),
      _findFiles("**/utils/**/*.ts", 30),
      _findFiles("**/index.ts", 30),
      _findFiles("**/*.{test,spec}.{ts,tsx}", 50),
    ]);

  // Test framework
  let testFramework: "jest" | "vitest" | "unknown" = "unknown";
  const setting = cfg.get<string>("testFramework");
  if (setting === "jest") testFramework = "jest";
  else if (setting === "vitest") testFramework = "vitest";
  else {
    try {
      const raw = fs.readFileSync(path.join(wsFolder, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = {
        ...((pkg.dependencies as Record<string, unknown>) ?? {}),
        ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
      };
      if (deps.vitest) testFramework = "vitest";
      else if (deps.jest || deps["ts-jest"]) testFramework = "jest";
    } catch {
      /* ignore — no package.json */
    }
  }

  // Package manager
  let pm: "npm" | "yarn" | "pnpm" | "unknown" = "unknown";
  if (fs.existsSync(path.join(wsFolder, "pnpm-lock.yaml"))) pm = "pnpm";
  else if (fs.existsSync(path.join(wsFolder, "yarn.lock"))) pm = "yarn";
  else if (fs.existsSync(path.join(wsFolder, "package-lock.json"))) pm = "npm";

  // Optional types file override
  const typesOverride = cfg.get<string>("typesFile");
  if (typesOverride) typeFiles.unshift(path.join(wsFolder, typesOverride));

  const tsConfig = loadNearestTsConfig(filePath, wsFolder);

  return {
    existingTypeFiles: typeFiles,
    existingHookFiles: hookFiles,
    existingUtilFiles: utilFiles,
    existingIndexFiles: indexFiles,
    existingTestFiles: testFiles,
    sourceDir: path.dirname(filePath),
    testFramework,
    packageManager: pm,
    isMonorepo:
      fs.existsSync(path.join(wsFolder, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(wsFolder, "lerna.json")) ||
      fs.existsSync(path.join(wsFolder, "nx.json")),
    tsConfig,
  };
}

function loadNearestTsConfig(
  filePath: string,
  workspaceRoot: string,
): TsConfigInfo | undefined {
  const startDir = path.dirname(filePath);
  const configPath = ts.findConfigFile(
    startDir,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) return undefined;

  if (
    workspaceRoot &&
    !path.resolve(configPath).startsWith(path.resolve(workspaceRoot))
  ) {
    return undefined;
  }

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error || !config) return undefined;

  const parsed = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    path.dirname(configPath),
  );

  const baseUrlRaw = parsed.options.baseUrl;
  const baseUrl = baseUrlRaw
    ? path.isAbsolute(baseUrlRaw)
      ? baseUrlRaw
      : path.resolve(path.dirname(configPath), baseUrlRaw)
    : path.dirname(configPath);

  const paths = parsed.options.paths as Record<string, string[]> | undefined;

  return {
    configFilePath: configPath,
    baseUrl,
    paths,
    compilerOptions: parsed.options as Record<string, unknown>,
  };
}

async function _findFiles(pattern: string, max: number): Promise<string[]> {
  const ignore =
    vscode.workspace
      .getConfiguration("astra")
      .get<string[]>("ignorePatterns") ?? [];
  const uris = await vscode.workspace.findFiles(
    pattern,
    `{${ignore.join(",")},**/node_modules/**}`,
    max,
  );
  return uris.map((u) => u.fsPath);
}
