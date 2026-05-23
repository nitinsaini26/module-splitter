# ASTra v3 — How It Works

> A complete walkthrough of the Adaptive Semantic Tree Restructuring pipeline — from raw source file to fully-wired split modules.

---

## The Core Problem It Solves

You open a file. It has 400 lines. Somewhere inside: a React component, two custom hooks, a utility function, three TypeScript interfaces, and a constant object. Everything works — but it's a maintenance nightmare. Tests are hard to write. Refactoring breaks things unpredictably. Bundle size is larger than it should be.

**ASTra v3 reads that file and tells you exactly how to split it — with the correct import statements already written, the test stubs already scaffolded, and a barrel `index.ts` ready to drop in.**

---

## The 8-Stage Pipeline

Every time you run ASTra v3 on a file, it executes 8 stages in sequence. Each stage feeds the next. Nothing is guessed — every decision traces back to structural evidence from your actual code.

```
Source File
    │
    ▼ Stage 1 ─────── Parse
    │                  TypeScript Compiler API walks the AST
    │                  → ASTRegion[] (named structural units)
    │                  → SymbolTable (all imports, exports, locals)
    │
    ▼ Stage 2 ─────── Graph
    │                  For each region: which symbols does it use from other regions?
    │                  → Directed dependency graph (edges + weights)
    │                  → Tarjan SCC (find circular dependency groups)
    │                  → Kahn sort (correct extraction order)
    │
    ▼ Stage 3 ─────── Metrics
    │                  Per region: CC, Cognitive CC, Halstead, MI, Testability
    │                  Per file: aggregate + health grade
    │
    ▼ Stage 4 ─────── Smells
    │                  20+ pattern rules: God Component, Prop Drilling, Async useEffect…
    │                  Cross-region: duplicate logic fingerprinting
    │
    ▼ Stage 5 ─────── Oracle
    │                  8-factor weighted score per region → shouldExtract ∈ {true,false}
    │                  Confidence level + predicted ΔMI
    │
    ▼ Stage 6 ─────── Resolve
    │                  For every extracted region: resolve all used symbols
    │                  → correct relative import paths to other proposed files
    │                  → external package imports carried over from original
    │                  → type-only imports separated
    │
    ▼ Stage 7 ─────── Generate
    │                  Full file content per proposed file (header + imports + body)
    │                  Updated source file (extracted regions removed, re-imports added)
    │                  Barrel index.ts
    │                  Test scaffolds (Jest or Vitest)
    │
    ▼ Stage 8 ─────── Link
                       FileLinkage[] — which proposed file imports from which
                       Circular detection (pre-existing cycles surfaced, never new ones introduced)
                       Critical path (longest dependency chain across proposed files)
```

---

## Stage 1: Parsing — What Gets Detected

ASTra v3 uses the **TypeScript Compiler API** (`ts.createSourceFile` + `ts.forEachChild`) to walk the top-level statements of your file. It does not guess from text patterns — it uses the actual AST.

Every top-level declaration becomes an `ASTRegion`:

```
Region = {
  id           unique ID (e.g. rgn_000a_useAuth)
  kind         react-component | hook | hoc | context-provider |
               utility-function | class | type-block | constant-block |
               enum | namespace | decorator | unknown
  name         the declared name
  startLine    first line (1-based)
  endLine      last line (1-based)
  usedSymbols  every identifier referenced inside this region
  localBindings every identifier declared inside this region
  hasJSX       true if JSX elements exist inside
  hasHooks     true if use* calls exist inside
  hasAsyncOps  true if async/await or .then() exist inside
  maxBracketDepth  deepest nesting level (bracket count)
}
```

**Kind classification uses three signals:**

