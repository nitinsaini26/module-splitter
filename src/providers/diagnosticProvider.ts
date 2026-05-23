/**
 * ASTra v3 — Diagnostic Provider
 * Publishes code smell diagnostics as inline VS Code squiggles.
 */

import * as vscode from 'vscode';
import type { SplitPlan, Severity } from '../splitter/types';

export class AstraDiagnosticProvider {
    constructor(private readonly collection: vscode.DiagnosticCollection) {}

    publish(uri: vscode.Uri, plan: SplitPlan): void {
        const cfg = vscode.workspace.getConfiguration('astra');
        if (!cfg.get<boolean>('showInlineSmells')) {
            this.collection.delete(uri);
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];

        for (const smell of plan.codeSmells) {
            const regionId = smell.affectedRegionIds[0];
            const region   = plan.regions.find(r => r.id === regionId);
            if (!region) continue;

            const startLine = Math.max(0, region.startLine - 1);
            const endLine   = Math.max(0, region.endLine   - 1);

            const range = new vscode.Range(
                new vscode.Position(startLine, 0),
                new vscode.Position(endLine,   Number.MAX_SAFE_INTEGER)
            );

            const diag = new vscode.Diagnostic(
                range,
                `[ASTra] ${smell.name}: ${smell.recommendation}`,
                this._severity(smell.severity)
            );

            diag.source = 'ASTra';
            diag.code   = { value: smell.name, target: vscode.Uri.parse('https://github.com/NK2552003/astra-extension') };

            // Tag auto-fixable smells as "unnecessary" so VS Code shows the lightbulb
            if (smell.autoFixable) {
                diag.tags = [vscode.DiagnosticTag.Unnecessary];
            }

            diagnostics.push(diag);
        }

        this.collection.set(uri, diagnostics);
    }

    clear(uri?: vscode.Uri): void {
        if (uri) this.collection.delete(uri);
        else     this.collection.clear();
    }

    private _severity(s: Severity): vscode.DiagnosticSeverity {
        switch (s) {
            case 'critical':
            case 'high':   return vscode.DiagnosticSeverity.Error;
            case 'medium': return vscode.DiagnosticSeverity.Warning;
            default:       return vscode.DiagnosticSeverity.Information;
        }
    }
}
