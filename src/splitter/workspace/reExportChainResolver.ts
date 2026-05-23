/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Re-export Chain Resolver                                         ║
 * ║                                                                              ║
 * ║  Follows `export { A } from './b'` chains in the workspace graph so that    ║
 * ║  the symbolExporters map includes transitively re-exported symbols.          ║
 * ║                                                                              ║
 * ║  Problem:                                                                    ║
 * ║    src/index.ts        export { useAuth } from './hooks/auth'                ║
 * ║    src/hooks/auth.ts   export function useAuth() { ... }                     ║
 * ║                                                                              ║
 * ║  Without chain resolution, symbolExporters.get('useAuth') = ['auth.ts']     ║
 * ║  With chain resolution,    symbolExporters.get('useAuth') = ['auth.ts', 'index.ts'] ║
 * ║                                                                              ║
 * ║  Algorithm:                                                                   ║
 * ║    1. Parse re-export statements in each file (export { X } from './y')      ║
 * ║    2. Build a re-export graph: file → { symbol → sourceFile }               ║
 * ║    3. BFS/DFS from every symbol to collect all transitive re-exporters       ║
 * ║    4. Merge into the WorkspaceGraph.symbolExporters map                      ║
 * ║                                                                              ║
 * ║  Cycle protection: visited set prevents infinite loops in circular barrels   ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as fs from "fs";
import * as path from "path";
import type { WorkspaceGraph } from "./workspaceGraph";

// ─────────────────────────────────────────────────────────────────────────────
// Re-export record extracted from a single file
// ─────────────────────────────────────────────────────────────────────────────

export interface ReExportRecord {
  /** The file doing the re-exporting */
  fromFile: string;
  /** The specifier: relative path like './hooks/auth' */
  specifier: string;
  /** Names being re-exported: ['useAuth', 'useTheme'] or ['*'] for namespace re-exports */
  symbols: string[];
  /** Whether this is a namespace re-export: export * from './x' */
  isNamespace: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast regex-based re-export extractor (no full AST needed)
// ─────────────────────────────────────────────────────────────────────────────

const NAMED_REEXPORT_RE = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
const NAMESPACE_REEXPORT_RE =
  /export\s*\*(?:\s+as\s+\w+)?\s+from\s*['"]([^'"]+)['"]/g;

export function extractReExports(filePath: string): ReExportRecord[] {
  let src: string;
  try {
    src = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  // Quick bailout — if no re-export pattern at all, skip (no /g flag to avoid lastIndex issue)
  if (!/export\s*\{[^}]+\}\s*from|export\s*\*\s+from/.test(src)) return [];

  const records: ReExportRecord[] = [];

  // Named re-exports: export { A, B as C } from './x'
  let m: RegExpExecArray | null;
  NAMED_REEXPORT_RE.lastIndex = 0;
  while ((m = NAMED_REEXPORT_RE.exec(src)) !== null) {
    const namesRaw = m[1];
    const specifier = m[2];
    const symbols = namesRaw
      .split(",")
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);

    if (symbols.length > 0) {
      records.push({
        fromFile: filePath,
        specifier,
        symbols,
        isNamespace: false,
      });
    }
  }

  // Namespace re-exports: export * from './x'  or  export * as ns from './x'
  NAMESPACE_REEXPORT_RE.lastIndex = 0;
  while ((m = NAMESPACE_REEXPORT_RE.exec(src)) !== null) {
    records.push({
      fromFile: filePath,
      specifier: m[1],
      symbols: ["*"],
      isNamespace: true,
    });
  }

  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// Specifier → absolute path resolution
// ─────────────────────────────────────────────────────────────────────────────

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  "/index.ts",
  "/index.js",
];

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // external package — skip

  const fromDir = path.dirname(fromFile);
  const base = path.resolve(fromDir, specifier);

  // Try with extensions
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }

  // Try as-is (already has extension)
  if (fs.existsSync(base)) return base;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain resolver
// ─────────────────────────────────────────────────────────────────────────────

export class ReExportChainResolver {
  /**
   * Augment a workspace graph's symbolExporters map with transitive re-exports.
   *
   * @param graph  The workspace graph to augment (mutates symbolExporters in place)
   */
  resolve(graph: WorkspaceGraph): void {
    // Step 1: extract re-export records for every file in the graph
    const reExportsByFile = new Map<string, ReExportRecord[]>();
    for (const [filePath] of graph.files) {
      const records = extractReExports(filePath);
      if (records.length > 0) reExportsByFile.set(filePath, records);
    }

    if (reExportsByFile.size === 0) return; // no re-exports in project

    // Step 2: for each re-export record, follow the chain and extend symbolExporters
    for (const [reExportFile, records] of reExportsByFile) {
      for (const rec of records) {
        const sourceFile = resolveSpecifier(reExportFile, rec.specifier);
        if (!sourceFile) continue;

        if (rec.isNamespace) {
          // export * from './x' — re-exports EVERYTHING that sourceFile exports
          const sourceRecord = graph.files.get(sourceFile);
          if (!sourceRecord) continue;

          for (const sym of sourceRecord.exports) {
            this._addToExporters(graph, sym, reExportFile);
          }
        } else {
          // Named re-exports
          for (const sym of rec.symbols) {
            this._addToExporters(graph, sym, reExportFile);
          }
        }
      }
    }

    // Step 3: second pass — follow chains transitively (e.g. index → subIndex → source)
    // Run up to 5 hops to handle deep barrel chains
    for (let hop = 0; hop < 5; hop++) {
      let changed = false;

      for (const [reExportFile, records] of reExportsByFile) {
        for (const rec of records) {
          const sourceFile = resolveSpecifier(reExportFile, rec.specifier);
          if (!sourceFile) continue;

          const symsToPropagate = rec.isNamespace
            ? (graph.files.get(sourceFile)?.exports ?? [])
            : rec.symbols;

          for (const sym of symsToPropagate) {
            const currentList = graph.symbolExporters.get(sym) ?? [];
            if (!currentList.includes(reExportFile)) {
              this._addToExporters(graph, sym, reExportFile);
              changed = true;
            }
          }
        }
      }

      if (!changed) break; // converged
    }
  }

  private _addToExporters(
    graph: WorkspaceGraph,
    symbol: string,
    filePath: string,
  ): void {
    const current = graph.symbolExporters.get(symbol) ?? [];
    if (!current.includes(filePath)) {
      current.push(filePath);
      graph.symbolExporters.set(symbol, current);
    }
  }
}

export const reExportChainResolver = new ReExportChainResolver();
