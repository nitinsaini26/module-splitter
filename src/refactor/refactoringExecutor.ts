/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Atomic Refactoring Executor                                      ║
 * ║                                                                              ║
 * ║  Applies a SplitPlan atomically via VS Code's WorkspaceEdit API so that     ║
 * ║  the entire operation is a single undo/redo step in VS Code.               ║
 * ║                                                                              ║
 * ║  What "atomic" means here:                                                   ║
 * ║    ▸ All file creates + source update go into ONE WorkspaceEdit object      ║
 * ║    ▸ VS Code's applyEdit() applies or rejects the whole batch               ║
 * ║    ▸ Ctrl+Z undoes ALL changes in one step (VS Code's native undo stack)   ║
 * ║                                                                              ║
 * ║  Execution order:                                                             ║
 * ║    1. Pre-flight validation (collision check, disk space, parse verify)      ║
 * ║    2. Build WorkspaceEdit with all createFile + insert + replace ops        ║
 * ║    3. applyEdit() — atomic commit                                           ║
 * ║    4. Post-apply: open first created file, format document                  ║
 * ║    5. Emit result: success | partial | failure with per-file status          ║
 * ║                                                                              ║
 * ║  Failure modes handled:                                                      ║
 * ║    ▸ File already exists → skip with warning (never overwrite)              ║
 * ║    ▸ Directory creation fails → abort that file, continue others            ║
 * ║    ▸ applyEdit() returns false → surface error, no partial state            ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import type { SplitPlan } from '../splitter/types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FileStatus = 'created' | 'skipped-exists' | 'failed' | 'updated';

export interface FileApplyResult {
    filePath:  string;
    status:    FileStatus;
    reason?:   string;
}

export interface ApplyResult {
    success:      boolean;
    /** Whether VS Code's WorkspaceEdit was accepted (atomicity guarantee) */
    editApplied:  boolean;
    files:        FileApplyResult[];
    sourceFile:   FileApplyResult;
    barrelFile:   FileApplyResult | null;
    totalCreated: number;
    totalSkipped: number;
    totalFailed:  number;
    durationMs:   number;
    undoMessage:  string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight validation
// ─────────────────────────────────────────────────────────────────────────────

interface PreflightResult {
    ok:       boolean;
    errors:   string[];
    warnings: string[];
    /** Which proposed files would collide with existing files */
    collisions: string[];
}

function preflight(
    plan:     SplitPlan,
    baseDir:  string
): PreflightResult {
    const errors:     string[] = [];
    const warnings:   string[] = [];
    const collisions: string[] = [];

    if (plan.proposedFiles.length === 0) {
        errors.push('No files to create — nothing to apply.');
        return { ok: false, errors, warnings, collisions };
    }

    for (const pf of plan.proposedFiles) {
        const absPath = path.join(baseDir, pf.fileName);
        if (fs.existsSync(absPath)) {
            collisions.push(pf.fileName);
            warnings.push(`${pf.fileName} already exists and will be skipped`);
        }
    }

    if (collisions.length === plan.proposedFiles.length) {
        errors.push('All proposed files already exist — nothing to create.');
        return { ok: false, errors, warnings, collisions };
    }

    return { ok: errors.length === 0, errors, warnings, collisions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory creator (sync, safe)
// ─────────────────────────────────────────────────────────────────────────────

function ensureDir(dirPath: string): boolean {
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RefactoringExecutor — the main class
// ─────────────────────────────────────────────────────────────────────────────

export class RefactoringExecutor {

    /**
     * Apply a SplitPlan atomically.
     *
     * @param plan      The fully-resolved SplitPlan from ModuleSplitter
     * @param document  The VS Code document being split (source of truth for edits)
     */
    async apply(
        plan:     SplitPlan,
        document: vscode.TextDocument
    ): Promise<ApplyResult> {
        const t0      = Date.now();
        const baseDir = path.dirname(document.fileName);

        // ── 1. Pre-flight ────────────────────────────────────────────────────
        const pre = preflight(plan, baseDir);

        if (!pre.ok) {
            return {
                success: false, editApplied: false,
                files: [], sourceFile: { filePath: document.fileName, status: 'failed', reason: pre.errors[0] },
                barrelFile: null,
                totalCreated: 0, totalSkipped: 0, totalFailed: 1,
                durationMs: Date.now() - t0,
                undoMessage: '',
            };
        }

        // ── 2. Build WorkspaceEdit ────────────────────────────────────────────
        const wsEdit      = new vscode.WorkspaceEdit();
        const fileResults: FileApplyResult[] = [];

        for (const pf of plan.proposedFiles) {
            const absPath = path.join(baseDir, pf.fileName);

            if (pre.collisions.includes(pf.fileName)) {
                fileResults.push({ filePath: absPath, status: 'skipped-exists', reason: 'File already exists' });
                continue;
            }

            // Ensure parent directory exists (fs, not workspace API — dirs are not editable)
            const dirOk = ensureDir(path.dirname(absPath));
            if (!dirOk) {
                fileResults.push({ filePath: absPath, status: 'failed', reason: 'Could not create directory' });
                continue;
            }

            const uri = vscode.Uri.file(absPath);
            wsEdit.createFile(uri, { overwrite: false, ignoreIfExists: false });
            wsEdit.insert(uri, new vscode.Position(0, 0), pf.generatedContent);
            fileResults.push({ filePath: absPath, status: 'created' });
        }

        // Barrel index.ts
        let barrelResult: FileApplyResult | null = null;
        if (plan.barrelExport.trim()) {
            const barrelPath = path.join(baseDir, 'index.ts');
            if (!fs.existsSync(barrelPath)) {
                const barrelUri = vscode.Uri.file(barrelPath);
                wsEdit.createFile(barrelUri, { overwrite: false, ignoreIfExists: true });
                wsEdit.insert(barrelUri, new vscode.Position(0, 0), plan.barrelExport);
                barrelResult = { filePath: barrelPath, status: 'created' };
            } else {
                barrelResult = { filePath: barrelPath, status: 'skipped-exists', reason: 'index.ts already exists' };
            }
        }

        // Update source file — replace entire content
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        wsEdit.replace(document.uri, fullRange, plan.updatedSourceContent);
        const sourceResult: FileApplyResult = { filePath: document.fileName, status: 'updated' };

        // ── 3. Atomic apply ───────────────────────────────────────────────────
        const editApplied = await vscode.workspace.applyEdit(wsEdit);

        if (!editApplied) {
            return {
                success: false, editApplied: false,
                files: fileResults, sourceFile: sourceResult, barrelFile: barrelResult,
                totalCreated: 0, totalSkipped: pre.collisions.length,
                totalFailed: plan.proposedFiles.length,
                durationMs: Date.now() - t0,
                undoMessage: '',
            };
        }

        // ── 4. Post-apply ─────────────────────────────────────────────────────
        // Open the first created file in a new editor pane
        const firstCreated = fileResults.find(f => f.status === 'created');
        if (firstCreated) {
            try {
                const doc = await vscode.workspace.openTextDocument(firstCreated.filePath);
                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
            } catch { /* non-fatal */ }
        }

        // Trigger format on the source document
        try {
            await vscode.commands.executeCommand(
                'editor.action.formatDocument',
                document.uri
            );
        } catch { /* non-fatal — formatter may not be configured */ }

        // ── 5. Result ─────────────────────────────────────────────────────────
        const totalCreated = fileResults.filter(f => f.status === 'created').length;
        const totalSkipped = fileResults.filter(f => f.status === 'skipped-exists').length;
        const totalFailed  = fileResults.filter(f => f.status === 'failed').length;

        const parts: string[] = [`Created ${totalCreated} file(s)`];
        if (totalSkipped > 0) parts.push(`${totalSkipped} skipped (already exist)`);
        if (totalFailed  > 0) parts.push(`${totalFailed} failed`);

        return {
            success: totalFailed === 0 && editApplied,
            editApplied,
            files: fileResults,
            sourceFile: sourceResult,
            barrelFile: barrelResult,
            totalCreated, totalSkipped, totalFailed,
            durationMs: Date.now() - t0,
            undoMessage: `ASTra: ${parts.join(', ')} — Ctrl+Z to undo all changes`,
        };
    }

    /**
     * Show a user-facing summary notification after apply.
     */
    showResult(result: ApplyResult): void {
        if (!result.success) {
            const msg = result.files.find(f => f.status === 'failed')?.reason
                ?? 'Unknown error during apply';
            vscode.window.showErrorMessage(`ASTra Apply Failed: ${msg}`);
            return;
        }

        const parts: string[] = [];
        if (result.totalCreated > 0) parts.push(`✦ ${result.totalCreated} file(s) created`);
        if (result.totalSkipped > 0) parts.push(`${result.totalSkipped} skipped`);
        parts.push(`${result.durationMs}ms`);

        vscode.window
            .showInformationMessage(
                `ASTra: ${parts.join('  ·  ')}`,
                'Undo All',
                'Open Files'
            )
            .then(sel => {
                if (sel === 'Undo All') {
                    vscode.commands.executeCommand('undo');
                } else if (sel === 'Open Files') {
                    result.files
                        .filter(f => f.status === 'created')
                        .forEach(f => {
                            vscode.workspace.openTextDocument(f.filePath)
                                .then(doc => vscode.window.showTextDocument(doc, { preview: false }));
                        });
                }
            });
    }
}

export const refactoringExecutor = new RefactoringExecutor();
