/**
 * ASTra v3 — Module Splitter
 * 8-stage pipeline with: incremental cache, Halstead-calibrated threshold,
 * framework plugins, workspace merge suggestions, function-level splitting,
 * per-function thresholds, exact CogCC, LCOM4, re-export chain resolution,
 * semantic type resolution.
 */

import { parseSourceFile } from "../parser/astParser";
import { applyFunctionLevelSplit } from "../parser/functionSplitter";
import {
  buildDependencyGraph,
  findCriticalPath,
} from "../graph/dependencyGraph";
import { computeRegionMetrics, computeFileMetrics } from "../analysis/metrics";
import {
  detectRegionSmells,
  detectFileSmells,
} from "../analysis/smellDetector";
import { buildCoChangeRecordsFromGit } from "../analysis/coChangeDetector";
import { evaluateExtraction } from "../analysis/extractionOracle";
import { calibrateThreshold } from "../analysis/thresholdCalibrator";
import { calibratePerFunction } from "../analysis/perFunctionCalibrator";
import { resolveImports, resolveTypeRouting } from "../resolver/importResolver";
import {
  generateFileContent,
  buildBarrelFile,
  generateUpdatedSource,
} from "../generator/fileGenerator";
import { regionCache } from "../cache/regionCache";
import {
  detectFrameworkSmells,
  detectFrameworkKind,
} from "../frameworks/frameworkPlugins";
import { mergeAdvisor } from "../workspace/workspaceGraph";
import { reExportChainResolver } from "../workspace/reExportChainResolver";
import { semanticTypeResolver } from "../semantic/semanticTypeResolver";
import { toKebabCase } from "../utils/helpers";
import type { FileDirectives } from "../generator/fileGenerator";
import type { WorkspaceGraph } from "../workspace/workspaceGraph";

import type {
  EnrichedRegion,
  SplitPlan,
  SplitSummary,
  WorkspaceContext,
  ProposedFile,
  FileLinkage,
  TestFileSuggestion,
  CodeSmell,
  RegionMetrics,
  IncrementalCacheStats,
  FrameworkSmellRecord,
  RegionMergeSuggestions,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const LANG_MAP: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript/React",
  js: "JavaScript",
  jsx: "JavaScript/React",
  mts: "TypeScript (ESM)",
  cts: "TypeScript (CJS)",
  mjs: "JavaScript (ESM)",
  cjs: "JavaScript (CJS)",
  py: "Python",
  java: "Java",
  cs: "C#",
  go: "Go",
  rs: "Rust",
};
const detectLanguage = (f: string) =>
  LANG_MAP[f.split(".").pop()?.toLowerCase() ?? ""] ?? "Unknown";

