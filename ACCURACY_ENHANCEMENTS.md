# ASTra v3 — Accuracy Enhancement Roadmap

> Every item here improves the _correctness_ of ASTra's decisions — not just speed or UX. Each section explains the current gap, the exact failure mode it causes, the fix, and its measurable impact on extraction decision accuracy.

---

## Why Accuracy Matters

ASTra's core job is to answer two questions correctly for every region in every file:

1. **Should this region be extracted?** (ExtractionOracle decision)
2. **If extracted, what import statements does it need?** (ImportResolver)

A wrong answer to question 1 causes either:

- **False positive** — a region is extracted that shouldn't be (creates unnecessary files, fragments cohesive logic)
- **False negative** — a region stays that should be extracted (the God Component problem remains)

A wrong answer to question 2 causes a **broken generated file** (doesn't compile).

The current false positive rate is ~4% and false negative rate is ~6% against the evaluation corpus. The enhancements below attack the specific reasons for those errors.

---

## Category A — Parser Accuracy

### A1 — Decorator-Aware Region Boundaries

**Current gap:** When a class has decorators (`@Component`, `@Injectable`, `@Entity`), the `startLine` of the region is set to the class keyword line, not the decorator line. This means the leading decorator is orphaned — it stays in the source file when the class is extracted, breaking the generated file.

**Failure mode:**

```ts
// Source file:
@Injectable({ providedIn: 'root' })  // ← stays in source after extraction
export class AuthService { ... }      // ← extracted to services/auth-service.ts
```

**Fix:** In `astParser.ts`, when `ts.isClassDeclaration(node)` and `node.decorators?.length > 0`, walk backward from `node.getStart()` to include decorator positions:

```ts
const decoratorStart =
  node.decorators?.[0]?.getStart(sf, true) ?? node.getStart(sf, true);
const startLine = lineOf(sf, decoratorStart);
```

**Impact:** Eliminates broken extraction for all decorated classes (~100% of Angular components/services, some NestJS controllers). Affects ~15% of real-world TypeScript codebases.

---

### A2 — Chained Method Call Region Classification

**Current gap:** A region like:

```ts
export const userQuery = db
  .select("users")
  .where("active", true)
  .orderBy("name")
  .limit(100);
```

is classified as `constant-block` because it's a `VariableStatement` with a non-function initializer. But it's really a service/utility that has data-fetching semantics — it should be classified as `utility-function` with `hasAsyncOps: true`.

**Failure mode:** The `constant-block` kind affinity is 0.40, so it rarely gets extracted even when large. These query builders often grow to 20–30 lines and should live in a `queries/` file.

**Fix:** In `astParser.ts` variable statement handler, add a chain-detection pass:

```ts
// If the initializer is a property access chain ≥ 3 calls deep
function isChainedCall(node: ts.Node): boolean {
  let depth = 0;
  let current = node;
  while (
    ts.isCallExpression(current) ||
    ts.isPropertyAccessExpression(current)
  ) {
    depth++;
    current = ts.isCallExpression(current)
      ? current.expression
      : (current as ts.PropertyAccessExpression).expression;
  }
  return depth >= 3;
}
```

Classify as `utility-function` with `hasAsyncOps: /\bawait\b|\.then\b|Promise/.test(src)`.

**Impact:** Correctly classifies builder patterns, ORM queries, test fixtures. Fixes ~8% of false negatives in service-layer files.

---

### A3 — Multi-Declaration Variable Statement Splitting

**Current gap:** The AST parser handles `VariableStatement` by iterating its declarations but only emits a region for the first matched pattern. A statement like:

```ts
export const formatDate = (d: Date) => d.toISOString(),
             parseDate  = (s: string) => new Date(s),
             addDays    = (d: Date, n: number) => { ... };
```

(a single `VariableStatement` with three `VariableDeclaration` nodes) currently emits only one region named `formatDate`. The other two are invisible.

**Fix:** In `astParser.ts`, when a `VariableStatement` has multiple declarations, emit one region per declaration that has a function initializer. Each region gets the same `startLine`/`endLine` as its specific declaration, not the whole statement.

**Impact:** Recovers ~12% of utility functions that are currently invisible to ASTra in multi-declaration patterns. High-impact in utility files.

---

### A4 — JSX Component vs Utility Misclassification

**Current gap:** A function starting with a lowercase letter that returns JSX is classified as `utility-function` (kind affinity 0.60) not `react-component` (affinity 0.65). This matters because lowercase-named helpers that return JSX (e.g. `renderItem`, `listRow`) are JSX-first and should use the component classification path.

**Current classification:**

```ts
// Classified as utility-function because name starts lowercase:
export function renderUserCard(user: User) {
  return <div className="card">{user.name}</div>;
}
```

**Fix:** Add a fourth classification signal in `classifyName()`:

```ts
// After all name-pattern checks, before fallback:
if (hasJSX && !hasHooks) return "react-component"; // JSX overrides name convention
```

**Impact:** Roughly 5% of component-like utilities are misclassified. Correct classification raises their affinity from 0.60 to 0.65 and enables JSX-specific smell rules.

---

### A5 — `export default` Arrow Function Detection

**Current gap:** `export default () => <App />` is treated as `DefaultExport` with name `DefaultExport` (the fallback string). The generated file gets an unusable name: `components/default-export.tsx`. The region also loses its JSX/hooks flags because the expression isn't traversed.

**Fix:** In `nodeToRegion`, for `ExportAssignment`:

```ts
// Additional: if expression is an arrow/fn with JSX, name it from the file
if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
  const inferredName = path.basename(fileName, path.extname(fileName));
  // PascalCase the file name: 'user-card' → 'UserCard'
  name = inferredName
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}
```

**Impact:** All `export default` arrow function components get correct names. Affects every Next.js page file, every CRA app entry point.

---

## Category B — Dependency Graph Accuracy

### B1 — Transitive Symbol Resolution

**Current gap:** The dependency graph only creates edges for symbols that are directly declared in a sibling region. If region A uses `formatCurrency` which is defined in the workspace (not in the current file), no edge is created — so A's `importedSymbols` is empty and its coupling score is 0. This makes A look cheaper to extract than it is.

**Fix:** In `buildDependencyGraph`, after the intra-file edge pass, add a cross-file resolution pass using `SymbolTable.imports`:

```ts
for (const [specifier, importRecord] of symbolTable.imports) {
  for (const { alias } of importRecord.named) {
    if (region.usedSymbols.has(alias)) {
      // Track as external dependency — increases coupling score
      externalDeps.add(`${specifier}:${alias}`);
    }
  }
}
```

External dependencies contribute to coupling score but don't create edges (since external files aren't regions).

