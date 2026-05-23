/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Adaptive Semantic Tree Restructuring Algorithm                 ║
 * ║  Core Type System                                                           ║
 * ║                                                                             ║
 * ║  All shared types for the module splitter pipeline.                        ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

// ─────────────────────────────────────────────────────────────────────────────
// Region classification
// ─────────────────────────────────────────────────────────────────────────────

export type RegionKind =
    | 'react-component'
    | 'hook'
    | 'utility-function'
    | 'class'
    | 'type-block'
    | 'constant-block'
    | 'export-group'
    | 'context-provider'
    | 'hoc'
    | 'enum'
    | 'namespace'
    | 'decorator'
    | 'unknown';

export type Confidence = 'definitive' | 'high' | 'medium' | 'low' | 'speculative';
export type Severity   = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ParseEngine = 'typescript-ast' | 'bracket-depth-fallback';
export type HealthGrade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

// ─────────────────────────────────────────────────────────────────────────────
// Symbol Table — produced by the symbol resolver
// ─────────────────────────────────────────────────────────────────────────────

export interface SymbolEntry {
    /** Canonical name of the symbol (e.g. "useAuth", "UserCard") */
    name: string;
    /** Which region declares this symbol */
    declaredInRegionId: string;
    /** Whether the symbol is exported at the file level */
    isExported: boolean;
    /** Whether this is a default export */
    isDefaultExport: boolean;
    /** Union of every region ID that references this symbol */
    referencedByRegionIds: Set<string>;
    /** Symbol kind: type, value, both */
    namespace: 'type' | 'value' | 'both';
    /** Originating import specifier if the symbol is re-exported */
    sourceImport?: string;
}

export interface SymbolTable {
    /** All locally-declared symbols */
    locals: Map<string, SymbolEntry>;
    /** All import-resolved symbols { specifier → local alias } */
    imports: Map<string, ImportRecord>;
    /** Symbols used in the file but never declared / imported (unresolved) */
    unresolved: Set<string>;
}

