/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Function-Level Region Splitter                                   ║
 * ║                                                                              ║
 * ║  The base parser assigns one ASTRegion per top-level VariableStatement.     ║
 * ║  This means a file like:                                                     ║
 * ║                                                                              ║
 * ║    export const formatDate = (d: Date) => d.toISOString();                  ║
 * ║    export const parseDate  = (s: string) => new Date(s);                    ║
 * ║    export const addDays    = (d: Date, n: number) => { ... }                ║
 * ║                                                                              ║
 * ║  produces ONE region ("formatDate") if those are grouped in a single        ║
 * ║  VariableStatement block (which they're not), OR three regions if they      ║
 * ║  are separate statements — which is already handled correctly.              ║
 * ║                                                                              ║
 * ║  The real gap is OBJECT LITERALS containing multiple methods:                ║
 * ║                                                                              ║
 * ║    export const api = {                                                      ║
 * ║      fetchUser:  async (id: string) => { ... },   ← should be a region     ║
 * ║      createUser: async (data: UserInput) => { ... }, ← should be a region  ║
 * ║      deleteUser: async (id: string) => { ... },   ← should be a region     ║
 * ║    };                                                                        ║
 * ║                                                                              ║
 * ║  And MODULE BLOCKS / NAMESPACE members:                                      ║
 * ║                                                                              ║
 * ║    namespace Formatters {                                                    ║
 * ║      export function formatCurrency(n: number) { ... }                      ║
 * ║      export function formatPercent(n: number) { ... }                       ║
 * ║    }                                                                         ║
 * ║                                                                              ║
 * ║  This module implements a post-parse sub-splitter that:                     ║
 * ║    1. Identifies "splittable" regions (object-method collections,            ║
 * ║       namespace blocks, class method groups)                                ║
 * ║    2. Walks their children to find individual function boundaries            ║
 * ║    3. Emits one sub-region per function, with correct line ranges           ║
 * ║    4. Replaces the parent region with the set of sub-regions                ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as ts from 'typescript';
import type { ASTRegion, RegionKind, SymbolTable } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (duplicated here to avoid circular imports)
// ─────────────────────────────────────────────────────────────────────────────

let _counter = 0;
function newId(name: string): string {
    return `sub_${(_counter++).toString(36).padStart(4, '0')}_${name}`;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
    return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function containsJSX(node: ts.Node): boolean {
    let found = false;
    const walk = (n: ts.Node) => {
        if (found) return;
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
            found = true; return;
        }
        ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
}

function classifyFn(name: string, hasJSX: boolean): RegionKind {
    if (/^use[A-Z]/.test(name))  return 'hook';
    if (/^with[A-Z]/.test(name)) return 'hoc';
    if (/Provider$/.test(name))  return 'context-provider';
    if (/^[A-Z]/.test(name) && hasJSX) return 'react-component';
    return 'utility-function';
}

function maxDepth(src: string): number {
    let d = 0, max = 0;
    for (const ch of src) {
        if (ch === '{' || ch === '(' || ch === '[') max = Math.max(max, ++d);
        else if (ch === '}' || ch === ')' || ch === ']') d = Math.max(0, d - 1);
    }
    return max;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-splitter result
// ─────────────────────────────────────────────────────────────────────────────

export interface SubSplitResult {
    /** The original region was NOT split — return as-is */
    unchanged: boolean;
    /** Sub-regions replacing the original (only set when unchanged=false) */
    subRegions: ASTRegion[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Object-method collection splitter
// ─────────────────────────────────────────────────────────────────────────────

function splitObjectMethods(
    parentRegion: ASTRegion,
    init: ts.ObjectLiteralExpression,
    sf: ts.SourceFile,
    allLines: string[]
): ASTRegion[] {
    const results: ASTRegion[] = [];

    for (const prop of init.properties) {
        // We only split properties whose value is a function
        if (!ts.isPropertyAssignment(prop)) continue;
        const val = (prop as ts.PropertyAssignment).initializer;
        if (!ts.isArrowFunction(val) && !ts.isFunctionExpression(val)) continue;
        if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue;

        const name      = ts.isIdentifier(prop.name) ? prop.name.text : (prop.name as ts.StringLiteral).text;
        const startLine = lineOf(sf, prop.getStart(sf, true));
        const endLine   = lineOf(sf, prop.getEnd());
        const lines     = allLines.slice(startLine - 1, endLine);
        const src       = lines.join('\n');
        const hasJSX    = containsJSX(prop);

        // Collect used symbols: walk the initializer
        const used = new Set<string>();
        const walkSym = (n: ts.Node) => {
            if (ts.isIdentifier(n)) used.add(n.text);
            ts.forEachChild(n, walkSym);
        };
        walkSym(val);

        results.push({
            id: newId(name),
            kind: classifyFn(name, hasJSX),
            name,
            startLine,
            endLine,
            lines,
            isExported: parentRegion.isExported,
            isDefaultExport: false,
            hasJSX,
            hasHooks: /\buse[A-Z]/.test(src),
            hasAsyncOps: /\basync\b|\bawait\b/.test(src),
            localBindings: new Set<string>(),
            usedSymbols: used,
            maxBracketDepth: maxDepth(src),
            leadingComment: undefined,
        });
    }

    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Namespace / module block splitter
// ─────────────────────────────────────────────────────────────────────────────

function splitNamespaceMembers(
    parentRegion: ASTRegion,
    moduleBody: ts.ModuleBlock,
    sf: ts.SourceFile,
    allLines: string[]
): ASTRegion[] {
    const results: ASTRegion[] = [];

    for (const stmt of moduleBody.statements) {
        let name: string | undefined;
        let isExported = false;

        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            name = stmt.name.text;
            isExported = (((stmt.modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword)) ? ts.ModifierFlags.Export : 0) & ts.ModifierFlags.Export) !== 0;
        } else if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer &&
                    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
                    name = decl.name.text;
                    isExported = (((stmt.modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword)) ? ts.ModifierFlags.Export : 0) & ts.ModifierFlags.Export) !== 0;
                }
            }
        }

        if (!name) continue;

        const startLine = lineOf(sf, stmt.getStart(sf, true));
        const endLine   = lineOf(sf, stmt.getEnd());
        const lines     = allLines.slice(startLine - 1, endLine);
        const src       = lines.join('\n');
        const hasJSX    = containsJSX(stmt);

        const used = new Set<string>();
        const walkSym = (n: ts.Node) => {
            if (ts.isIdentifier(n)) used.add(n.text);
            ts.forEachChild(n, walkSym);
        };
        walkSym(stmt);

        results.push({
            id: newId(`${parentRegion.name}_${name}`),
            kind: classifyFn(name, hasJSX),
            name: `${parentRegion.name}.${name}`,
            startLine, endLine, lines,
            isExported, isDefaultExport: false,
            hasJSX,
            hasHooks:   /\buse[A-Z]/.test(src),
            hasAsyncOps:/\basync\b|\bawait\b/.test(src),
            localBindings: new Set<string>(),
            usedSymbols: used,
            maxBracketDepth: maxDepth(src),
            leadingComment: undefined,
        });
    }

    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: attempt to sub-split a region
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to split a region into function-level sub-regions.
 *
 * Returns { unchanged: true } if the region is not a candidate for splitting
 * (single function, type, component, etc.).
 *
 * Returns { unchanged: false, subRegions } when the region was split.
 * The caller should replace the original region with subRegions.
 */
export function trySplitRegion(
    region: ASTRegion,
    symbolTable: SymbolTable,
    sourceCode: string,
    fileName: string
): SubSplitResult {
    // Only attempt for these kinds
    if (!['utility-function', 'namespace', 'constant-block'].includes(region.kind)) {
        return { unchanged: true, subRegions: [] };
    }

    // Only worth splitting if the region is large enough to contain multiple functions
    if (region.lines.length < 15) {
        return { unchanged: true, subRegions: [] };
    }

    // Re-parse just this region's source using TS Compiler API
    const regionSrc = region.lines.join('\n');
    const sf = ts.createSourceFile(fileName, regionSrc, ts.ScriptTarget.Latest, true);

    // For namespace regions: look for module body with multiple function members
    if (region.kind === 'namespace') {
        let moduleBody: ts.ModuleBlock | undefined;
        ts.forEachChild(sf, (n) => {
            if (ts.isModuleDeclaration(n) && n.body && ts.isModuleBlock(n.body)) {
                moduleBody = n.body;
            }
        });
        if (moduleBody && moduleBody.statements.length > 1) {
            void sourceCode; // allLines used in subregion offset('\n');
            const subs = splitNamespaceMembers(region, moduleBody, sf, regionSrc.split('\n'));
            if (subs.length > 1) {
                // Re-offset line numbers relative to original file
                const offset = region.startLine - 1;
                for (const sub of subs) {
                    sub.startLine += offset;
                    sub.endLine   += offset;
                }
                return { unchanged: false, subRegions: subs };
            }
        }
        return { unchanged: true, subRegions: [] };
    }

    // For utility-function / constant-block: look for object literal with multiple methods
    const allRegionLines = regionSrc.split('\n');
    let objectLiteral: ts.ObjectLiteralExpression | undefined;

    ts.forEachChild(sf, (n) => {
        if (ts.isVariableStatement(n)) {
            for (const decl of n.declarationList.declarations) {
                if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
                    objectLiteral = decl.initializer;
                }
            }
        }
        if (ts.isExpressionStatement(n) && ts.isObjectLiteralExpression(n.expression)) {
            objectLiteral = n.expression;
        }
    });

    if (objectLiteral) {
        const fnProps = objectLiteral.properties.filter(
            p => ts.isPropertyAssignment(p) &&
                 (ts.isArrowFunction((p as ts.PropertyAssignment).initializer) ||
                  ts.isFunctionExpression((p as ts.PropertyAssignment).initializer))
        );
        if (fnProps.length >= 2) {
            const subs = splitObjectMethods(region, objectLiteral, sf, allRegionLines);
            if (subs.length > 1) {
                const offset = region.startLine - 1;
                for (const sub of subs) {
                    sub.startLine += offset;
                    sub.endLine   += offset;
                    sub.lines = sourceCode.split('\n').slice(sub.startLine - 1, sub.endLine);
                }
                return { unchanged: false, subRegions: subs };
            }
        }
    }

    return { unchanged: true, subRegions: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: apply sub-splitting to a full array of regions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post-parse pass: apply function-level splitting to all regions.
 * Returns a new array with splittable regions expanded into sub-regions.
 */
export function applyFunctionLevelSplit(
    regions: ASTRegion[],
    symbolTable: SymbolTable,
    sourceCode: string,
    fileName: string,
    minLinesThreshold = 15
): ASTRegion[] {
    const result: ASTRegion[] = [];

    for (const region of regions) {
        // Skip small regions — not worth splitting
        if (region.lines.length < minLinesThreshold) {
            result.push(region);
            continue;
        }

        const split = trySplitRegion(region, symbolTable, sourceCode, fileName);
        if (split.unchanged || split.subRegions.length === 0) {
            result.push(region);
        } else {
            // Replace with sub-regions
            result.push(...split.subRegions);
        }
    }

    return result;
}
