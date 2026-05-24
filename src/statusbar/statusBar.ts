/**
 * ASTra v3 — Status Bar
 * Shows live health grade, MI, and CC for the active file.
 */

import * as vscode from "vscode";
import * as path from "path";
import { moduleSplitter } from "../splitter/core/moduleSplitter";

import type { SplitPlan } from "../splitter/types";

export class AstraStatusBar {
  private readonly item: vscode.StatusBarItem;
  private busy = false;
  private lastText = "";
  private lastTooltip: string | vscode.MarkdownString | undefined;
  private lastBackground?: vscode.ThemeColor;

  constructor(ctx: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.item.command = "astra.analyseFile";
    this.item.tooltip = "ASTra: Click to analyse & split this module";
    this.item.name = "ASTra Health";
    ctx.subscriptions.push(this.item);
  }

  beginProgress(label: string): void {
    if (this.busy) return;
    this.busy = true;
    this.lastText = this.item.text;
    this.lastTooltip = this.item.tooltip;
    this.lastBackground = this.item.backgroundColor as
      | vscode.ThemeColor
      | undefined;
    this.item.text = `$(sync~spin) ${label}`;
    this.item.tooltip = "ASTra: Analysis running…";
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  endProgress(): void {
    if (!this.busy) return;
    this.busy = false;
    this.item.text = this.lastText;
    this.item.tooltip = this.lastTooltip;
    this.item.backgroundColor = this.lastBackground;
  }

  /** Called when active editor changes — runs a quick analysis */
  update(editor: vscode.TextEditor | undefined): void {
    const cfg = vscode.workspace.getConfiguration("astra");
    if (!cfg.get<boolean>("statusBarEnabled")) {
      this.item.hide();
      return;
    }

    if (!editor || !/\.(ts|tsx|js|jsx)$/.test(editor.document.fileName)) {
      this.item.hide();
      return;
    }

    try {
      const source = editor.document.getText();
      if (source.trim().length === 0) {
        this.item.hide();
        return;
      }

      const plan = moduleSplitter.analyse(
        source,
        path.basename(editor.document.fileName),
      );
      this._render(plan);
    } catch {
      this.item.hide();
    }
  }

  /** Called after a full analysis — updates from existing plan */
  updateFromPlan(doc: vscode.TextDocument, plan: SplitPlan): void {
    const cfg = vscode.workspace.getConfiguration("astra");
    if (!cfg.get<boolean>("statusBarEnabled")) {
      this.item.hide();
      return;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(doc.fileName)) {
      this.item.hide();
      return;
    }
    this._render(plan);
  }

  private _render(plan: SplitPlan): void {
    const m = plan.metrics;
    const grade = m.overallHealth;
    const hasCI = plan.circularRisks.length > 0;
    const hasCR = plan.codeSmells.some((s) => s.severity === "critical");

    this.item.text = `$(split-horizontal) ${grade}  MI ${m.maintainabilityIndex}`;

    if (hasCI) {
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
      this.item.tooltip = `ASTra: Grade ${grade} · Circular dependency detected!`;
    } else if (hasCR || grade === "F" || grade === "D") {
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      this.item.tooltip = `ASTra: Grade ${grade} · ${plan.codeSmells.filter((s) => s.severity === "critical").length} critical smell(s)`;
    } else {
      this.item.backgroundColor = undefined;
      this.item.tooltip = `ASTra: Grade ${grade} · MI ${m.maintainabilityIndex}/100 · CC ${m.avgCyclomaticComplexity} · Click to split`;
    }

    this.item.show();
  }
}
