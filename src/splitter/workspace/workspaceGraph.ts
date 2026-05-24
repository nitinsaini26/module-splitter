/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Cross-File Workspace Graph                                      ║
 * ║                                                                              ║
 * ║  Builds a project-wide dependency graph by analysing every TS/JS/JSX/TSX   ║
 * ║  file in the workspace. Used to:                                            ║
 * ║    ▸ Suggest which *existing* file a region should be merged into           ║
 * ║      (instead of always creating a new file)                               ║
 * ║    ▸ Detect truly dead exports across the whole project                    ║
 * ║    ▸ Prevent naming collisions when proposing new files                    ║
 * ║    ▸ Find the best barrel index.ts to add re-exports to                    ║
 * ║                                                                              ║
 * ║  Architecture:                                                               ║
 * ║    WorkspaceGraphBuilder   — scans files, builds per-file region summaries  ║
 * ║    WorkspaceGraph          — immutable snapshot queried by ModuleSplitter   ║
 * ║    MergeAdvisor            — queries graph to produce merge suggestions      ║
 * ║                                                                              ║
 * ║  Performance:                                                                ║
 * ║    Scanning is done lazily: only files modified since last scan are         ║
 * ║    re-parsed. The graph persists in memory across commands.                 ║
 * ║    Files >2000 lines are skipped (too large to merge into).                ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as fs from "fs";
import * as path from "path";
import { parseSourceFile } from "../parser/astParser";
import type { RegionKind } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspaceFileRecord {
  /** Absolute path */
  filePath: string;
  /** Relative path from workspace root */
  relPath: string;
  /** File extension */
  ext: string;
  /** Last modified time (ms) — used for incremental rescanning */
  mtime: number;
  /** All exported symbol names in this file */
  exports: string[];
  /** All imported specifiers this file depends on */
  imports: string[];
  /** Region summaries (name + kind + line count) */
  regions: WorkspaceRegionSummary[];
  /** Total lines in the file */
  lineCount: number;
  /** Whether this file already has a barrel/index role */
  isBarrel: boolean;
  /** Detected framework hint */
  framework: "react" | "vue" | "angular" | "svelte" | "qwik" | "none";
}

export interface WorkspaceRegionSummary {
  name: string;
  kind: RegionKind;
  lineCount: number;
  isExported: boolean;
}

export interface MergeSuggestion {
  /** Absolute path of the existing file to merge into */
  targetFilePath: string;
  /** Relative path (for display) */
  targetRelPath: string;
  /** Confidence score 0–1 */
  score: number;
  /** Why this file is a good merge target */
  reasons: string[];
  /** The exported symbols from the target that are relevant */
  sharedSymbols: string[];
  /** Whether the target file already has similar regions */
  hasSimilarKind: boolean;
  /** Whether target already imports from the source file */
  alreadyLinked: boolean;
  /** Estimated lines after merge */
  estimatedTotalLines: number;
  /** Whether the merge would exceed 200 lines (discouraged) */
  wouldExceedLimit: boolean;
}

export interface WorkspaceGraph {
  /** Root of the workspace */
  workspaceRoot: string;
  /** All tracked files */
  files: Map<string, WorkspaceFileRecord>;
  /** Reverse import map: exported-symbol → files that export it */
  symbolExporters: Map<string, string[]>;
  /** Build timestamp */
  builtAt: number;
  /** How many files were scanned */
  scannedCount: number;
  /** How many files were skipped (too large / not TS/JS) */
  skippedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
]);
const MAX_FILE_LINES = 2000; // don't suggest merging into files this large
const MERGE_LINE_LIMIT = 200; // warn if merge would push target past this

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".git",
  ".vscode",
  "__pycache__",
  ".turbo",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Framework detector
// ─────────────────────────────────────────────────────────────────────────────