const NEXT_CLIENT_RE = /^['"]use client['"];?$/;
const NEXT_SERVER_RE = /^['"]use server['"];?$/;

function detectFileDirectives(
  lines: string[],
  filePath: string,
): FileDirectives {
  let useClient = false;
  let useServer = false;
  let directiveText: string | undefined;
  let directiveLine: number | undefined;

  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    if (line.startsWith("//")) continue;

    if (NEXT_CLIENT_RE.test(line)) {
      useClient = true;
      directiveText = raw.trim().replace(/;?$/, ";");
      directiveLine = i + 1;
    } else if (NEXT_SERVER_RE.test(line)) {
      useServer = true;
      directiveText = raw.trim().replace(/;?$/, ";");
      directiveLine = i + 1;
    }
    break;
  }

  const isNextAppRouter = /[/\\]app[/\\]/.test(filePath);

  return {
    useClient,
    useServer,
    directiveText,
    directiveLine,
    isNextAppRouter,
  };
}

function isRouteModule(sourceCode: string): boolean {
  return /export\s+(?:async\s+)?(?:function|const)\s+(loader|action|meta)\b/.test(
    sourceCode,
  );
}

function hasClientEventHandlers(region: EnrichedRegion): boolean {
  const src = region.lines.join("\n");
  return /on[A-Z][A-Za-z]+\s*=/.test(src);
}

function isSvelteStoreRegion(region: EnrichedRegion): boolean {
  const src = region.lines.join("\n");
  return /\bconst\s+\w+\s*=\s*(writable|readable)\s*\(/.test(src);
}

function buildLinkageMap(
  proposedFiles: ProposedFile[],
  enrichedRegions: EnrichedRegion[],
  proposedFileMap: Map<string, string>,
): FileLinkage[] {
  const linkages: FileLinkage[] = [];
  for (const pf of proposedFiles) {
    const region = enrichedRegions.find((r) => r.id === pf.sourceRegionId);
    if (!region) continue;
    for (const dep of region.importedSymbols) {
      const depRegion = enrichedRegions.find(
        (r) => r.name === dep && r.id !== region.id,
      );
      if (!depRegion) continue;
      const depFile = proposedFileMap.get(depRegion.id);
      if (!depFile || depFile === pf.fileName) continue;
      const existing = linkages.find(
        (l) => l.from === pf.fileName && l.to === depFile,
      );
      if (existing) {
        if (!existing.symbols.includes(dep)) {
          existing.symbols.push(dep);
          existing.edgeWeight++;
        }
      } else
        linkages.push({
          from: pf.fileName,
          to: depFile,
          symbols: [dep],
          isCircular: false,
          isCriticalPath: false,
          edgeWeight: 1,
        });
    }
  }
  for (const link of linkages) {
    const rev = linkages.find((l) => l.from === link.to && l.to === link.from);
    if (rev) {
      link.isCircular = true;
      rev.isCircular = true;
    }
  }
  return linkages;
}

function buildSummary(
  regions: EnrichedRegion[],
  extractionCandidates: EnrichedRegion[],
  proposedFiles: ProposedFile[],
  totalDebt: number,
): SplitSummary {
  const complexity =
    regions.length > 10 && extractionCandidates.length > 5
      ? "highly-complex"
      : regions.length > 6 && extractionCandidates.length > 3
        ? "complex"
        : regions.length > 3 && extractionCandidates.length > 1
          ? "moderate"
          : "simple";
  const recommendations: string[] = [];
  if (extractionCandidates.length > 0)
    recommendations.push(
      `Extract ${extractionCandidates.length} region(s) to dedicated files.`,
    );
  return {
    totalRegions: regions.length,
    extractionCount: extractionCandidates.length,
    retainedCount: regions.length - extractionCandidates.length,
    typeRoutingCount: regions.filter((r) => r.kind === "type-block").length,
    overallComplexity: complexity,
    recommendation:
      recommendations.join(" ") ||
      "File is well-structured — no extraction needed.",
    estimatedRefactorMinutes: totalDebt,
    dryRunPreview: proposedFiles.map(
      (pf) =>
        `  ✦ ${pf.fileName} (${pf.estimatedLines} lines, ${pf.resolvedImports.length} imports)`,
    ),
  };
}

const DEFAULT_CTX: WorkspaceContext = {
  existingTypeFiles: [],
  existingHookFiles: [],
  existingUtilFiles: [],
  existingIndexFiles: [],
  existingTestFiles: [],
  sourceDir: "",
  testFramework: "jest",
  packageManager: "npm",
  isMonorepo: false,
  tsConfig: undefined,
};

// ─────────────────────────────────────────────────────────────────────────────
// ModuleSplitter
// ─────────────────────────────────────────────────────────────────────────────

export class ModuleSplitter {
  analyse(
    sourceCode: string,
    fileName: string,
    ctx: Partial<WorkspaceContext> = {},
    userThreshold: number = 0.35,
    filePath: string = "",
    workspaceGraph: WorkspaceGraph | null = null,
  ): SplitPlan {
    const t0 = Date.now();
    const effectiveCtx = { ...DEFAULT_CTX, ...ctx };
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "ts";
    const language = detectLanguage(fileName);
    const lines = sourceCode.split("\n");
    const cacheKey = filePath || fileName;
    const directives = detectFileDirectives(lines, filePath || fileName);
    const nextBoundaryActive =
      directives.useClient ||
      directives.useServer ||
      directives.isNextAppRouter;
    const routeBoundaryActive = isRouteModule(sourceCode);

    // Stage 1: Parse
    const {
      regions: rawRegionsBase,
      symbolTable,
      engineUsed,
    } = parseSourceFile(sourceCode, fileName);

    // Stage 1c: Function-level region splitting
    // Expands object-method collections and namespace members into individual regions
    const rawRegions = applyFunctionLevelSplit(
      rawRegionsBase,
      symbolTable,
      sourceCode,
      fileName,
    );

    // Stage 1d: Semantic type resolution (optional — graceful degradation on failure)
    // Refines the type-vs-value classification using the TS TypeChecker

    const semanticInfo = semanticTypeResolver.resolveFile(
      filePath || fileName,
      sourceCode,
    );

    // Patch SymbolTable namespace classifications with semantic results
    if (semanticInfo.resolved) {
      for (const [name, entry] of symbolTable.locals) {
        if (semanticInfo.typeOnlySymbols.has(name)) {
          entry.namespace = "type";
        } else if (semanticInfo.dualSymbols.has(name)) {
          entry.namespace = "both";
        } else if (semanticInfo.valueSymbols.has(name)) {
          entry.namespace = "value";
        }
      }
    }

    // Stage 1b: Incremental cache diff
    const cacheDiff = regionCache.diff(cacheKey, sourceCode, rawRegions, ext);

    // Stage 1e: Re-export chain resolution (if workspace graph available)
    // Adds transitive re-exporters to symbolExporters map
    if (workspaceGraph) {
      reExportChainResolver.resolve(workspaceGraph);
    }

    // Stage 2: Dependency graph (always rebuilt — O(V+E), negligible)
    let coChangeRecords = effectiveCtx.coChange?.records ?? [];
    if (
      coChangeRecords.length === 0 &&
      effectiveCtx.coChange?.enabled &&
      filePath
    ) {
      coChangeRecords = buildCoChangeRecordsFromGit(rawRegions, filePath, {
        minCoupling: effectiveCtx.coChange.minCoupling,
        maxRegions: effectiveCtx.coChange.maxRegions,
        maxCommits: effectiveCtx.coChange.maxCommits,
        repoRoot: effectiveCtx.coChange.repoRoot,
      });
    }

    const dependencyGraph = buildDependencyGraph(
      rawRegions,
      symbolTable,
      coChangeRecords,
    );
    const cyclicRegionIds = new Set<string>(
      dependencyGraph.sccs.filter((s) => s.length > 1).flat(),
    );

    // Stages 3+4: Metrics & smells — INCREMENTAL
    const regionSmellMap = new Map<
      string,
      ReturnType<typeof detectRegionSmells>
    >();
    const metricsMap = new Map<string, RegionMetrics>();

    for (const raw of rawRegions) {
      const cached = cacheDiff.cached.get(raw.id);
      if (cached) {
        metricsMap.set(raw.id, cached.metrics);
        regionSmellMap.set(raw.id, cached.smells);
      } else {
        const src = raw.lines.join("\n");
        // Use exact CC (from metrics.ts which now calls cognitiveComplexityExact)
        const approxCC =
          1 +
          (src.match(/\bif\b|\bfor\b|\bwhile\b|\b&&\b|\b\|\|\b/g) ?? []).length;
        const smells = detectRegionSmells(
          raw,
          raw.lines.length,
          approxCC,
          raw.maxBracketDepth,
          symbolTable,
          filePath || fileName,
        );
        const metrics = computeRegionMetrics(raw, smells.length);
        regionSmellMap.set(raw.id, smells);
        metricsMap.set(raw.id, metrics);
        regionCache.store(cacheKey, sourceCode, raw, ext, metrics, smells);
      }
    }

    // Stage 5a: Halstead-calibrated threshold (file-level)
    const allMetrics = rawRegions
      .map((r) => metricsMap.get(r.id)!)
      .filter(Boolean);
    const thresholdCalibration = calibrateThreshold(allMetrics, userThreshold);

    // Stage 5a-ii: Per-function Halstead threshold (region-level refinement)
    const perFnCalib = calibratePerFunction(metricsMap, userThreshold);
    // Patch metricsMap with per-function thresholds
    for (const [regionId, metrics] of metricsMap) {
      const pfThresh = perFnCalib.calibrations.get(regionId)?.regionThreshold;
      if (pfThresh !== undefined) {
        metricsMap.set(regionId, {
          ...metrics,
          perFunctionThreshold: pfThresh,
        });
      }
    }

    // Stage 5b: Extraction Oracle — uses per-function threshold per region
    const calibratedThreshold = thresholdCalibration.threshold;

    const enrichedRegions: EnrichedRegion[] = rawRegions.map((raw) => {
      const metrics = metricsMap.get(raw.id)!;
      const smells = regionSmellMap.get(raw.id) ?? [];
      const outboundCoupling =
        dependencyGraph.outboundCouplingScores.get(raw.id) ?? 0;
      const inboundCoupling =
        dependencyGraph.inboundCouplingScores.get(raw.id) ?? 0;
      const cohesionScore = dependencyGraph.cohesionScores.get(raw.id) ?? 0.5;
      const symbolEntry = symbolTable.locals.get(raw.name);
      const isDeadExport = !!(
        raw.isExported &&
        symbolEntry &&
        symbolEntry.referencedByRegionIds.size === 0
      );

      const exportedSymbols = symbolEntry
        ? [...symbolEntry.referencedByRegionIds]
            .flatMap((rid) => {
              const dep = rawRegions.find((r) => r.id === rid);
              return dep ? [raw.name] : [];
            })
            .filter((v, i, a) => a.indexOf(v) === i)
        : [];

      const importedSymbols = [...raw.usedSymbols].filter((sym) => {
        if (raw.localBindings.has(sym)) return false;
        const entry = symbolTable.locals.get(sym);
        return !!(entry && entry.declaredInRegionId !== raw.id);
      });

      const externalPackages: string[] = [];
      for (const sym of raw.usedSymbols) {
        const ir = [...symbolTable.imports.values()].find(
          (r) =>
            r.defaultAlias === sym ||
            r.namespaceAlias === sym ||
            r.named.some((n) => n.alias === sym),
        );
        if (
          ir &&
          !ir.specifier.startsWith(".") &&
          !externalPackages.includes(ir.specifier)
        ) {
          externalPackages.push(ir.specifier);
        }
      }

      const inlineTypeNames = [...raw.usedSymbols].filter(
        (sym) => symbolTable.locals.get(sym)?.namespace === "type",
      );

      const codeSmells: CodeSmell[] = smells.map((s) => ({
        ...s,
        affectedRegionIds: [raw.id],
      }));

      // Use per-function threshold if available, otherwise fall back to file threshold
      const regionThreshold =
        metrics.perFunctionThreshold ?? calibratedThreshold;

      const extractionDecision = evaluateExtraction({
        region: raw,
        metrics,
        smellNames: smells.map((s) => s.name),
        outboundCoupling,
        inboundCoupling,
        cohesionScore,
        isDeadExport,
        sourceFileExt: ext,
        isInSCC: cyclicRegionIds.has(raw.id),
        calibratedThreshold: regionThreshold, // ← per-function calibrated threshold
      });

      return {
        ...raw,
        metrics,
        smells: codeSmells,
        exportedSymbols,
        importedSymbols,
        externalPackages,
        inlineTypeNames,
        isDeadExport,
        extractionDecision,
      };
    });

    // ── Framework-aware boundaries & Svelte store extraction ─────────────
    const boundaryNames = new Set(["loader", "action", "meta"]);
    for (const region of enrichedRegions) {
      if (routeBoundaryActive && boundaryNames.has(region.name)) {
        region.extractionDecision = {
          ...region.extractionDecision,
          shouldExtract: false,
          reasons: [
            ...region.extractionDecision.reasons,
            "Route export boundary (loader/action/meta)",
          ],
          confidence: "high",
        };
      }

      if (
        (filePath || fileName).endsWith(".svelte") &&
        isSvelteStoreRegion(region)
      ) {
        region.extractionDecision = {
          shouldExtract: true,
          reasons: [
            ...region.extractionDecision.reasons,
            "Svelte store declared inline",
          ],
          confidence: "high",
          miDelta: Math.max(1, region.extractionDecision.miDelta),
          suggestedFileName: `stores/${toKebabCase(region.name)}.ts`,
          suggestedDir: "stores",
        };
      }

      if (
        nextBoundaryActive &&
        !directives.useClient &&
        (region.hasHooks || hasClientEventHandlers(region))
      ) {
        region.extractionDecision = {
          ...region.extractionDecision,
          shouldExtract: false,
          reasons: [
            ...region.extractionDecision.reasons,
            "Next.js server boundary (client features present)",
          ],
          confidence: "medium",
        };
      }
    }

    // Stage 5c: Type routing + partition
    const typeRegions = enrichedRegions.filter((r) => r.kind === "type-block");
    const typeRouting = resolveTypeRouting(typeRegions, effectiveCtx);
    const extractionCandidates = enrichedRegions.filter(
      (r) => r.extractionDecision.shouldExtract && r.kind !== "type-block",
    );
    const retainedRegions = enrichedRegions.filter(
      (r) => !r.extractionDecision.shouldExtract || r.kind === "type-block",
    );

    // Stages 6+7: Import resolution + file generation
    const proposedFileMap = new Map<string, string>();
    for (const region of extractionCandidates)
      proposedFileMap.set(
        region.id,
        region.extractionDecision.suggestedFileName,
      );

    const proposedFiles: ProposedFile[] = extractionCandidates.map((region) => {
      const resolved = resolveImports(
        region,
        enrichedRegions,
        symbolTable,
        proposedFileMap,
        typeRouting,
        effectiveCtx,
      );
      const pf = generateFileContent(
        region,
        region.extractionDecision.suggestedFileName,
        resolved,
        fileName,
        effectiveCtx,
        typeRouting,
        enrichedRegions,
        proposedFileMap,
        directives,
      );
      pf.hasExistingTest = effectiveCtx.existingTestFiles.some((tf) =>
        tf.endsWith(pf.testFilePath),
      );
      return pf;
    });

    // Stage 8: Linkage + critical path
    const linkageMap = buildLinkageMap(
      proposedFiles,
      enrichedRegions,
      proposedFileMap,
    );
    for (const pf of proposedFiles) {
      pf.linkedTo = linkageMap
        .filter((l) => l.from === pf.fileName)
        .map((l) => l.to);
      pf.linkedFrom = linkageMap
        .filter((l) => l.to === pf.fileName)
        .map((l) => l.from);
    }
    const circularRisks = [
      ...new Set(
        linkageMap.filter((l) => l.isCircular).flatMap((l) => [l.from, l.to]),
      ),
    ];
    const fileAdj = new Map<string, Set<string>>(
      proposedFiles.map((pf) => [pf.fileName, new Set(pf.linkedTo)]),
    );
    const criticalPathFiles = findCriticalPath(
      proposedFiles.map((pf) => pf.fileName),
      fileAdj,
    );
    for (const link of linkageMap) {
      link.isCriticalPath =
        criticalPathFiles.includes(link.from) &&
        criticalPathFiles.includes(link.to);
    }

    const codeSmells = detectFileSmells(rawRegions, regionSmellMap);
    if (nextBoundaryActive && !directives.useClient) {
      const affected = enrichedRegions
        .filter((r) => r.hasHooks || hasClientEventHandlers(r))
        .map((r) => r.id);
      if (affected.length > 0) {
        codeSmells.push({
          name: "React Server Component uses client features",
          severity: "critical",
          description:
            "Hooks or event handlers detected without a 'use client' directive",
          affectedRegionIds: affected,
          recommendation:
            "Add 'use client' to the file or move client-only logic into a client component",
          autoFixable: false,
        });
      }
    }
    const barrelExport = buildBarrelFile(proposedFiles);
    const testFileSuggestions: TestFileSuggestion[] = proposedFiles.map(
      (pf) => {
        const region = enrichedRegions.find((r) => r.id === pf.sourceRegionId)!;
        return {
          sourceFile: pf.fileName,
          testFile: pf.testFilePath,
          framework:
            effectiveCtx.testFramework === "vitest" ? "vitest" : "jest",
          suggestedTests:
            (pf as unknown as { testFileSuggestions?: string[] })
              .testFileSuggestions ?? [],
          mockImports:
            region?.externalPackages.map((pkg) => `vi.mock('${pkg}')`) ?? [],
        };
      },
    );
    const fileMetrics = computeFileMetrics(sourceCode, enrichedRegions);
    const updatedSource = generateUpdatedSource(
      lines,
      extractionCandidates,
      proposedFiles,
      fileName,
      effectiveCtx,
      filePath || fileName,
      directives,
    );
    const summary = buildSummary(
      enrichedRegions,
      extractionCandidates,
      proposedFiles,
      fileMetrics.technicalDebtMinutes,
    );

    const cacheStats: IncrementalCacheStats = {
      hitRate: regionCache.getStats().hitRate,
      totalHits: regionCache.getStats().totalHits,
      totalMisses: regionCache.getStats().totalMisses,
      cachedCount: cacheDiff.cached.size,
      dirtyCount: cacheDiff.dirty.size,
      graphDirty: cacheDiff.graphDirty,
      latencyMs: Date.now() - t0,
    };

    // ── Feature 3: Framework-specific smells (Vue / Angular / Svelte) ─────
    const detectedFramework = detectFrameworkKind(
      sourceCode,
      filePath || fileName,
    );
    const rawFrameworkSmells = detectFrameworkSmells(
      sourceCode,
      filePath || fileName,
    );
    const frameworkSmells: FrameworkSmellRecord[] = rawFrameworkSmells.map(
      (s) => ({
        name: s.name,
        severity: s.severity,
        description: s.description,
        recommendation: s.recommendation,
        autoFixable: s.autoFixable,
        framework: s.framework,
        line: s.line,
      }),
    );

    // ── Feature 1: Workspace merge suggestions ────────────────────────────
    const mergeSuggestions: RegionMergeSuggestions[] = [];
    if (workspaceGraph && extractionCandidates.length > 0) {
      for (const region of extractionCandidates) {
        const suggestions = mergeAdvisor.suggest(
          region.name,
          region.kind,
          [...region.usedSymbols],
          filePath || fileName,
          workspaceGraph,
          3,
        );
        if (suggestions.length > 0) {
          mergeSuggestions.push({
            regionId: region.id,
            regionName: region.name,
            suggestions,
          });
        }
      }
    }

    return {
      sourceFile: fileName,
      language,
      totalLines: lines.length,
      parseEngine: engineUsed,
      symbolTable,
      dependencyGraph,
      regions: enrichedRegions,
      retainedRegions,
      extractionCandidates,
      proposedFiles,
      summary,
      linkageMap,
      codeSmells,
      typeRouting,
      barrelExport,
      testFileSuggestions,
      circularRisks,
      criticalPathFiles,
      metrics: fileMetrics,
      updatedSourceContent: updatedSource,
      thresholdCalibration,
      cacheStats,
      frameworkSmells,
      detectedFramework,
      mergeSuggestions,
    };
  }
}

export const moduleSplitter = new ModuleSplitter();
