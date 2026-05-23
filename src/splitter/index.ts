// ASTra v3 Splitter Engine — barrel re-export
export { ModuleSplitter, moduleSplitter } from "./core/moduleSplitter";
export { renderSplitPlanHtml } from "./core/webviewRenderer";
export { parseSourceFile } from "./parser/astParser";
export {
  applyFunctionLevelSplit,
  trySplitRegion,
} from "./parser/functionSplitter";
export { buildDependencyGraph } from "./graph/dependencyGraph";
export { computeRegionMetrics, computeFileMetrics } from "./analysis/metrics";
export {
  cognitiveComplexityExact,
  cognitiveComplexityForNode,
} from "./analysis/cognitiveComplexityExact";
export { computeLCOM4 } from "./analysis/lcom4";
export {
  calibratePerFunction,
  getRegionThreshold,
} from "./analysis/perFunctionCalibrator";
export {
  buildCoChangeRecordsFromGit,
  buildCoChangeRecordsFromHistories,
  collectRegionHistoriesFromGit,
} from "./analysis/coChangeDetector";
export { detectRegionSmells, detectFileSmells } from "./analysis/smellDetector";
export { evaluateExtraction } from "./analysis/extractionOracle";
export {
  calibrateThreshold,
  meetsThreshold,
} from "./analysis/thresholdCalibrator";
export { regionCache, RegionCache } from "./cache/regionCache";
export { resolveImports } from "./resolver/importResolver";
export {
  generateFileContent,
  buildBarrelFile,
} from "./generator/fileGenerator";
export {
  workspaceGraphBuilder,
  mergeAdvisor,
  WorkspaceGraphBuilder,
  MergeAdvisor,
} from "./workspace/workspaceGraph";
export {
  reExportChainResolver,
  ReExportChainResolver,
  extractReExports,
} from "./workspace/reExportChainResolver";
export {
  detectFrameworkSmells,
  detectFrameworkKind,
  detectVueSmells,
  detectAngularSmells,
  detectSvelteSmells,
} from "./frameworks/frameworkPlugins";
export {
  semanticTypeResolver,
  SemanticTypeResolver,
} from "./semantic/semanticTypeResolver";
export * from "./utils/helpers";
export type * from "./types";