export interface ImportRecord {
    /** Module specifier, e.g. 'react', '../utils/format' */
    specifier: string;
    /** Named imports: import { A, B as C } → [{name:'A',alias:'A'},{name:'B',alias:'C'}] */
    named: Array<{ name: string; alias: string }>;
    /** Default import alias */
    defaultAlias?: string;
    /** Namespace import alias: import * as X */
    namespaceAlias?: string;
    /** Side-effect only: import 'foo/styles.css' */
    isSideEffect: boolean;
    /** Start line (1-based) */
    line: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST Region — raw output of the parser
// ─────────────────────────────────────────────────────────────────────────────

export interface ASTRegion {
    id: string;
    kind: RegionKind;
    name: string;
    startLine: number;   // 1-based inclusive
    endLine: number;     // 1-based inclusive
    lines: string[];
    isExported: boolean;
    isDefaultExport: boolean;
    hasJSX: boolean;
    hasHooks: boolean;
    hasAsyncOps: boolean;
    /** Names of all locally-declared sub-symbols (params, vars, etc.) */
    localBindings: Set<string>;
    /** Names used inside this region — resolved against SymbolTable later */
    usedSymbols: Set<string>;
    /** JSDoc / leading comment text */
    leadingComment?: string;
    /** Nesting depth of brackets at deepest point (from parser) */
    maxBracketDepth: number;
    /** AI-enriched metadata (optional, added post-parse) */
    aiNotes?: string;
    aiConfidence?: number;
}

export interface ASTParseResult {
    regions: ASTRegion[];
    symbolTable: SymbolTable;
    parseErrors: string[];
    engineUsed: ParseEngine;
    aiEnhanced: boolean;
    aiModel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency Graph — produced by the DependencyGraphBuilder
// ─────────────────────────────────────────────────────────────────────────────

export interface DependencyEdge {
    from: string;          // region id
    to: string;            // region id
    symbols: string[];     // which symbols flow across this edge
    strength: number;      // 0–1  (used for coupling score & partitioning)
    isTypeOnly: boolean;   // only type imports → removable at runtime
    isCyclic: boolean;
}

export interface DependencyGraph {
    /** All edges in the dependency graph */
    edges: DependencyEdge[];
    /** Topologically sorted region ids (Kahn's algorithm) */
    topologicalOrder: string[];
    /** Strongly Connected Components (Tarjan's SCC) — each SCC with >1 member is a cycle */
    sccs: string[][];
    /** Raw adjacency list for O(1) neighbour lookup */
    adjacency: Map<string, Set<string>>;
    /** Reverse adjacency list for O(1) dependent lookup */
    reverseAdjacency: Map<string, Set<string>>;
    /** Coupling score per region (sum of edge strengths) */
    couplingScores: Map<string, number>;
    /** Cohesion score per region (internal edge weight / total possible) */
    cohesionScores: Map<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enriched Region — after metrics, dependency graph, and smell analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface CodeSmell {
    name: string;
    severity: Severity;
    description: string;
    affectedRegionIds: string[];
    recommendation: string;
    autoFixable: boolean;
}

export interface RegionMetrics {
    lineCount: number;
    codeLines: number;
    commentLines: number;
    blankLines: number;
    cyclomaticComplexity: number;
    /** Exact AST-walk cognitive complexity (SonarSource model — replaces line-level approximation) */
    cognitiveComplexity: number;
    nestingDepth: number;
    maintainabilityIndex: number;
    halsteadVolume: number;
    halsteadEffort: number;
    bundleWeight: number;
    testabilityScore: number;
    /** LCOM4 cohesion score (only populated for class/object regions; undefined otherwise) */
    lcom4?: number;
    /** Tight Class Cohesion ∈ [0,1] (only for class regions) */
    tcc?: number;
    /** Loose Class Cohesion ∈ [0,1] (only for class regions) */
    lcc?: number;
    /** Per-function Halstead-calibrated extraction threshold (overrides file-level σ) */
    perFunctionThreshold?: number;
}

export interface EnrichedRegion extends ASTRegion {
    metrics: RegionMetrics;
    smells: CodeSmell[];
    /** Symbols declared in this region that are used by other regions */
    exportedSymbols: string[];
    /** Symbols from other regions that this region consumes */
    importedSymbols: string[];
    /** All imports from external packages (node_modules) used here */
    externalPackages: string[];
    /** Inline types/interfaces declared within this region */
    inlineTypeNames: string[];
    /** Whether this export is referenced nowhere in the rest of the file */
    isDeadExport: boolean;
    /** Extraction decision produced by ExtractionOracle */
    extractionDecision: ExtractionDecision;
    /** Partition group assigned by GraphPartitioner */
    partitionGroup?: string;
}

export interface ExtractionDecision {
    shouldExtract: boolean;
    reasons: string[];
    confidence: Confidence;
    /** Estimated improvement to MI if extracted */
    miDelta: number;
    /** Suggested target file name (relative) */
    suggestedFileName: string;
    /** Suggested directory bucket */
    suggestedDir: 'components' | 'hooks' | 'utils' | 'services' | 'hoc' | 'constants' | 'types' | 'providers';
}

// ─────────────────────────────────────────────────────────────────────────────
// File linkage — after splitting
// ─────────────────────────────────────────────────────────────────────────────

export interface FileLinkage {
    from: string;     // proposed file name
    to: string;       // proposed file name
    symbols: string[];
    isCircular: boolean;
    isCriticalPath: boolean;   // on the longest dependency chain
    edgeWeight: number;        // sum of usage counts
}

export interface TypeRouting {
    typeNames: string[];
    targetFile: string;
    reason: string;
    isNewFile: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposed File — the output unit
// ─────────────────────────────────────────────────────────────────────────────

export interface ProposedFile {
    fileName: string;            // e.g. "hooks/useAuth.ts"
    sourceRegionId: string;
    regionName: string;
    estimatedLines: number;
    /** Fully-resolved import statements needed by this file */
    resolvedImports: string[];
    /** Generated export statement(s) */
    exportStatements: string[];
    /** Complete, ready-to-write file content */
    generatedContent: string;
    /** Interface describing component props (if applicable) */
    propInterface?: string;
    /** Files this proposed file imports from */
    linkedTo: string[];
    /** Files that import from this proposed file */
    linkedFrom: string[];
    /** Whether this file routes to an existing workspace file */
    routedToExisting?: string;
    /** Suggested test file path */
    testFilePath: string;
    /** Suggested barrel entry line */
    barrelEntry: string;
    /** Whether original file has a corresponding test already */
    hasExistingTest: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Split Plan — the final output
// ─────────────────────────────────────────────────────────────────────────────

export interface FileMetrics {
    totalLines: number;
    codeLines: number;
    blankLines: number;
    commentLines: number;
    avgCyclomaticComplexity: number;
    maxCyclomaticComplexity: number;
    avgCognitiveComplexity: number;
    avgNestingDepth: number;
    maxNestingDepth: number;
    maintainabilityIndex: number;
    halsteadVolume: number;
    bundleImpactScore: number;
    duplicateLogicRisk: number;
    technicalDebtMinutes: number;
    overallHealth: HealthGrade;
}

export interface SplitSummary {
    totalRegions: number;
    extractionCount: number;
    retainedCount: number;
    typeRoutingCount: number;
    overallComplexity: 'simple' | 'moderate' | 'complex' | 'highly-complex';
    recommendation: string;
    estimatedRefactorMinutes: number;
    dryRunPreview: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Threshold calibration — produced by Halstead-calibrated threshold engine
// ─────────────────────────────────────────────────────────────────────────────

export interface ThresholdCalibration {
    threshold:      number;
    effortP75:      number;
    rawSigmoid:     number;
    userBias:       number;
    interpretation: 'trivial-file' | 'simple-file' | 'typical-file' | 'complex-file' | 'highly-complex-file';
    explanation:    string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache stats — produced by incremental region cache
// ─────────────────────────────────────────────────────────────────────────────

export interface IncrementalCacheStats {
    hitRate:      number;   // 0–1
    totalHits:    number;
    totalMisses:  number;
    cachedCount:  number;   // regions served from cache this run
    dirtyCount:   number;   // regions re-analysed this run
    graphDirty:   boolean;  // whether dep graph was rebuilt
    latencyMs:    number;   // total analysis time for this file
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace merge suggestions — cross-file graph feature
// ─────────────────────────────────────────────────────────────────────────────

export interface MergeSuggestion {
    targetFilePath:      string;
    targetRelPath:       string;
    score:               number;
    reasons:             string[];
    sharedSymbols:       string[];
    hasSimilarKind:      boolean;
    alreadyLinked:       boolean;
    estimatedTotalLines: number;
    wouldExceedLimit:    boolean;
}

export interface RegionMergeSuggestions {
    regionId:    string;
    regionName:  string;
    suggestions: MergeSuggestion[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Framework smell — produced by framework plugins (Vue/Angular/Svelte)
// ─────────────────────────────────────────────────────────────────────────────

export interface FrameworkSmellRecord {
    name:           string;
    severity:       Severity;
    description:    string;
    recommendation: string;
    autoFixable:    boolean;
    framework:      'vue' | 'angular' | 'svelte';
    line:           number;
}

export interface SplitPlan {
    sourceFile: string;
    language: string;
    totalLines: number;
    parseEngine: ParseEngine;
    symbolTable: SymbolTable;
    dependencyGraph: DependencyGraph;
    regions: EnrichedRegion[];
    retainedRegions: EnrichedRegion[];
    extractionCandidates: EnrichedRegion[];
    proposedFiles: ProposedFile[];
    summary: SplitSummary;
    linkageMap: FileLinkage[];
    codeSmells: CodeSmell[];
    typeRouting: TypeRouting[];
    barrelExport: string;
    testFileSuggestions: TestFileSuggestion[];
    circularRisks: string[];
    criticalPathFiles: string[];
    metrics: FileMetrics;
    updatedSourceContent: string;
    thresholdCalibration: ThresholdCalibration;
    cacheStats: IncrementalCacheStats;
    /** Cross-file merge suggestions — populated when workspace graph is available */
    mergeSuggestions: RegionMergeSuggestions[];
    /** Framework-specific smells (Vue/Angular/Svelte) */
    frameworkSmells: FrameworkSmellRecord[];
    /** Which framework was detected */
    detectedFramework: 'vue' | 'angular' | 'svelte' | 'react' | 'none';
}

export interface TestFileSuggestion {
    sourceFile: string;
    testFile: string;
    framework: 'jest' | 'vitest';
    suggestedTests: string[];
    mockImports: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace context
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspaceContext {
    existingTypeFiles: string[];
    existingHookFiles: string[];
    existingUtilFiles: string[];
    existingIndexFiles: string[];
    existingTestFiles: string[];
    sourceDir: string;
    testFramework: 'jest' | 'vitest' | 'unknown';
    packageManager: 'npm' | 'yarn' | 'pnpm' | 'unknown';
    isMonorepo: boolean;
    tsConfig?: Record<string, unknown>;
}