| Signal | Example | Kind assigned |
|--------|---------|--------------|
| Name starts with `use` + capital | `useAuth`, `useToggle` | `hook` |
| Name starts with `with` + capital | `withAuth`, `withTheme` | `hoc` |
| Name ends with `Provider` | `AuthProvider`, `ThemeProvider` | `context-provider` |
| Capital first letter + JSX found inside | `UserCard`, `Dashboard` | `react-component` |
| AST node type is `ClassDeclaration` | `class ApiService` | `class` |
| AST node type is `InterfaceDeclaration` or `TypeAliasDeclaration` | `type UserId`, `interface User` | `type-block` |
| AST node type is `EnumDeclaration` | `enum Status` | `enum` |
| ALL_CAPS name or simple literal assignment | `MAX_RETRIES = 3` | `constant-block` |
| Everything else | `formatDate`, `parseQuery` | `utility-function` |

**SymbolTable** is built alongside:
- Every `import` statement is parsed into an `ImportRecord` (named imports, default, namespace, side-effect)
- Every declared region name is registered as a `SymbolEntry` with its `referencedByRegionIds`
- Cross-referencing `usedSymbols` against `locals` wires up which regions depend on which

For non-TypeScript files (`.py`, `.java`, `.go`, etc.), a **bracket-depth fallback** parser is used instead — it uses regex patterns and brace counting to approximate regions.

---

## Stage 2: Dependency Graph — Who Needs What

For every pair of regions (A, B), ASTra v3 checks:

> Does A use any symbol that is declared in B?

If yes, a directed edge `A → B` is created with:
- `symbols` — the specific names that flow across
- `strength` — a weight in [0, 1] based on how many symbols and what kind B is
- `isTypeOnly` — true if only TypeScript types flow (safe to strip at runtime)

**Edge weight calculation:**
```
strength = min(1, symbol_count × 0.2 × kind_multiplier)

kind_multiplier:
  hook              → 1.4  (hooks are tightly coupled)
  context-provider  → 1.3
  utility-function  → 0.9
  type-block        → 0.3  (types are erased at runtime — loose coupling)
  others            → 1.0
```

**Tarjan's SCC** then finds all Strongly Connected Components in O(V+E). Any SCC with more than one member is a circular dependency group. Those edges get marked `isCyclic = true`.

**Kahn's Algorithm** produces a topological order — the correct sequence for extraction so that dependencies are always created before dependents.

**Coupling score** per region = sum of edge strengths incident on that region. High coupling means many things depend on it — a candidate for extraction.

**Cohesion score** = how self-contained a region is (ratio of used symbols that are locally declared).

---

## Stage 3: Metrics — Measuring What You Can't See

ASTra v3 computes 8 metrics per region:

### Cyclomatic Complexity (McCabe 1976)
Counts the number of independent execution paths. Starts at 1, increments for every `if`, `else`, `for`, `while`, `switch`, `case`, `catch`, `??`, `?.`, `&&`, `||`.

```
CC = 1 + branches

Good: CC ≤ 5
Warn: CC 6–10
Bad:  CC > 10
```

### Cognitive Complexity (SonarSource 2018)
A nesting-aware variant. A deeply-nested `if` costs more than a flat one:

```
for each structural keyword (if, for, while, function):
  score += 1 + current_nesting_depth

for each flat keyword (else, case):
  score += 1

for each boolean connector (&&, ||, !):
  score += 1
```

A triple-nested `if` costs `1+2+3=6`. Three flat `if`s cost `3`. Same branch count, very different cognitive load.

### Maintainability Index (SEI/Carnegie Mellon 1992)
```
MI = max(0, min(100, (171 - 5.2·ln(HalsteadVolume) - 0.23·CC - 16.2·ln(LOC)) × 100/171))
```

- **> 75** — highly maintainable
- **50–75** — moderate
- **25–50** — low maintainability
- **< 25** — unmaintainable

### Halstead Volume & Effort (Halstead 1977)
Treats code as an information-theoretic signal. Counts distinct operators (n₁) and operands (n₂), and their total occurrences (N₁, N₂).

