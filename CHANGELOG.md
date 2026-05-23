# Changelog — ASTra v3 Module Splitter

All notable changes to the `astra-extension` repository.

---

## [3.0.0] — 2026-05-17

### Added — Core Pipeline
- 8-stage analysis pipeline: parse → graph → metrics → smells → oracle → resolve → generate → link
- TypeScript Compiler API AST parsing (`src/splitter/parser/astParser.ts`)
- Tarjan SCC + Kahn topological sort for intra-file dependency graph
- 8 code quality metrics per region (CC, CogCC, Halstead Volume & Effort, MI, Testability, Bundle Weight, Tech Debt)
- 22 React/TypeScript smell rules
- ExtractionOracle: 8-factor weighted scoring with confidence levels and ΔMI prediction
- Complete import path resolver with type-only import separation
- Full file content generation, barrel `index.ts`, test scaffolds, updated source file
- 8-tab VS Code webview panel (Overview, Regions, Extract, Linkage, Smells, Tests, Files, Dry Run)

### Added — Feature: Incremental Region Cache
- `src/splitter/cache/regionCache.ts` — djb2 content-hash keyed LRU cache
- Per-region cache keyed by `djb2(source + kind + ext)`, file hash for graph invalidation
- Eviction: max 500 entries/file, 30-minute TTL, max 100 tracked files
- `plan.cacheStats` — hitRate, cachedCount, dirtyCount, graphDirty, latencyMs

### Added — Feature: Halstead-Calibrated Dynamic Threshold
- `src/splitter/analysis/thresholdCalibrator.ts` — replaces fixed σ = 0.35
- P75 of Halstead Effort → sigmoid transfer → per-file σ_threshold ∈ [0.10, 0.75]
- User setting acts as signed bias clamped to ±0.25
- `plan.thresholdCalibration` — threshold, effortP75, interpretation, explanation

### Added — Feature: Cross-File Workspace Graph
- `src/splitter/workspace/workspaceGraph.ts` — incremental workspace file scanner
- `WorkspaceGraphBuilder` — scans up to 800 files, mtime-based incremental rescan
- `MergeAdvisor` — 7-factor scoring to suggest merging into existing files
- `plan.mergeSuggestions` — ranked merge targets with reasons and shared symbols

### Added — Feature: Atomic Refactoring Executor
- `src/refactor/refactoringExecutor.ts` — single `WorkspaceEdit` for all file ops
- Pre-flight collision detection, directory creation, apply result reporting
- Post-apply: open first created file, format source document
- Notification with Undo All (single Ctrl+Z) and Open Files buttons

### Added — Feature: Framework Plugins
- `src/splitter/frameworks/frameworkPlugins.ts`
- Vue 3 SFC: 9 rules (v-if+v-for, watch cleanup, Options API God Component, etc.)
- Angular: 9 rules (OnPush, subscription leaks, ngOnInit complexity, etc.)
- Svelte: 6 rules ($: abuse, store cleanup, missing {#each} key, etc.)
- `plan.frameworkSmells` + `plan.detectedFramework`

### Added — VS Code Integration
- Status bar: live health grade with error/warning background colours
- Inline diagnostic squiggles via `DiagnosticCollection`
- Quick Metrics QuickPick command
- Auto-detect Jest/Vitest, package manager, monorepo structure
- `.vscode/launch.json` — 6 debug configurations + 1 compound
- `.vscode/tasks.json` — 12 tasks (compile, watch, test, lint, package, install)
- `.vscode/settings.json` — workspace TypeScript and editor settings
- `.vscode/extensions.json` — recommended contributor extensions

### Changed
- Repo renamed from `DEV-TOOLKIT` to `astra-extension`
- All GitHub URLs updated to `github.com/NK2552003/astra-extension`
- Command prefix changed from `devToolkit.*` to `astra.*`
- Settings prefix changed from `devToolkit.splitter.*` to `astra.*`

### Tests
- 144 tests across 3 test suites (pipeline, features, features3)
- All suites passing; test tsconfig relaxes `noImplicitAny` for test files only