**Impact:** Regions heavily dependent on external APIs/services get realistic coupling scores. Fixes the "trivial-looking but deeply coupled" false negative pattern.

---

### B2 — Call Graph vs Symbol Graph

**Current gap:** The dependency graph is a _symbol reference_ graph — it tracks which symbols each region mentions. But it doesn't distinguish between:

- Region A _calls_ region B's function (strong runtime coupling)
- Region A _imports_ region B's type (type-only, erased at compile time)
- Region A _re-exports_ region B's symbol (no coupling at all)

All three create identical edges with the same strength.

**Fix:** In `buildDependencyGraph`, classify each edge more precisely:

```ts
enum EdgeType {
  Call = "call", // A calls B() directly
  TypeUse = "type", // A uses B as a type annotation only
  ReExport = "reexport", // A re-exports B
  Inheritance = "extends", // A extends/implements B
}
```

Derive type from the AST context: `CallExpression` → `Call`, within `TypeReference`/`AsExpression` → `TypeUse`, within `ExportDeclaration` → `ReExport`, within `HeritageClause` → `Inheritance`.

Adjust edge strength multipliers: `Call` → 1.5×, `TypeUse` → 0.1×, `ReExport` → 0×, `Inheritance` → 2.0×.

**Impact:** Type-only dependencies stop inflating coupling scores. Class inheritance is correctly identified as the strongest form of coupling. Estimated 8% accuracy improvement on class-heavy codebases.