```
Vocabulary = n₁ + n₂
Length     = N₁ + N₂
Volume     = Length × log₂(Vocabulary)    ← size in "bits"
Difficulty = (n₁/2) × (N₂/n₂)            ← how hard to write
Effort     = Difficulty × Volume           ← total mental effort
```

High volume + high difficulty = high bug probability.

### Testability Score (ASTra v3 novel metric)
Custom composite, 0–100, higher = easier to test:

```
Start:   100
- 3 per CC point          (complex = hard to test)
- 4 per nesting level     (deep nesting = hard to isolate)
- 10 if async             (async = more test setup)
- 5  if JSX               (needs render testing)
+ 10 if kind = hook       (renderHook makes these easy)
+ 15 if pure utility, not async
```

### Bundle Weight
```
weight = LOC × kind_multiplier

type-block        → 0.1  (erased at compile time)
constant-block    → 0.5
utility-function  → 1.0
class             → 1.8
context-provider  → 1.8
react-component   → 2.0
```

### Technical Debt (minutes, SQALE-inspired)
```
debt = 5 × (CC - 10)⁺
     + 2 × (50 - MI)⁺
     + 0.5 × (LOC - 100)⁺
     + 15 × smell_count
```

### Health Grade (S / A / B / C / D / F)
Aggregated from average MI and average CC across all regions:

| Grade | MI | Avg CC |
|-------|----|--------|
| S | > 85 | < 4 |
| A | > 70 | < 6 |
| B | > 55 | < 9 |
| C | > 40 | < 13 |
| D | > 25 | < 18 |
| F | otherwise | — |

---

## Stage 4: Smell Detection — Finding the Real Problems

ASTra v3 runs 20+ rule-based detectors against each region's source text and AST properties.

### React / Hook Smells

**God Component** — detected when a component has ≥ 4 distinct concerns:
- `useState` / `useReducer` (state management)
- `useEffect` (side effects)
- `fetch` / `axios` / `useQuery` (data fetching)
- `.map()` / `.filter()` transforms
- `styled.` / `className` (styling logic)
- `dispatch` / `useSelector` (store integration)

**Mixed Concerns — API + Render** — `fetch()` or `axios` found alongside JSX elements in the same region. The fix: extract the data-fetching into a custom hook.

**Prop Drilling** — `props.x.y.z` (depth > 2) appears ≥ 2 times. The fix: React Context or a custom hook.

**Async useEffect** — `useEffect(async` found. useEffect callbacks must not be async directly (they return a cleanup function, not a Promise). The fix: inner IIFE.

**Missing useEffect Dependency Array** — `useEffect(() =>` without a trailing `, [`. Runs on every render.

**Direct DOM Manipulation** — `document.getElementById`, `querySelector`, `createElement` inside a React component. Breaks the React reconciliation contract.

### General Smells

**Oversized Module (> 200 lines)** — Critical. Single-responsibility principle violation.

**Extreme Nesting (> 8 levels)** — Critical. Typically indicates missing early returns or unextracted helper logic.

**Extreme Cyclomatic Complexity (> 20)** — Critical. Statistically correlated with 40%+ higher defect rate.

**Duplicate Logic** — Cross-region fingerprinting: a sliding window of 3-line chunks is hashed across all regions. If the same chunk appears in ≥ 2 distinct regions, a file-level smell is emitted.

**Magic Numbers** — More than 4 bare numeric literals (≥ 2 digits) that aren't in string literals. Replace with named constants.

Each smell carries: `severity` (critical / high / medium / low), `description`, `recommendation`, and `autoFixable` (whether ASTra can directly remediate it by extraction).

---

## Stage 5: The ExtractionOracle — The Decision Engine

This is the novel core of ASTra v3. For each region, the Oracle computes an extraction score `σ ∈ [0, 1]` across 8 weighted dimensions:

```
σ = size_pressure      (max 0.25)
  + complexity_signal  (max 0.25)
  + kind_affinity      (max 0.20)
  + smell_severity     (max 0.15)
  + coupling_pressure  (max 0.10)
  + cohesion_reward    (max 0.05)
  + testability_gain   (max 0.05)
  − penalties          (−0.05 dead export, −0.08 SCC member)
```

**Decision:** `shouldExtract = (σ ≥ 0.35)`

**Hard rules override scoring:**
- `type-block` → always route to types file, never create a standalone file
- `LOC < 15` → always retain (not worth a new file)
- `isDeadExport && LOC < 30` → always retain

**Kind affinity values** (how strongly does this kind want its own file?):

```
context-provider  0.95  ← almost always extract
hoc               0.90
hook              0.85
class             0.75
react-component   0.65
utility-function  0.60
constant-block    0.40
enum              0.35
type-block        0.05  ← route, don't extract
```

**Confidence mapping:**
- `σ ≥ 0.85` → definitive (97%)
- `σ ≥ 0.70` → high (85%)
- `σ ≥ 0.50` → medium (65%)
- `σ ≥ 0.30` → low (40%)
- otherwise   → speculative (20%)

**ΔMI prediction:** `ΔMI = (100 − region_MI) × 0.3 × σ`

Tells you the estimated Maintainability Index improvement if this region is extracted. A region with MI=40 and σ=0.8 would gain approximately +14 MI points.

---

## Stage 6: Import Resolution — Wiring Everything Together

This stage answers: *for each extracted region, what import statements does it need in its new file?*

Every symbol in `region.usedSymbols` that isn't in `region.localBindings` must come from somewhere. ASTra v3 checks three sources in order:

**1. Another extracted region** — if symbol `useAuth` is declared in region `useAuth` which has proposed file `hooks/use-auth.ts`, and the current region is `Dashboard` at `components/dashboard.tsx`, the resolver computes:

```
relPath("components/dashboard.tsx", "hooks/use-auth.ts")
→ "../hooks/use-auth"

emits: import { useAuth } from '../hooks/use-auth';
```

The relative path calculation handles any directory depth — it finds the common ancestor, adds `../` for each diverging step, then appends the target path.

**2. Type-only routing** — symbols that are TypeScript types (namespace = `'type'`) are imported with `import type`, which is erased entirely at compile time and costs zero bundle weight.

**3. External package** — if symbol `useState` was imported from `'react'` in the original file, the same import is reproduced in the extracted file:

```
import { useState } from 'react';
```

The resolver looks up the original `ImportRecord` to find the exact import form (named / default / namespace) and reproduces it faithfully.

**Import ordering in generated files:**
1. React (`'react'`)
2. External packages (node_modules)
3. Relative imports (cross-module)
4. Type-only imports (`import type`)

---

## Stage 7: File Generation — The Output

For each extraction candidate, ASTra v3 generates a complete file:

```typescript
/**
 * @generated ASTra v3 — Module Splitter
 * @source    src/Dashboard.tsx
 * @region    useAuth (hook)
 * @lines     45–89
 */

import { useState, useCallback } from 'react';
import { apiClient } from '../services/api-client';

export function useAuth() {
  // ... original region body, exactly as written ...
}
```

**Updated source file** — the original file with extracted regions removed and re-imports added at the top.

**Barrel `index.ts`** — one export per proposed file, grouped by directory:

```typescript
// hooks/
export { useAuth } from './hooks/use-auth';
export { useTheme } from './hooks/use-theme';

// components/
export { UserCard } from './components/user-card';
```

**Test scaffold** per proposed file:

```typescript
import { renderHook, act } from '@testing-library/react';
import { useAuth } from './use-auth';

describe('useAuth', () => {
  it('initialises with correct default state', () => {
    // TODO: implement test
    expect(true).toBe(true);
  });

  it('updates state on action', () => {
    // TODO: implement test
    expect(true).toBe(true);
  });
});
```

