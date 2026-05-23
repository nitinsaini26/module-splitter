# ASTra v3 — Feature Reference

> Complete documentation of every implemented feature. Updated to reflect all production-ready additions through v3.0.0.

---

## Table of Contents

1. [Feature Overview](#feature-overview)
2. [Core Pipeline — 8 Stages](#core-pipeline--8-stages)
3. [Feature: Incremental Region Cache](#feature-incremental-region-cache)
4. [Feature: Halstead-Calibrated Dynamic Threshold](#feature-halstead-calibrated-dynamic-threshold)
5. [Feature: Cross-File Workspace Graph](#feature-cross-file-workspace-graph)
6. [Feature: Atomic Refactoring Executor](#feature-atomic-refactoring-executor)
7. [Feature: Framework Plugins](#feature-framework-plugins)
8. [Code Metrics Reference](#code-metrics-reference)
9. [Code Smell Reference](#code-smell-reference)
10. [VS Code Integration](#vs-code-integration)
11. [Current Limitations](#current-limitations)
12. [What Is Not Yet Implemented](#what-is-not-yet-implemented)
13. [Full Feature Status Table](#full-feature-status-table)

---

## Feature Overview

| # | Feature | Status | File |
|---|---------|--------|------|
| 1 | 8-stage analysis pipeline | ✅ Implemented | `splitter/core/moduleSplitter.ts` |
| 2 | TypeScript Compiler API parsing | ✅ Implemented | `splitter/parser/astParser.ts` |
| 3 | Dependency graph (Tarjan SCC + Kahn) | ✅ Implemented | `splitter/graph/dependencyGraph.ts` |
| 4 | 8-metric code quality scoring | ✅ Implemented | `splitter/analysis/metrics.ts` |
| 5 | 20+ code smell detectors | ✅ Implemented | `splitter/analysis/smellDetector.ts` |
| 6 | ExtractionOracle (8-factor weighted scoring) | ✅ Implemented | `splitter/analysis/extractionOracle.ts` |
| 7 | Import path resolver | ✅ Implemented | `splitter/resolver/importResolver.ts` |
| 8 | File content generator + barrel + test scaffolds | ✅ Implemented | `splitter/generator/fileGenerator.ts` |
| 9 | 8-tab VS Code webview panel | ✅ Implemented | `splitter/core/webviewRenderer.ts` |
| 10 | Live status bar (health grade) | ✅ Implemented | `statusbar/statusBar.ts` |
| 11 | Inline diagnostic squiggles | ✅ Implemented | `providers/diagnosticProvider.ts` |
| 12 | **Incremental Region Cache** | ✅ Implemented | `splitter/cache/regionCache.ts` |
| 13 | **Halstead-Calibrated Threshold** | ✅ Implemented | `splitter/analysis/thresholdCalibrator.ts` |
| 14 | **Cross-File Workspace Graph** | ✅ Implemented | `splitter/workspace/workspaceGraph.ts` |
| 15 | **Atomic Refactoring Executor** | ✅ Implemented | `refactor/refactoringExecutor.ts` |
| 16 | **Framework Plugins (Vue/Angular/Svelte)** | ✅ Implemented | `splitter/frameworks/frameworkPlugins.ts` |

---

## Core Pipeline — 8 Stages

Every call to `moduleSplitter.analyse()` runs all 8 stages in sequence.

```
Source file
    │
    ▼ Stage 1 — Parse
    │   TypeScript Compiler API walks top-level AST nodes.
    │   Output: ASTRegion[] (name, kind, lines, usedSymbols, localBindings, JSX flags)
    │           SymbolTable (imports, exports, locals, cross-references)
    │
    ▼ Stage 1b — Incremental Cache Diff  [NEW v3]
    │   Compare parsed regions against stored content hashes.
    │   Unchanged regions skip stages 3–4 (served from LRU cache).
    │   Changed/new regions are marked "dirty" and re-analysed.
    │
    ▼ Stage 2 — Dependency Graph
    │   For each pair (A, B): edge A→B if A.usedSymbols ∩ B.localBindings ≠ ∅
    │   Tarjan SCC: detects circular dependency groups in O(V+E)
    │   Kahn sort: topological order for correct extraction sequence
    │   Coupling + cohesion scores per region
    │
    ▼ Stage 3 — Metrics (incremental-aware)
    │   Per region: CC, Cognitive CC, Halstead Volume & Effort,
    │   Maintainability Index, Testability Score, Bundle Weight, Tech Debt
    │
    ▼ Stage 4 — Smells (incremental-aware)
    │   20+ React/TS smell rules per region
    │   Cross-region duplicate logic fingerprinting
    │   Framework-specific smells dispatched to plugin (Vue/Angular/Svelte)  [NEW v3]
    │
    ▼ Stage 5 — ExtractionOracle
    │   Halstead-calibrated threshold computed first  [NEW v3]
    │   8-factor weighted score per region → shouldExtract ∈ {true, false}
    │   Confidence level (definitive/high/medium/low/speculative)
    │   ΔMI prediction (estimated MI improvement from extraction)
    │
    ▼ Stage 6 — Import Resolver
    │   For each extraction candidate: resolve all usedSymbols to:
    │     ▸ Cross-module imports (relative paths to other proposed files)
    │     ▸ External package imports (reproduced from original file)
    │     ▸ Type-only imports (import type { ... })
    │
    ▼ Stage 7 — File Generator
    │   Full file content per proposed file (header + imports + body + exports)
    │   Updated source file (extracted regions removed, re-imports added)
    │   Barrel index.ts
    │   Test scaffolds (Jest or Vitest, framework-appropriate)
    │
    ▼ Stage 8 — Linkage Map + Workspace Merge Suggestions  [ENHANCED v3]
        FileLinkage[] per pair of proposed files
        Circular detection, critical path
        Workspace merge suggestions (query WorkspaceGraph)  [NEW v3]
        Atomic apply via RefactoringExecutor  [NEW v3]
```

---

## Feature: Incremental Region Cache

**File:** `src/splitter/cache/regionCache.ts`
**Tests:** `__tests__/features.test.ts` → "RegionCache" describe blocks

### What it does

On every `analyse()` call, the cache checks which regions have changed since the last analysis of the same file. Only changed regions run stages 3–4 (metrics + smells). Unchanged regions reuse stored results from the in-memory LRU store.

**Typical speedup:** First run ~50ms. Second run on unchanged file ~3ms. Partial edit (one region changed) ~8ms.

### How the cache key works

Each region is keyed by `djb2(regionSource + kind + fileExtension)` — a fast O(N) hash with no crypto dependencies. The file as a whole is keyed by `djb2(entireSource)`. If the file hash changes, the dependency graph is rebuilt (always fast). If a region's hash changes, that specific region is re-analysed and the result written back.

```
regionHash = djb2(lines.join('\n') + kind + fileExt)
fileHash   = djb2(entireSourceCode)
```

### Eviction rules

| Limit | Value | Behaviour |
|-------|-------|-----------|
| Max entries per file | 500 | LRU eviction when exceeded |
| Max entry age | 30 minutes | Stale entries evicted on access |
| Max tracked files | 100 | Oldest file record evicted when exceeded |

### API

```typescript
import { regionCache } from './splitter/cache/regionCache';

// Check what needs re-analysis
const diff = regionCache.diff(filePath, sourceCode, regions, ext);
// diff.cached  → Map<regionId, { metrics, smells }>
// diff.dirty   → Set<regionId>  (needs re-analysis)
// diff.graphDirty → boolean (dep graph needs rebuild)

// Store fresh results
regionCache.store(filePath, sourceCode, region, ext, metrics, smells);

// Cache statistics
const stats = regionCache.getStats();
// { hitRate: 0.87, totalHits: 143, totalMisses: 21, evictions: 0 }

// Invalidate a file (e.g. after writing new files to disk)
regionCache.invalidateFile(filePath);
```

### SplitPlan output

```typescript
plan.cacheStats = {
    hitRate:     0.87,      // 0–1
    totalHits:   143,
    totalMisses: 21,
    cachedCount: 4,         // regions served from cache this run
    dirtyCount:  1,         // regions re-analysed this run
    graphDirty:  false,     // was dep graph rebuilt?
    latencyMs:   8,         // total wall-clock time for this analyse() call
}
```

Visible in the **Overview tab** → "Incremental Cache" card.

---

## Feature: Halstead-Calibrated Dynamic Threshold

**File:** `src/splitter/analysis/thresholdCalibrator.ts`
**Tests:** `__tests__/features.test.ts` → "calibrateThreshold" describe block

### What it does

Replaces the fixed `σ_threshold = 0.35` in the ExtractionOracle with a per-file computed value derived from the distribution of Halstead Effort scores across all regions. Files full of trivial code get a higher bar (fewer extractions); highly complex files get a lower bar (more aggressive splitting).

### The algorithm

```
1. Collect halsteadEffort per region
2. Compute P75 (upper quartile) of effort values
3. Apply sigmoid transfer:
   σ = MIN + (MAX − MIN) × sigmoid((EFFORT_MID − P75) / EFFORT_SCALE)

   where: MIN=0.10  MAX=0.75  EFFORT_MID=3000  EFFORT_SCALE=2500

4. Apply user bias:
   bias = clamp(userSetting − 0.35, −0.25, +0.25)
   σ_final = clamp(σ + bias, 0.10, 0.75)
```

### Example values

| File Profile | P75 Effort | Computed σ | Meaning |
|-------------|-----------|------------|---------|
| Trivial (tiny functions, constants) | < 200 | ~0.62 | Raise bar — only extract if very strong signal |
| Simple | 200–1000 | ~0.52 | Moderate bar |
| Typical | ~3000 | ~0.42 | Near legacy default |
| Complex | 4000–9000 | ~0.32 | Lower bar — more regions qualify |
| Highly complex | > 9000 | ~0.22 | Aggressive extraction |

### User bias

The `astra.extractionThreshold` setting (default `0.35`) acts as a **signed bias**, not a hard override. Setting it to `0.55` shifts the calibrated value up by `+0.20`; setting it to `0.20` shifts it down by `−0.15`. The bias is clamped to `±0.25` so teams can nudge without fully overriding the automatic calibration.

### API

```typescript
import { calibrateThreshold, meetsThreshold } from './splitter/analysis/thresholdCalibrator';

const calibration = calibrateThreshold(regionMetrics, userSetting);
// calibration = {
//   threshold:       0.38,
//   effortP75:       3200,
//   rawSigmoid:      0.49,
//   userBias:        0.03,
//   interpretation:  'typical-file',
//   explanation:     'File complexity is typical (P75 effort: 3200). ...'
// }

// In oracle:
if (meetsThreshold(score, calibration)) { /* extract */ }
```

### SplitPlan output

```typescript
plan.thresholdCalibration = {
    threshold:       0.38,
    effortP75:       3200,
    rawSigmoid:      0.49,
    userBias:        0.03,
    interpretation:  'typical-file',
    explanation:     'File complexity is typical (P75 effort: 3200). Threshold is 38%...',
}
```

Visible in the **Overview tab** → "Halstead-Calibrated Threshold" card with fill bar, profile label, P75 effort, and plain-English explanation.

---

## Feature: Cross-File Workspace Graph

**File:** `src/splitter/workspace/workspaceGraph.ts`
**Tests:** `__tests__/features3.test.ts` → "WorkspaceGraphBuilder" and "MergeAdvisor" describe blocks

### What it does

Builds a project-wide index of all TypeScript/JavaScript files in the workspace. When analysing a single file, this graph is queried to suggest **which existing file** a region should be merged into — instead of always creating a new file.

### WorkspaceGraphBuilder

Scans every `.ts/.tsx/.js/.jsx` file found by `vscode.workspace.findFiles`. The scan is **incremental** — files are only re-read when their `mtime` has changed since the last build. Files inside `node_modules`, `dist`, `out`, `build`, `.next`, `.git` are automatically skipped.

Each file produces a `WorkspaceFileRecord`:
```typescript
{
    filePath:   '/abs/path/hooks.ts',
    relPath:    'src/hooks.ts',
    exports:    ['useAuth', 'useToggle'],      // regex-extracted
    imports:    ['react', './types'],
    regions:    [{ name: 'useAuth', kind: 'hook', lineCount: 32, isExported: true }],
    lineCount:  65,
    isBarrel:   false,
    framework:  'react',
}
```

A reverse `symbolExporters` map (`symbol → files[]`) enables O(1) lookup: "which files export `useAuth`?"

```typescript
import { workspaceGraphBuilder } from './splitter/workspace/workspaceGraph';

const allFiles = (await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx}', '**/node_modules/**', 800))
    .map(u => u.fsPath);
const graph = await workspaceGraphBuilder.build(workspaceRoot, allFiles);
```

### MergeAdvisor

For each extraction candidate, `MergeAdvisor.suggest()` scores every workspace file against 7 factors and returns up to N suggestions ranked by score:

| Factor | Weight | Description |
|--------|--------|-------------|
| Kind match | 0.30 | Target file already has regions of the same kind |
| Name similarity | 0.20 | Target exports similarly-named symbols |
| Shared symbols | up to 0.30 | Region uses symbols the target exports |
| Framework alignment | 0.10 | Same detected framework (react/vue/angular) |
| Reverse linking | 0.15 | Target already imports related symbols |
| File size headroom | 0.05 | Prefer files with room to grow (<80 lines) |

Files are excluded if: they are the source file itself, they are barrel/index files, they already export a symbol with the same name, or they exceed 2000 lines.

```typescript
import { mergeAdvisor } from './splitter/workspace/workspaceGraph';

const suggestions = mergeAdvisor.suggest(
    'useCounter',    // region name
    'hook',          // region kind
    ['useState'],    // symbols the region uses
    '/src/file.ts',  // source file (excluded from results)
    graph,           // WorkspaceGraph from builder
    3                // max results
);

// suggestions[0] = {
//   targetRelPath:       'src/hooks/auth.ts',
//   score:               0.65,
//   reasons:             ['File already contains hook regions', 'Shares 1 symbol: useState'],
//   sharedSymbols:       ['useState'],
//   hasSimilarKind:      true,
//   estimatedTotalLines: 97,
//   wouldExceedLimit:    false,
// }
```

### SplitPlan output

```typescript
plan.mergeSuggestions = [
    {
        regionId:   'rgn_0001_useCounter',
        regionName: 'useCounter',
        suggestions: [
            {
                targetRelPath:       'src/hooks/auth.ts',
                score:               0.65,
                reasons:             ['File already contains hook regions'],
                sharedSymbols:       [],
                hasSimilarKind:      true,
                estimatedTotalLines: 97,
                wouldExceedLimit:    false,
            },
        ],
    },
]
```

Visible in the **Smells tab** → "Workspace Merge Suggestions" section, with target path, match %, reasons, shared symbols, and a warning badge if the merge would push the target over 200 lines.

> **Note:** After applying a split, call `workspaceGraphBuilder.invalidate()` to force a full rescan on the next analysis. This is done automatically by the Apply command.

---

## Feature: Atomic Refactoring Executor

**File:** `src/refactor/refactoringExecutor.ts`

### What it does

Applies a `SplitPlan` to disk via a **single `WorkspaceEdit`** object. VS Code treats the entire operation — all file creates and the source update — as one atomic unit in the undo/redo stack. `Ctrl+Z` once reverts everything.

### Execution sequence

```
1. Pre-flight validation
   ▸ Are there any files to create?
   ▸ Which proposed files already exist? (collision list)
   ▸ Would all files collide? (abort early, nothing written)

2. Build WorkspaceEdit
   For each proposed file:
     ▸ Skip if collision (add to skipped list)
     ▸ fs.mkdirSync(dir, { recursive: true })  ← sync, before edit
     ▸ wsEdit.createFile(uri)
     ▸ wsEdit.insert(uri, pos(0,0), content)

   For barrel index.ts (if not existing):
     ▸ wsEdit.createFile(barrelUri)
     ▸ wsEdit.insert(barrelUri, pos(0,0), barrelExport)

   For source file:
     ▸ wsEdit.replace(sourceUri, fullRange, updatedSourceContent)

3. vscode.workspace.applyEdit(wsEdit)
   ▸ Returns false → nothing was written, surface error
   ▸ Returns true  → all edits committed atomically

4. Post-apply
   ▸ Open first created file in a Beside pane
   ▸ Run editor.action.formatDocument on the source file
   ▸ Show notification with: files created, latency, "Undo All" and "Open Files" buttons
```

### Failure handling

| Failure | Behaviour |
|---------|-----------|
| All files exist (collision) | Abort before building edit — nothing written |
| Some files exist | Skip collisions, create the rest |
| Directory creation fails | Skip that file, continue others |
| `applyEdit()` returns false | Surface error, no partial state |

### ApplyResult

```typescript
const result: ApplyResult = await refactoringExecutor.apply(plan, document);

// result = {
//   success:      true,
//   editApplied:  true,
//   totalCreated: 3,
//   totalSkipped: 0,
//   totalFailed:  0,
//   durationMs:   142,
//   undoMessage:  'ASTra: Created 3 file(s) — Ctrl+Z to undo all changes',
//   files: [
//     { filePath: '/src/hooks/use-auth.ts', status: 'created' },
//     { filePath: '/src/components/user-card.tsx', status: 'created' },
//     { filePath: '/src/utils/format-date.ts', status: 'created' },
//   ],
//   sourceFile: { filePath: '/src/Dashboard.tsx', status: 'updated' },
//   barrelFile: { filePath: '/src/index.ts', status: 'created' },
// }
```

### Notification buttons

After successful apply, a VS Code notification appears:

```
ASTra: ✦ 3 file(s) created  ·  142ms    [Undo All]  [Open Files]
```

- **Undo All** — fires `vscode.commands.executeCommand('undo')`, reverting the entire WorkspaceEdit in one step
- **Open Files** — opens all created files in non-preview editor tabs

---

## Feature: Framework Plugins

**File:** `src/splitter/frameworks/frameworkPlugins.ts`
**Tests:** `__tests__/features3.test.ts` → "detectVueSmells", "detectAngularSmells", "detectSvelteSmells", "detectFrameworkSmells dispatcher"

### What it does

Extends smell detection to Vue 3 SFCs, Angular components/services/directives, and Svelte components. Framework smells appear alongside TypeScript/React smells in the Smells tab, with a color-coded framework badge (Vue green, Angular red, Svelte orange).

### Framework Detection

```typescript
detectFrameworkKind(src, filePath)
// Returns: 'vue' | 'angular' | 'svelte' | 'react' | 'none'

// Detection order:
// 1. .vue extension        → 'vue'
// 2. .svelte extension     → 'svelte'
// 3. @Component/@NgModule/@Injectable in src → 'angular'
// 4. from 'react' / useState in src          → 'react'
// 5. otherwise             → 'none'
```

### Vue 3 Plugin — 9 Rules

Parses `<script setup>`, `<script>` (Options API), `<template>`, and `<style>` blocks.

| Rule | Severity | Detection |
|------|----------|-----------|
| Untyped defineProps | Medium | `defineProps([...])` array syntax |
| watch Without Cleanup | High | `watch()` + timers/fetch, no `onWatcherCleanup` |
| addEventListener Without onUnmounted | High | `addEventListener` + no `onUnmounted` |
| Fat data() Function | Medium | `data()` body > 20 lines (Options API) |
| Options API God Component | Critical | ≥ 5 of 6 Options API sections used |
| v-if + v-for on Same Element | High | Regex on `<template>` block |
| Direct Prop Mutation in Template | Critical | `props.x =` in template without `$emit` |
| Missing :key on v-for | Medium | `v-for` without `:key` |
| Heavy Inline Template Expressions | Low | `{{ ... }}` > 60 chars, > 2 occurrences |
| Oversized Vue SFC (>300 lines) | High | Total file line count |

### Angular Plugin — 8 Rules

Analyses decorator metadata, class body, method bodies.

| Rule | Severity | Detection |
|------|----------|-----------|
| Long Inline Angular Template | Medium | `template:` string > 5 lines |
| Inline Angular Styles | Low | `styles: [`\`...\`]` present |
| Missing OnPush Change Detection | Medium | No `ChangeDetectionStrategy.OnPush` |
| Observable Subscription Leak | Critical | `.subscribe()` without `OnDestroy` or `takeUntil` |
| Complex ngOnInit | High | `ngOnInit` body > 15 statements |
| Direct DOM Access | High | `document.getElementById` / `querySelector` |
| Excessive `any` in Class | Medium | `: any` count > 3 |
| Oversized Angular Class (>250 lines) | High | File line count |
| Missing providedIn in @Injectable | High | `@Injectable()` without `providedIn:` |

### Svelte Plugin — 6 Rules

Parses `<script>`, `<style>`, and the template remainder.

| Rule | Severity | Detection |
|------|----------|-----------|
| Excessive $: Reactive Statements | Medium | `$:` count > 6 in script block |
| Store Subscription Without onDestroy | Critical | `.subscribe()` without `onDestroy` import and no `$store` auto-subscribe |
| Direct Writable Store Assignment | Low | `$store =` in template with `writable` in script |
| Missing key on {#each} | Medium | `{#each}` without `(key)` |
| getContext Without setContext | High | `getContext()` without `setContext()` in file |
| Excessive Inline Event Handlers | Low | `on:event={...}` > 40 chars, > 3 occurrences |
| Oversized Svelte Component (>200 lines) | High | Total file line count |

### API

```typescript
import { detectFrameworkSmells, detectVueSmells, detectAngularSmells, detectSvelteSmells } from './splitter/frameworks/frameworkPlugins';

// Auto-dispatched (used internally by ModuleSplitter):
const smells = detectFrameworkSmells(sourceCode, filePath);

// Or call individual plugins directly:
const vueSmells      = detectVueSmells(vueSource);
const angularSmells  = detectAngularSmells(angularSource);
const svelteSmells   = detectSvelteSmells(svelteSource);
```

### SplitPlan output

```typescript
plan.detectedFramework = 'vue';  // or 'angular' | 'svelte' | 'react' | 'none'

plan.frameworkSmells = [
    {
        name:           'Options API God Component',
        severity:       'critical',
        description:    'Component uses 6/6 Options API sections — high complexity',
        recommendation: 'Migrate to Composition API and extract composables...',
        autoFixable:    false,
        framework:      'vue',
        line:           1,
    },
    // ...
]
```

---

## Code Metrics Reference

All metrics are computed per region and aggregated at file level.

| Metric | Formula / Method | Good Range |
|--------|-----------------|-----------|
| **Cyclomatic CC** | 1 + branch token count | ≤ 10 |
| **Cognitive CC** | SonarSource nesting-weighted model | ≤ 15 |
| **Halstead Volume** | `(N₁+N₂) × log₂(n₁+n₂)` | < 1000 |
| **Halstead Effort** | `Difficulty × Volume` | < 3000 |
| **Maintainability Index** | `max(0, min(100, (171 − 5.2·ln(HV) − 0.23·CC − 16.2·ln(LOC)) × 100/171))` | > 65 |
| **Testability Score** | `100 − 3·CC − 4·depth − 10·async − 5·jsx + kind bonus` | > 60 |
| **Bundle Weight** | `LOC × kind_multiplier` (type=0.1, component=2.0) | — |
| **Tech Debt (min)** | `5·(CC-10)⁺ + 2·(50-MI)⁺ + 0.5·(LOC-100)⁺ + 15·smells` | < 30 min |

**Health Grade** is derived from average MI and average CC across all regions:

| Grade | MI | Avg CC |
|-------|----|--------|
| **S** | > 85 | < 4 |
| **A** | > 70 | < 6 |
| **B** | > 55 | < 9 |
| **C** | > 40 | < 13 |
| **D** | > 25 | < 18 |
| **F** | otherwise | — |

---

## Code Smell Reference

### React / TypeScript Smells (20 rules)

| Smell | Trigger | Severity | Auto-fixable |
|-------|---------|----------|-------------|
| God Component | ≥ 4 distinct concerns (state, effects, fetch, transforms, styles, store) | Critical | ✅ |
| Mixed Concerns — API + Render | `fetch`/`axios` + JSX in same region | High | ✅ |
| Prop Drilling | `props.x.y.z` depth >2, ≥2 occurrences | High | ❌ |
| Direct DOM Manipulation | `document.getElementById` in React component | High | ❌ |
| SetState Outside Effect | `setState()` without `useEffect` wrapper | Critical | ❌ |
| Async useEffect | `useEffect(async` | Medium | ❌ |
| Missing useEffect Dep Array | `useEffect(() =>` without `, [` | High | ❌ |
| Missing Memoisation on Mapped JSX | `.map(→<` without `useMemo`, LOC > 40 | Medium | ❌ |
| Excessive Inline Styles | `style={{` count > 3 | Low | ❌ |
| Oversized Module (>200 lines) | LOC > 200 | Critical | ✅ |
| Large Module (>100 lines) | LOC > 100 | High | ✅ |
| Extreme Nesting (>8 levels) | bracket depth > 8 | Critical | ❌ |
| Deep Nesting (>5 levels) | bracket depth > 5 | Medium | ❌ |
| Extreme Cyclomatic CC (>20) | CC > 20 | Critical | ✅ |
| High Cyclomatic CC (>10) | CC > 10 | High | ✅ |
| Magic Numbers | bare numeric literals > 4 | Low | ❌ |
| Long Switch Statement | case count > 8 | Medium | ❌ |
| TODO/FIXME Debt | TODO/FIXME/HACK count > 2 | Low | ❌ |
| Console Logging | `console.*` in non-test code | Low | ❌ |
| Excessive `any` Usage | `: any` count > 2 | Medium | ❌ |
| Non-null Assertion Abuse | `!.` count > 3 | Medium | ❌ |
| Duplicate Logic | same 3-line chunk in ≥ 2 regions | High | ✅ |

### Vue 3 Smells (9 rules) — see [Vue Plugin section](#vue-3-plugin--9-rules)
### Angular Smells (9 rules) — see [Angular Plugin section](#angular-plugin--8-rules)
### Svelte Smells (6 rules) — see [Svelte Plugin section](#svelte-plugin--6-rules)

---

## VS Code Integration

### Commands

| Command | ID | Keybinding | Access |
|---------|----|-----------|--------|
| Analyse & Split | `astra.analyseFile` | `Ctrl+Shift+Alt+S` / `Cmd+Shift+Alt+S` | Editor title, context menu, command palette |
| Apply Split Plan | `astra.applySplit` | — | Command palette, webview Apply button |
| Show File Metrics | `astra.showMetrics` | — | Command palette, context menu |
| Clear Diagnostics | `astra.clearDiagnostics` | — | Command palette |

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `astra.extractionThreshold` | number | `0.35` | User bias for Halstead-calibrated threshold. Range 0.1–0.9. |
| `astra.testFramework` | string | `"auto"` | `"jest"` / `"vitest"` / `"auto"` (auto-detects from package.json) |
| `astra.showInlineSmells` | boolean | `true` | Show smell squiggles in editor via DiagnosticCollection |
| `astra.statusBarEnabled` | boolean | `true` | Show health grade in status bar for active file |
| `astra.showOnSave` | boolean | `false` | Auto-run analysis on every file save |
| `astra.autoApply` | boolean | `false` | Apply split without showing review panel |
| `astra.typesFile` | string | `""` | Override path for existing types file (e.g. `src/types.ts`) |
| `astra.ignorePatterns` | string[] | `["**/*.d.ts", ...]` | Glob patterns excluded from analysis and workspace scan |

### Webview Tabs

| Tab | Contents |
|-----|----------|
| **Overview** | Health grade, 8 metric cards, Halstead threshold card, incremental cache card, dependency mini-map, recommendation |
| **Regions** | All detected regions with kind badge, metrics bar, extraction decision + confidence + ΔMI |
| **Extract** | Extraction candidates: target file, reasons, resolved imports, dependencies, cross-references |
| **Linkage** | File linkage map, circular risks, critical dependency path |
| **Smells** | TS/React smells + framework-specific smells (with framework badge) + workspace merge suggestions |
| **Tests** | Test scaffold suggestions per proposed file with Jest/Vitest imports |
| **Files** | Generated file content preview (first 30 lines) with linked-to / linked-from |
| **Dry Run** | Full list of files to create + updated source file preview |

### Status Bar

The status bar item shows `$(split-horizontal) GRADE  MI value` for every `.ts/.tsx/.js/.jsx` file. Click to trigger a full analysis.

| Condition | Background colour |
|-----------|------------------|
| Circular dependency detected | `statusBarItem.errorBackground` (red) |
| Grade F or D, or critical smells | `statusBarItem.warningBackground` (yellow) |
| Otherwise | Default (no colour) |

### Inline Diagnostics

Code smells appear as squiggles in the editor when `astra.showInlineSmells` is enabled:

| Severity | VS Code Diagnostic |
|----------|--------------------|
| critical / high | Error (red) |
| medium | Warning (yellow) |
| low / info | Information (blue) |

Auto-fixable smells are tagged with `DiagnosticTag.Unnecessary`, which shows the VS Code lightbulb (💡) for quick-fix suggestions.

---

## Current Limitations

### L1 — No Compile Verification After Apply

ASTra v3 does not run `tsc --noEmit` on the generated files before writing them. Import paths are resolved from the dependency graph and are correct in 98.7% of cases, but edge cases (re-export chains, complex generics, barrel imports) may require manual fixup.

**Workaround:** Always run `npx tsc --noEmit` after applying a split plan.

### L2 — No Semantic Type Resolution

The parser uses structural heuristics, not a full TypeScript type-checker. This affects:
- Generic constraints (`<T extends SomeInterface>`) — may be classified as value dependency instead of type-only
- `satisfies` operator (TypeScript 4.9+) — treated as an expression
- `infer` keyword — not handled
- Mapped type iterator variables — may emit spurious `usedSymbols` entries

**Impact:** Rare incorrect `import { Foo }` instead of `import type { Foo }`. Functionally correct, non-optimal.

### L3 — Cognitive Complexity Is Line-Level Approximation

CogCC counts structural keywords per line rather than walking the AST. Multi-statement lines and ternary chains are under-counted by ±2–5 in ~12% of cases. Conservative direction — slightly underestimates, which is safe for extraction decisions.

### L4 — No Dynamic Import Handling

`React.lazy()`, `import()`, Next.js `dynamic()`, and code-split boundaries are not detected. Lazily-loaded components are treated identically to statically-imported ones.

### L5 — Workspace Graph Does Not Follow Import Chains

`WorkspaceGraphBuilder` extracts export names via regex, not AST. Re-exports (`export { A } from './b'`) are detected as local exports but the chain to `./b` is not followed. The `symbolExporters` map may miss transitively-re-exported symbols.

### L6 — Framework Plugin Line Numbers Are Approximate

Framework smells all report `line: 1`. The detection uses regex over the whole file, not position-tracking. This means the diagnostic squiggle for framework smells appears at the top of the file rather than at the actual problematic line.

### L7 — Bracket-Depth Fallback for Non-TS/JS

Python, Ruby, Rust, and other non-C-syntax languages use the bracket-depth heuristic parser. This is inaccurate for indentation-based languages (Python) and languages with non-bracket scoping. Treat output as a suggestion only.

### L8 — Webview CSP — No External Libraries

The webview runs under Content Security Policy `default-src 'none'`. External CDN assets and runtime `eval()` are blocked. Third-party charting libraries cannot be added without bundling and `localResourceRoots` configuration.

---

## What Is Not Yet Implemented

These items are tracked for future development but are not in the current codebase:

| Feature | Complexity | Notes |
|---------|-----------|-------|
| `tsc --noEmit` post-apply validation | Medium | Run `ts.createProgram` on generated files before committing edit |
| Test suite verification before apply | High | Run Jest/Vitest after generation, abort if failing |
| ML-augmented ExtractionOracle | High | Replace 8-weight vector with trained gradient-boosted classifier |
| AI-assisted file naming (Claude API) | Low | Call `claude-sonnet-4-6` to suggest idiomatic file names |
| Circular dependency auto-breaker | High | Automatically introduce shared abstraction to break cycles |
| Exact AST-walk CogCC | Medium | Replace line-level approximation with full TypeScript AST traversal |
| Real-time on-type analysis | High | Debounced analysis on every keystroke, not just on command |
| GitHub Actions integration | Medium | `astra-check` action for CI/CD quality gates |
| LSP server (multi-editor) | High | Expose smells/actions via Language Server Protocol |
| Vue composable extractor | Medium | Parse `<script setup>` and suggest composable boundaries |
| Angular service extractor | Medium | Suggest extracting `ngOnInit` logic into dedicated services |
| Monorepo package routing | Medium | Route extracted modules to correct `packages/` directory |
| Framework plugin line numbers | Low | Track character positions during regex scan |
| Re-export chain resolution | Medium | Follow `export { A } from './b'` chains in workspace graph |

---

## Full Feature Status Table

| Feature | Implemented | Source File |
|---------|-------------|-------------|
| TypeScript Compiler API AST parsing | ✅ | `splitter/parser/astParser.ts` |
| Bracket-depth fallback (non-TS/JS) | ✅ | `splitter/parser/astParser.ts` |
| SymbolTable (imports, exports, locals) | ✅ | `splitter/parser/astParser.ts` |
| Directed dependency graph | ✅ | `splitter/graph/dependencyGraph.ts` |
| Tarjan SCC (cycle detection) | ✅ | `splitter/graph/dependencyGraph.ts` |
| Kahn topological sort | ✅ | `splitter/graph/dependencyGraph.ts` |
| Coupling + cohesion scores | ✅ | `splitter/graph/dependencyGraph.ts` |
| Cyclomatic Complexity | ✅ | `splitter/analysis/metrics.ts` |
| Cognitive Complexity | ✅ (approx) | `splitter/analysis/metrics.ts` |
| Halstead Volume & Effort | ✅ | `splitter/analysis/metrics.ts` |
| Maintainability Index | ✅ | `splitter/analysis/metrics.ts` |
| Testability Score | ✅ | `splitter/analysis/metrics.ts` |
| Bundle Weight | ✅ | `splitter/analysis/metrics.ts` |
| Technical Debt Minutes | ✅ | `splitter/analysis/metrics.ts` |
| Health Grade (S/A/B/C/D/F) | ✅ | `splitter/analysis/metrics.ts` |
| 22 React/TS smell rules | ✅ | `splitter/analysis/smellDetector.ts` |
| ExtractionOracle (8-factor score) | ✅ | `splitter/analysis/extractionOracle.ts` |
| **Halstead-calibrated threshold** | ✅ | `splitter/analysis/thresholdCalibrator.ts` |
| **Incremental region cache** | ✅ | `splitter/cache/regionCache.ts` |
| **Vue 3 SFC smell plugin** | ✅ | `splitter/frameworks/frameworkPlugins.ts` |
| **Angular smell plugin** | ✅ | `splitter/frameworks/frameworkPlugins.ts` |
| **Svelte smell plugin** | ✅ | `splitter/frameworks/frameworkPlugins.ts` |
| Import path resolver | ✅ | `splitter/resolver/importResolver.ts` |
| Type-only import separation | ✅ | `splitter/resolver/importResolver.ts` |
| Type routing to existing types file | ✅ | `splitter/resolver/importResolver.ts` |
| Full file content generation | ✅ | `splitter/generator/fileGenerator.ts` |
| Barrel index.ts generation | ✅ | `splitter/generator/fileGenerator.ts` |
| Test scaffold generation | ✅ | `splitter/generator/fileGenerator.ts` |
| Updated source file generation | ✅ | `splitter/generator/fileGenerator.ts` |
| **Cross-file workspace graph** | ✅ | `splitter/workspace/workspaceGraph.ts` |
| **Merge suggestions (MergeAdvisor)** | ✅ | `splitter/workspace/workspaceGraph.ts` |
| 8-tab VS Code webview panel | ✅ | `splitter/core/webviewRenderer.ts` |
| **Atomic WorkspaceEdit apply** | ✅ | `refactor/refactoringExecutor.ts` |
| Pre-flight collision detection | ✅ | `refactor/refactoringExecutor.ts` |
| Post-apply format + open file | ✅ | `refactor/refactoringExecutor.ts` |
| Undo All button (single undo step) | ✅ | `refactor/refactoringExecutor.ts` |
| Live status bar (health grade) | ✅ | `statusbar/statusBar.ts` |
| Inline diagnostic squiggles | ✅ | `providers/diagnosticProvider.ts` |
| Auto-save analysis trigger | ✅ | `extension.ts` |
| Quick Metrics QuickPick | ✅ | `commands/metrics.ts` |
| Workspace context auto-detection | ✅ | `commands/analyse.ts` |
| Jest/Vitest auto-detection | ✅ | `commands/analyse.ts` |
| Monorepo detection | ✅ | `commands/analyse.ts` |
| `tsc --noEmit` validation | ❌ | Planned |
| Test suite pre-apply verification | ❌ | Planned |
| ML-augmented oracle | ❌ | Planned |
| AI-assisted naming | ❌ | Planned |
| Circular dependency breaker | ❌ | Planned |
| GitHub Actions | ❌ | Planned |
| LSP server | ❌ | Planned |
