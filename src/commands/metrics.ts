/**
 * ASTra v3 — Quick Metrics Command
 * Shows a QuickPick summary without opening the full panel.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import { moduleSplitter } from '../splitter/core/moduleSplitter';
import { formatMinutes } from '../splitter/utils/helpers';

export function registerMetricsCommand(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('astra.showMetrics', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const doc    = editor.document;
            if (!/\.(ts|tsx|js|jsx)$/.test(doc.fileName)) return;

            const plan  = moduleSplitter.analyse(doc.getText(), path.basename(doc.fileName));
            const m     = plan.metrics;
            const s     = plan.summary;

            const items: vscode.QuickPickItem[] = [
                { label: `$(graph) Health Grade: ${m.overallHealth}`,             description: 'Overall file quality',                alwaysShow: true },
                { label: `$(list-ordered) Regions: ${plan.regions.length}`,       description: `${s.extractionCount} to extract, ${s.retainedCount} to retain`, alwaysShow: true },
                { label: `$(symbol-number) Avg CC: ${m.avgCyclomaticComplexity}`, description: 'Cyclomatic Complexity',                alwaysShow: true },
                { label: `$(symbol-number) Avg Cog CC: ${m.avgCognitiveComplexity}`, description: 'Cognitive Complexity',             alwaysShow: true },
                { label: `$(pulse) Maintainability: ${m.maintainabilityIndex}/100`, description: 'SEI Maintainability Index',         alwaysShow: true },
                { label: `$(code) Lines: ${m.totalLines} (${m.codeLines} code)`,  description: `${m.blankLines} blank, ${m.commentLines} comment`, alwaysShow: true },
                { label: `$(clock) Tech Debt: ${formatMinutes(m.technicalDebtMinutes)}`, description: 'Estimated remediation time', alwaysShow: true },
                { label: `$(warning) Smells: ${plan.codeSmells.length}`,          description: plan.codeSmells.filter(s => s.severity === 'critical').length + ' critical', alwaysShow: true },
            ];

            if (plan.circularRisks.length > 0) {
                items.push({
                    label: `$(error) Circular Risks: ${plan.circularRisks.length}`,
                    description: plan.circularRisks.slice(0, 2).join(', '),
                    alwaysShow: true,
                });
            }

            const picked = await vscode.window.showQuickPick(items, {
                title: `ASTra Metrics — ${path.basename(doc.fileName)}`,
                placeHolder: 'Select to open full analysis panel',
                canPickMany: false,
            });

            if (picked) {
                vscode.commands.executeCommand('astra.analyseFile');
            }
        })
    );
}