function detectFramework(
  src: string,
  ext: string,
): WorkspaceFileRecord["framework"] {
  if (ext === ".vue") return "vue";
  if (ext === ".svelte") return "svelte";
  if (/@Component|@NgModule|@Injectable/.test(src)) return "angular";
  if (/component\$\s*\(|useSignal\s*\(|useStore\s*\(|useTask\$\s*\(/.test(src))
    return "qwik";
  if (/from ['"]react['"]|jsx|useState/.test(src)) return "react";
  return "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// File scanner
// ─────────────────────────────────────────────────────────────────────────────

function scanFile(
  filePath: string,
  workspaceRoot: string,
): WorkspaceFileRecord | null {
  try {
    const stat = fs.statSync(filePath);
    const src = fs.readFileSync(filePath, "utf8");
    const lines = src.split("\n");

    if (lines.length > MAX_FILE_LINES) return null;

    const ext = path.extname(filePath);
    const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");

    // Extract exported names (fast regex — no full AST needed here)
    const exports: string[] = [];
    const exportRe =
      /^export\s+(?:default\s+)?(?:const|function|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = exportRe.exec(src)) !== null) exports.push(m[1]);

    // Extract import specifiers
    const imports: string[] = [];
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    while ((m = importRe.exec(src)) !== null) imports.push(m[1]);

    // Get regions via AST (lightweight — just names and kinds)
    let regions: WorkspaceRegionSummary[] = [];
    try {
      if (SUPPORTED_EXTS.has(ext)) {
        const parsed = parseSourceFile(src, path.basename(filePath));
        regions = parsed.regions.map((r) => ({
          name: r.name,
          kind: r.kind,
          lineCount: r.endLine - r.startLine + 1,
          isExported: r.isExported,
        }));
      }
    } catch {
      /* ignore parse errors in workspace scan */
    }

    const isBarrel =
      /index\.[jt]sx?$/.test(filePath) ||
      (exports.length > 5 && imports.length === 0);

    return {
      filePath,
      relPath,
      ext,
      mtime: stat.mtimeMs,
      exports,
      imports,
      regions,
      lineCount: lines.length,
      isBarrel,
      framework: detectFramework(src, ext),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceGraphBuilder
// ─────────────────────────────────────────────────────────────────────────────

export class WorkspaceGraphBuilder {
  private _graph: WorkspaceGraph | null = null;

  /**
   * Build or incrementally update the workspace graph.
   * @param workspaceRoot  Absolute path to the workspace root
   * @param fileUris       List of absolute file paths to scan (from vscode.workspace.findFiles)
   */
  async build(
    workspaceRoot: string,
    fileUris: string[],
  ): Promise<WorkspaceGraph> {
    const existing = this._graph;
    const files = new Map<string, WorkspaceFileRecord>(existing?.files);
    let scanned = 0,
      skipped = 0;

    for (const fp of fileUris) {
      const ext = path.extname(fp);
      if (!SUPPORTED_EXTS.has(ext)) {
        skipped++;
        continue;
      }

      // Check if file should be ignored
      const parts = fp.split(/[\\/]/);
      if (parts.some((p) => IGNORED_DIRS.has(p))) {
        skipped++;
        continue;
      }

      // Incremental: only re-scan if mtime changed
      const existingRecord = existing?.files.get(fp);
      try {
        const mtime = fs.statSync(fp).mtimeMs;
        if (existingRecord && existingRecord.mtime === mtime) continue;
      } catch {
        skipped++;
        continue;
      }

      const record = scanFile(fp, workspaceRoot);
      if (!record) {
        skipped++;
        continue;
      }

      files.set(fp, record);
      scanned++;
    }

    // Remove files that no longer exist
    for (const fp of files.keys()) {
      if (!fs.existsSync(fp)) files.delete(fp);
    }

    // Build reverse symbol map
    const symbolExporters = new Map<string, string[]>();
    for (const [fp, record] of files) {
      for (const sym of record.exports) {
        const existing = symbolExporters.get(sym) ?? [];
        existing.push(fp);
        symbolExporters.set(sym, existing);
      }
    }

    this._graph = {
      workspaceRoot,
      files,
      symbolExporters,
      builtAt: Date.now(),
      scannedCount: scanned,
      skippedCount: skipped,
    };
    return this._graph;
  }

  getGraph(): WorkspaceGraph | null {
    return this._graph;
  }
  invalidate(): void {
    this._graph = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MergeAdvisor — queries the workspace graph for merge suggestions
// ─────────────────────────────────────────────────────────────────────────────

export class MergeAdvisor {
  /**
   * For a single region being considered for extraction, find existing
   * workspace files that would be a better home than a new file.
   *
   * @param regionName     Name of the region (e.g. "useAuth")
   * @param regionKind     Kind classification
   * @param usedSymbols    Symbols the region uses (from SymbolTable)
   * @param sourceFilePath Absolute path of the file being split (excluded from results)
   * @param graph          Current workspace graph
   * @param maxResults     Max suggestions to return (default 3)
   */
  suggest(
    regionName: string,
    regionKind: RegionKind,
    usedSymbols: string[],
    sourceFilePath: string,
    graph: WorkspaceGraph,
    maxResults = 3,
  ): MergeSuggestion[] {
    const suggestions: MergeSuggestion[] = [];

    for (const [fp, record] of graph.files) {
      // Skip the source file itself
      if (fp === sourceFilePath) continue;
      // Skip barrel files (too broad)
      if (record.isBarrel) continue;
      // Skip very large files
      if (record.lineCount > MAX_FILE_LINES) continue;
      // Skip files that already define a symbol with the same name
      if (record.exports.includes(regionName)) continue;

      const score = this._score(regionName, regionKind, usedSymbols, record);
      if (score.total < 0.25) continue;

      const estimatedTotal = record.lineCount + 20; // rough estimate
      suggestions.push({
        targetFilePath: fp,
        targetRelPath: record.relPath,
        score: Math.round(score.total * 100) / 100,
        reasons: score.reasons,
        sharedSymbols: score.sharedSymbols,
        hasSimilarKind: score.hasSimilarKind,
        alreadyLinked: score.alreadyLinked,
        estimatedTotalLines: estimatedTotal,
        wouldExceedLimit: estimatedTotal > MERGE_LINE_LIMIT,
      });
    }

    return suggestions.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  // ── Scoring ──────────────────────────────────────────────────────────────

  private _score(
    regionName: string,
    regionKind: RegionKind,
    usedSymbols: string[],
    record: WorkspaceFileRecord,
  ): {
    total: number;
    reasons: string[];
    sharedSymbols: string[];
    hasSimilarKind: boolean;
    alreadyLinked: boolean;
  } {
    let total = 0;
    const reasons: string[] = [];
    const sharedSymbols: string[] = [];

    // 1. Kind match — same kind of region already exists here
    const hasSimilarKind = record.regions.some((r) => r.kind === regionKind);
    if (hasSimilarKind) {
      total += 0.3;
      reasons.push(`File already contains ${regionKind} regions`);
    }

    // 2. Name similarity — file already has similarly-named exports
    const nameLower = regionName.toLowerCase();
    const nameMatch = record.exports.some(
      (e) =>
        e.toLowerCase().includes(nameLower.slice(0, 4)) ||
        nameLower.includes(e.toLowerCase().slice(0, 4)),
    );
    if (nameMatch) {
      total += 0.2;
      reasons.push(`File exports similarly-named symbols`);
    }

    // 3. Shared symbols — region uses symbols that this file exports
    for (const sym of usedSymbols) {
      if (record.exports.includes(sym)) {
        sharedSymbols.push(sym);
      }
    }
    if (sharedSymbols.length > 0) {
      total += Math.min(0.3, sharedSymbols.length * 0.1);
      reasons.push(
        `Shares ${sharedSymbols.length} symbol(s): ${sharedSymbols.slice(0, 3).join(", ")}`,
      );
    }

    // 4. Framework alignment
    const regionFramework =
      regionKind === "hook" || regionKind === "react-component"
        ? "react"
        : "none";
    if (regionFramework !== "none" && record.framework === regionFramework) {
      total += 0.1;
      reasons.push(`Same framework (${record.framework})`);
    }

    // 5. Already linked — file already imports from the source (strong coupling signal)
    const alreadyLinked = false; // cross-file import detection via string match
    if (record.imports.some((i) => i.includes(regionName.toLowerCase()))) {
      total += 0.15;
      reasons.push("File already imports related symbols");
    }

    // 6. Path proximity — same directory or nearby
    // (handled by caller — proximity bonus applied externally)

    // 7. File size — prefer files with room to grow
    if (record.lineCount < 80) {
      total += 0.05;
    }

    return {
      total: Math.min(1, total),
      reasons,
      sharedSymbols,
      hasSimilarKind,
      alreadyLinked,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singletons
// ─────────────────────────────────────────────────────────────────────────────

export const workspaceGraphBuilder = new WorkspaceGraphBuilder();
export const mergeAdvisor = new MergeAdvisor();