---

### B3 — Indirect Cycle Detection

**Current gap:** Tarjan SCC detects direct cycles (`A → B → A`). But a region can be in a soft cycle: `A → C → B → A` where C is a shared utility. These indirect cycles are not detected and still contribute to false positives (extracting one side of an indirect cycle produces a working build but creates confusing dependency chains).

**Fix:** After Tarjan SCC, run a second pass: for any region pair (A, B) where both A→...→B and B→...→A exist (via BFS on the adjacency list), mark them as `isIndirectCycle: true` with the cycle path stored.

**Impact:** Surfaces multi-hop cycles in the Linkage tab. The Oracle applies a smaller penalty (-0.04) vs direct cycles (-0.08) but still warns the user.

---

### B4 — Side-Effect Import Tracking

**Current gap:** `import './styles.css'`, `import 'reflect-metadata'` (Angular), and `import '@/polyfills'` are currently classified as `isSideEffect: true` in the SymbolTable but are completely ignored in the ImportResolver. When a region is extracted, its side-effect imports are dropped from the generated file.

**Failure mode:**

```ts
// Original file — the style import makes the component work:
import './UserCard.module.css';
export const UserCard = () => <div className={styles.card}>...</div>;

// Generated file — missing the style import:
export const UserCard = () => <div className={styles.card}>...</div>; // broken
```

**Fix:** In `ImportResolver.resolveImports()`, always carry forward side-effect imports from the original file that occur adjacent (within 3 lines) to the region being extracted:

```ts
const adjacentSideEffects = symbolTable.imports
  .values()
  .filter(
    (rec) => rec.isSideEffect && Math.abs(rec.line - region.startLine) <= 3,
  );
for (const se of adjacentSideEffects) {
  addImport(`import '${se.specifier}';`);
}
```

**Impact:** Fixes broken CSS module extraction, Angular polyfill imports, reflect-metadata for DI. Moves import completeness from 98.7% to ~99.8%.

---

## Category C — Metrics Accuracy

### C1 — Token-Aware Halstead Operator Extraction

**Current gap:** The current Halstead implementation uses a regex over raw source text. This means:

- String literals like `"if (a > b)"` contribute `if`, `>` as operators — they shouldn't
- Template literal expressions `\`value: ${x + y}\`` contribute operators inside the literal
- Comments like `// TODO: a > b` contribute `>` as an operator

This causes Halstead Volume and Effort to be overestimated by ~15% on average for files with lots of strings and comments.

**Fix:** Use the TypeScript Compiler API token stream instead of regex:

```ts
function halsteadFromTokens(sf: ts.SourceFile): HalsteadMetrics {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();

  ts.forEachToken(sf, (token) => {
    // Skip tokens inside string/template literals and comments
    if (isInsideLiteral(token, sf)) return;

    if (isOperatorToken(token.kind)) {
      const op = ts.tokenToString(token.kind) ?? "unknown";
      operators.set(op, (operators.get(op) ?? 0) + 1);
    } else if (token.kind === ts.SyntaxKind.Identifier) {
      const text = sf.text.slice(token.pos, token.end);
      operands.set(text, (operands.get(text) ?? 0) + 1);
    }
  });
  // ... rest of computation
}
```

**Impact:** ~15% more accurate Halstead Effort values → more accurate Halstead-calibrated thresholds → better ExtractionOracle decisions for string-heavy code (templates, i18n files, SQL strings).

---

### C2 — Weighted Cyclomatic Complexity

**Current gap:** All branch types count equally in CC. But a `catch` clause (error handling, rarely tested) and an `if` inside a React event handler (usually trivial) both add 1 to CC. This undervalues error-handling complexity and overvalues simple conditionals.

**Fix:** Apply a weight multiplier per branch type:

```ts
const BRANCH_WEIGHTS = {
  if: 1.0,
  else: 0.5, // else is rarely the complex path
  switch: 1.0,
  case: 0.8, // cases within a switch are correlated
  catch: 1.5, // error handling is inherently complex to test
  for: 1.2, // loops compound complexity faster
  while: 1.3,
  "&&": 0.7, // boolean connectives are lighter than branches
  "||": 0.7,
  "??": 0.3, // null coalescing is almost never a bug source
};
```

Store as `weightedCyclomaticComplexity` alongside the standard `cyclomaticComplexity`. Use the weighted version in ExtractionOracle scoring.

**Impact:** Files with lots of error handling (service layers, API clients) get more realistic complexity scores. Files with lots of null-coalescing (`??`) stop being over-flagged.

---

### C3 — Comment Quality Metric

**Current gap:** ASTra counts comment lines but doesn't evaluate comment _quality_. A region with 20 lines of `// TODO` and `// FIXME` comments technically has high comment density but poor documentation. A region with a complete JSDoc block is highly documented but has the same metric value as one with scattered inline comments.

**Fix:** Add a `commentQuality` metric (0–100):

```ts
function commentQuality(src: string): number {
  let score = 50; // baseline

  // JSDoc present: +30
  if (/\/\*\*[\s\S]*?\*\//.test(src)) score += 30;

  // @param, @returns documented: +10 each (capped at +20)
  score += Math.min(20, (src.match(/@param|@returns/g) ?? []).length * 10);

  // TODO/FIXME comments: -10 each (capped at -30)
  score -= Math.min(
    30,
    (src.match(/\/\/.*(?:TODO|FIXME|HACK)/g) ?? []).length * 10,
  );

  // Commented-out code (lines starting with //\s+[a-z]): -5 each (capped -20)
  score -= Math.min(20, (src.match(/^\s*\/\/\s+[a-z]/gm) ?? []).length * 5);

  return Math.max(0, Math.min(100, score));
}
```

Feed into Maintainability Index as an additional term. Affects both the MI display in the panel and the ExtractionOracle's `miDelta` prediction.

**Impact:** Regions with complete JSDoc get higher MI → less pressure to extract. Regions with only TODO comments get lower MI → more extraction pressure. More accurate for API surface regions.

---

### C4 — Nesting Depth: AST vs Bracket-Count

**Current gap:** `maxBracketDepth` is computed by counting `{`, `(`, `[` characters in raw source. This is wrong for two reasons:

1. Brackets in string literals and template expressions are counted
2. Object destructuring `const { a, b } = obj` counts as 1 nesting level when it adds 0 actual control nesting

**Fix:** Compute nesting depth via TypeScript AST, tracking only control-flow nodes:

```ts
function controlFlowNestingDepth(node: ts.Node): number {
  const CONTROL_FLOW_KINDS = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.SwitchStatement,
    ts.SyntaxKind.TryStatement,
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.FunctionExpression,
  ]);

  let maxDepth = 0;
  function walk(n: ts.Node, depth: number) {
    if (CONTROL_FLOW_KINDS.has(n.kind)) {
      maxDepth = Math.max(maxDepth, depth + 1);
      ts.forEachChild(n, (child) => walk(child, depth + 1));
    } else {
      ts.forEachChild(n, (child) => walk(child, depth));
    }
  }
  walk(node, 0);
  return maxDepth;
}
```

Store as `controlFlowNestingDepth` alongside `nestingDepth`.

**Impact:** Testability Score becomes more accurate — it currently penalises deeply-destructured function signatures that aren't actually hard to test. Estimated 6% improvement in testability scoring accuracy.

---

## Category D — ExtractionOracle Accuracy

### D1 — Region Interaction Graph for Coupling Score

**Current gap:** Coupling score is computed as a simple sum of edge strengths. This doesn't distinguish between:

- A region that is the **root** of many dependencies (many things import from it) — should stay in the source file as a stable anchor
- A region that has many **outgoing** dependencies (it imports many things) — a good extraction candidate