The test stubs are tailored to the region kind — components get `render` + snapshot tests, hooks get `renderHook` + state-change tests, utilities get input/output + edge-case tests.

---

## Stage 8: Linkage Map — The After Picture

Once all proposed files are known, ASTra v3 builds a `FileLinkage[]` — a directed graph at the *file* level:

```
components/dashboard.tsx  →  hooks/use-auth.ts          (symbols: useAuth)
components/dashboard.tsx  →  utils/format-date.ts       (symbols: formatDate)
hooks/use-auth.ts         →  services/api-client.ts     (symbols: apiClient)
```

Each linkage carries: `symbols`, `edgeWeight`, `isCircular`, `isCriticalPath`.

**Circular detection**: if `A → B` and `B → A` both exist, both are marked `isCircular = true`. ASTra v3 never *introduces* new circular dependencies — it only surfaces ones already present in the original file (guaranteed by Theorem 3 in the research paper).

**Critical path**: using topological relaxation, ASTra v3 finds the longest dependency chain. This is the sequence of files where a change in the first file propagates through every subsequent one — the highest-risk refactoring path.

---

## What the VS Code Panel Shows

The 8-tab webview panel maps directly to the 8 stages:

| Tab | What you see |
|-----|-------------|
| **Overview** | Health grade (S–F), 8 metric cards, dependency mini-map SVG |
| **Regions** | Every detected region: kind badge, metrics bar, extraction decision with reasons |
| **Extract** | Extraction candidates: target file, confidence %, ΔMI, resolved imports, dependencies |
| **Linkage** | File linkage map, circular risk warnings, critical path highlight |
| **Smells** | Severity-sorted smell cards, auto-fix indicators, recommendations |
| **Tests** | Test scaffold suggestions, framework (Jest/Vitest), mock imports |
| **Files** | Generated file content previews (first 30 lines each) |
| **Dry Run** | Full list of files to create + updated source preview |

---

## A Concrete Example

**Input:** `src/Dashboard.tsx` — 280 lines containing:
- `Dashboard` component (180 lines, God Component smell)
- `useDataFetch` hook (60 lines, missing dep array)
- `formatCurrency` utility (20 lines, pure)
- `DashboardProps` interface (8 lines)
- `STATUS_COLORS` constant (12 lines)

**ASTra v3 output:**

| Region | Score σ | Decision | Target |
|--------|---------|----------|--------|
| Dashboard | 0.81 | ✦ Extract (definitive) | `components/dashboard.tsx` |
| useDataFetch | 0.74 | ✦ Extract (high) | `hooks/use-data-fetch.ts` |
| formatCurrency | 0.22 | ✗ Retain | — |
| DashboardProps | — | → Route | existing `types.ts` |
| STATUS_COLORS | 0.18 | ✗ Retain | — |

**Files created:**
```
components/dashboard.tsx       (180 lines, 3 imports resolved)
hooks/use-data-fetch.ts        (60 lines, 2 imports resolved)
index.ts                       (barrel, 2 exports)
src/Dashboard.tsx              (updated: 50 lines remaining, 2 re-imports)
```

**Health improvement:**
- Before: MI = 38 (D grade)
- After:  `dashboard.tsx` MI = 52, `use-data-fetch.ts` MI = 71 (B grade)
- ΔMI ≈ +19 (matches Oracle prediction of +17)

---

## Guarantees

1. **Coverage** — every top-level declaration is assigned to exactly one region. Nothing is lost.
2. **Import completeness** — every symbol used in an extracted file has a corresponding import statement. Generated files compile.
3. **No new circular dependencies** — ASTra v3 only extracts from a pre-analysed graph. It cannot introduce a circular import that didn't already exist structurally in the original file.
4. **Type safety** — the algorithm is fully TypeScript, strict mode, zero `any`. The same rigour applied to your code is applied to the tool itself.