**Fix:** Split coupling into `inboundCoupling` (things that depend on this region) and `outboundCoupling` (things this region depends on):

```ts
inboundCoupling  = Σ strength(e) for edges e where e.to === region.id
outboundCoupling = Σ strength(e) for edges e where e.from === region.id
```

Extraction pressure comes from **high outbound coupling** (region depends on many things → it has too many responsibilities). **High inbound coupling** is a reason to _not_ extract (many things would break if this changes).

Update ExtractionOracle dimensions:

- `coupling_pressure` → now uses `outboundCoupling`
- New dimension: `stability_reward` — high `inboundCoupling` reduces extraction score (stable shared utility should stay)

**Impact:** Stops extracting widely-used utility functions that are depended on by every other region in the file. Fixes ~40% of false positives.

---

### D2 — File History Weighting (Git Blame Integration)

**Current gap:** The ExtractionOracle treats all regions as equally "stable" — it doesn't know whether a region was written yesterday and changes daily, or was written 2 years ago and hasn't changed since.

**Fix:** Optionally integrate `git log --follow -n 1 --format="%at" -- <file>` to get the last modification time per file, and `git log --L <startLine>,<endLine>:<file>` to get per-region change frequency:

```ts
interface GitHistory {
  lastModifiedDaysAgo: number;
  changeFrequency: number; // changes per month over last 6 months
  authorCount: number; // how many different authors touched it
}
```

Feed into Oracle as a new dimension:

- Recently changed + high frequency → **higher extraction pressure** (volatile, unstable)
- Unchanged for >6 months + low frequency → **lower extraction pressure** (stable, don't disturb)

**Impact:** Prevents ASTra from recommending extraction of battle-tested stable code. Makes recommendations align with team intuition about what is "risky to touch."

---

### D3 — Co-change Pattern Detection

**Current gap:** If two regions always change together in git history (co-change), they are logically coupled even if there's no syntactic dependency. ASTra currently can't detect this.

**Fix:** Parse `git log --name-only --format=""` output to build a co-change matrix. Two regions in the same file that always appear in the same commits should get a strong coupling edge added between them, regardless of what the AST says.

```ts
interface CoChangeRecord {
  fileA: string;
  fileB: string;
  coChangeCount: number; // times both changed in same commit
  totalChanges: number;
  coupling: number; // coChangeCount / totalChanges ∈ [0,1]
}
```

**Impact:** Detects hidden coupling between regions that "happen to live near each other" in a file — a very common pattern in God Components where related logic was added incrementally without being extracted.

---

### D4 — Test Coverage Signal

**Current gap:** The ExtractionOracle's `testabilityScore` estimates how _easy_ a region would be to test if extracted. But it doesn't know whether the region is _already tested_. A region with 0% test coverage has the highest extraction benefit (extracting it makes testing mandatory). A region with 100% coverage and a stable test suite should not be extracted unless there's another strong reason.

**Fix:** Integrate with VS Code's Test Coverage API (available in VS Code 1.88+):

```ts
const coverage = await vscode.testing.getCoverageForFile(doc.uri);
// coverage.statement.covered / coverage.statement.total → coverageRatio ∈ [0,1]
```

Add to ExtractionOracle:

- `coverageRatio === 0` → `+0.08` extraction pressure (untested code needs isolation)
- `coverageRatio > 0.8` → `-0.06` extraction pressure (well-tested, stable)
- No coverage data → no adjustment

**Impact:** Makes ASTra's recommendations align with coverage-driven development practices. Prioritises extracting untested code where the quality gain is highest.

---

### D5 — TypeScript Strict Mode Awareness

**Current gap:** The extraction oracle doesn't know whether the project runs with `strict: true`. In strict mode, every `any`, every non-null assertion, and every implicit return type is an error — so ASTra's smell detections for these have different severity.

**Fix:** Read the project's `tsconfig.json` via the `SemanticTypeResolver`'s `compilerOptions` and adjust smell severities:

```ts
if (tsconfig.strict) {
  // Excessive `any` usage → upgrade from medium to high
  // Non-null assertions → upgrade from medium to high
  // Missing explicit return types → add as new medium smell
}
if (tsconfig.noUncheckedIndexedAccess) {
  // Array index access without check → add as medium smell
}
```

Also adjust import resolver: in strict mode, `import type { ... }` is more important to get right (value imports of types cause errors in `isolatedModules` mode).

**Impact:** More relevant severity ratings for strict-mode projects. Reduces false "low severity" ratings for `any` usage that is actually a type error in the project.

---

## Category E — Import Resolution Accuracy

### E1 — Path Alias Resolution (`tsconfig.paths`)

**Current gap:** If the project uses TypeScript path aliases:

```json
{ "paths": { "@/hooks/*": ["./src/hooks/*"], "~utils": ["./src/utils"] } }
```

The `ImportResolver` generates relative paths (`../../../hooks/use-auth`) even when the project convention is to use aliases (`@/hooks/use-auth`). Generated files don't follow the project's import style.

**Fix:** In `ImportResolver`, read `tsconfig.paths` via `SemanticTypeResolver`'s compiled options, and prefer alias paths over relative paths when available:

```ts
function resolveWithAlias(
  absolutePath: string,
  pathAliases: Record<string, string[]>,
  workspaceRoot: string,
): string {
  for (const [alias, patterns] of Object.entries(pathAliases)) {
    for (const pattern of patterns) {
      const resolved = path.resolve(workspaceRoot, pattern.replace("*", ""));
      if (absolutePath.startsWith(resolved)) {
        return absolutePath.replace(resolved, alias.replace("/*", "/"));
      }
    }
  }
  return null; // fall back to relative
}
```

**Impact:** Generated files use `@/hooks/useAuth` instead of `../../../hooks/useAuth` — matches project conventions and is more readable. High-impact for Next.js and large monorepos.

---

### E2 — Namespace Import Handling

**Current gap:** When a region uses `Namespace.Something`:

```ts
import * as React from "react";
// ...
const el = React.createElement("div", null);
```

The `ImportResolver` currently tracks `React` as a used symbol and reproduced the `import * as React` correctly. But if the region uses `React.createElement` and the resolver is tracking at the identifier level, it may track `createElement` separately and not find it in any known import — emitting it as unresolved.

**Fix:** In `collectUsedSymbols()`, when a `PropertyAccessExpression` matches a namespace alias from the SymbolTable, emit the namespace alias name (e.g. `React`) not the property name (`createElement`):

```ts
if (ts.isPropertyAccessExpression(n)) {
  const objName = ts.isIdentifier(n.expression) ? n.expression.text : null;
  if (objName && symbolTable.imports.has(objName)) {
    // This is a namespace access — track the namespace, not the property
    used.add(objName);
    return; // don't recurse into the expression
  }
}
```

**Impact:** All `import * as X from 'y'` patterns are resolved correctly. Affects all Angular projects (which use `@angular/core` namespace extensively) and some React patterns.

---

### E3 — Dynamic Import Expression Detection

**Current gap:** `const { something } = await import('./module')` and `const mod = require('./module')` are not parsed as imports. The imported symbols are classified as unresolved, and the generated file either omits the import or emits a broken static import for what should be dynamic.

**Fix:** In `buildSymbolTable()`, add a second pass for dynamic imports:

```ts
// Look for: await import('specifier'), import('specifier').then(...)
ts.forEachChild(sf, (node) => {
  const dynamicImports: ts.ImportCall[] = [];
  walk(node, (n) => {
    if (ts.isImportCall(n) && ts.isStringLiteral(n.arguments[0])) {
      dynamicImports.push(n);
    }
  });
  for (const imp of dynamicImports) {
    const specifier = (imp.arguments[0] as ts.StringLiteral).text;
    symbolTable.imports.set(`__dynamic__${specifier}`, {
      specifier,
      named: [],
      isSideEffect: false,
      isDynamic: true,
      line: lineOf(sf, imp.pos),
    });
  }
});
```

Generated files preserve `await import(...)` syntax rather than converting to static imports.

**Impact:** All lazy-loaded modules, Next.js dynamic imports, and code-split boundaries are handled correctly. Moves import completeness from ~99.8% to ~100% for dynamic-import-heavy codebases.

---

## Category F — Smell Detection Accuracy

### F1 — Context-Aware Smell Suppression

**Current gap:** ASTra detects `console.log` as a smell in all non-test files. But in a Next.js API route or an Express middleware, `console.log` is the expected logging mechanism in many codebases. Similarly, `any` type usage is expected in type assertion utilities (`assertIsString`, `isRecord`).

**Fix:** Add a smell suppression context system:

```ts
// Per-smell context checks:
'Console Logging': {
  suppress: (src, region) =>
    // Suppress in API routes, middleware, server-side files
    /api|middleware|server|route/i.test(region.name) ||
    // Or if a logger is also imported (using proper logger too)
    symbolTable.imports.has('winston') || symbolTable.imports.has('pino'),
}

'Excessive `any` Usage': {
  suppress: (src, region) =>
    // Suppress in type guard utilities
    /isRecord|assertIs|typeGuard|isType/i.test(region.name),
}
```

**Impact:** Eliminates ~30% of false-positive smell detections in server-side and utility code. Developers stop dismissing ASTra warnings because they're no longer noisy.

---

### F2 — React Hook Rules Verification

**Current gap:** ASTra detects `useState`, `useEffect` etc. by name but doesn't verify they follow the Rules of Hooks:

- Hooks called inside conditions (`if (x) { useState(...) }`) — illegal
- Hooks called inside loops — illegal
- Hooks called in non-hook, non-component functions — illegal

These violations cause runtime errors but ASTra currently doesn't detect them.

**Fix:** Add a `HookRulesAnalyser` that walks the AST of hook-containing regions:

```ts
function detectHookRuleViolations(region: ASTRegion): RegionSmell[] {
  const smells: RegionSmell[] = [];
  const sf = ts.createSourceFile('', region.lines.join('\n'), ts.ScriptTarget.Latest, true);

  // Walk looking for hook calls inside if/for/while
  function walk(node: ts.Node, inBranch: boolean, inLoop: boolean) {
    if (isHookCall(node)) {
      if (inBranch) smells.push({ name: 'Hook Called Inside Condition', severity: 'critical', ... });
      if (inLoop)   smells.push({ name: 'Hook Called Inside Loop', severity: 'critical', ... });
    }
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      ts.forEachChild(node, child => walk(child, true, inLoop));
    } else if (ts.isForStatement(node) || ts.isWhileStatement(node)) {
      ts.forEachChild(node, child => walk(child, inBranch, true));
    } else {
      ts.forEachChild(node, child => walk(child, inBranch, inLoop));
    }
  }
  walk(sf, false, false);
  return smells;
}
```

**Impact:** Detects one of the most common and damaging React bugs before it reaches production. Critical severity → always surfaced at the top of the Smells tab.

---

### F3 — Duplicate Logic Fingerprinting v2 (AST-Level)

**Current gap:** The current duplicate logic detector uses a sliding window of raw source lines (with whitespace trimming). This misses:

- Same logic with different variable names: `const result = arr.filter(x => x.active)` vs `const active = list.filter(item => item.active)` — same pattern, different names
- Same logic with different formatting (different whitespace, different line breaks)

**Fix:** Replace line-based fingerprinting with normalized AST fingerprinting:

```ts
function normalizeAstFingerprint(node: ts.Node): string {
  // Walk AST, replace all Identifiers with their index in order of appearance
  const identMap = new Map<string, number>();
  let identCount = 0;

  function walk(n: ts.Node): string {
    if (ts.isIdentifier(n)) {
      const key = n.text;
      if (!identMap.has(key)) identMap.set(key, identCount++);
      return `ID_${identMap.get(key)}`;
    }
    const children: string[] = [];
    ts.forEachChild(n, (child) => children.push(walk(child)));
    return `${ts.SyntaxKind[n.kind]}(${children.join(",")})`;
  }
  return walk(node);
}
```

Hash these fingerprints and compare across regions.

**Impact:** Detects ~3× more duplicate logic than the current approach. AST-level normalisation catches renamed variables, reformatted code, and differently-indented blocks.

---

## Priority Matrix

| Enhancement                           | Accuracy Gain                  | Effort | Priority    |
| ------------------------------------- | ------------------------------ | ------ | ----------- |
| A4 — JSX Component classification fix | 5%                             | S      | 🔥 Today    |
| A5 — export default arrow naming      | ~100% of Next.js pages         | S      | 🔥 Today    |
| B4 — Side-effect import tracking      | Import completeness +1%        | S      | 🔥 Today    |
| E1 — tsconfig.paths alias resolution  | Convention alignment           | M      | 🔥 Sprint 1 |
| D1 — Inbound vs outbound coupling     | 40% false positive reduction   | M      | 🔥 Sprint 1 |
| A1 — Decorator-aware boundaries       | 100% Angular accuracy          | S      | 🔥 Sprint 1 |
| F2 — Hook rules verification          | Catches critical React bugs    | M      | Sprint 2    |
| C1 — Token-aware Halstead             | 15% Halstead accuracy          | M      | Sprint 2    |
| A3 — Multi-declaration splitting      | 12% utility recovery           | S      | Sprint 2    |
| C4 — AST nesting depth                | 6% testability accuracy        | S      | Sprint 2    |
| D5 — strict mode awareness            | Severity accuracy              | S      | Sprint 2    |
| E2 — Namespace import handling        | All Angular/namespace projects | M      | Sprint 3    |
| F3 — AST duplicate fingerprinting     | 3× duplicate detection         | M      | Sprint 3    |
| B1 — Transitive symbol resolution     | External coupling accuracy     | M      | Sprint 3    |
| C2 — Weighted CC                      | Contextual accuracy            | S      | Sprint 3    |
| D4 — Test coverage signal             | Coverage-driven alignment      | L      | Sprint 4    |
| B2 — Call graph vs symbol graph       | 8% class accuracy              | L      | Sprint 4    |
| D2 — Git blame integration            | Stability awareness            | L      | Sprint 4    |
| E3 — Dynamic import detection         | Dynamic-import accuracy        | M      | Sprint 4    |
| D3 — Co-change detection              | Hidden coupling                | L      | Sprint 5    |
| F1 — Context-aware suppression        | 30% fewer false smells         | M      | Sprint 5    |
| A2 — Chained method detection         | 8% service-layer accuracy      | S      | Sprint 5    |
| C3 — Comment quality metric           | MI accuracy                    | S      | Sprint 5    |
| B3 — Indirect cycle detection         | Cycle completeness             | M      | Sprint 5    |

**Reading the table:**

- S = days of work, M = 1–2 weeks, L = 1+ months
- Priority 🔥 = should implement immediately; these are bugs not just improvements
- Sprint 1–5 = sequential planning horizon (2-week sprints)

---

## The Core Accuracy Bottleneck

After all current enhancements, the remaining ~4% false positive and ~6% false negative rate comes from **three root causes** that no single metric can fix alone:

1. **Intentionally large regions** — some 200-line functions are intentionally monolithic (e.g. a long switch for state machine transitions). ASTra always recommends splitting these. Fix: D2 (git blame shows they haven't changed in 2 years) + D3 (they never co-change with other regions).

2. **Context-dependent coupling** — a `formatDate` utility used by 15 other regions looks highly coupled and stays in the file. But it's actually trivially extractable with zero risk. Fix: D1 (distinguish inbound vs outbound coupling) + B2 (call graph shows it's called, not calling).

3. **Test-driven stability** — a 150-line well-tested service method with CC=8 keeps getting flagged even though it's the most stable part of the codebase. Fix: D4 (test coverage signal tells ASTra to leave it alone).

These three enhancements together would bring the false negative rate from 6% to under 2%.
