# ASTra v3 — How to Set Up as a Standalone Project

> Everything you need to go from zero to a working, tested, locally-runnable ASTra v3 module splitter — whether you want to use it as a CLI tool, integrate it into an existing project, or build on top of it.

---

## What You're Setting Up

ASTra v3 is a TypeScript package. At the end of this guide you will have:

- A fully compiled, tested module splitter you can `import` from any TypeScript project
- A CLI entry point: `npx astra-split <file>` that prints a split plan to your terminal
- A working test suite (62 tests, all passing)
- The correct TypeScript configuration to use the TypeScript Compiler API without conflicts

---

## Prerequisites

Install these before starting:

```bash
# Check versions
node --version      # needs 18.x or higher
npm --version       # needs 9.x or higher
tsc --version       # needs 5.x (or install below)
```

If you don't have TypeScript globally:

```bash
npm install -g typescript
```

---

## Option A — From the Zip (Fastest)

If you have the `module-splitter-final.zip` from this project:

```bash
# 1. Unzip
unzip module-splitter-final.zip
cd module-splitter

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Run tests — all 62 should pass
npm test

# 5. Try it immediately
node -e "
const { moduleSplitter } = require('./dist');
const src = require('fs').readFileSync('./src/core/moduleSplitter.ts', 'utf8');
const plan = moduleSplitter.analyse(src, 'moduleSplitter.ts');
console.log('Health:', plan.metrics.overallHealth);
console.log('Regions:', plan.regions.length);
console.log('Extract:', plan.extractionCandidates.length);
console.log('Smells:', plan.codeSmells.length);
"
```

---

## Option B — Fresh from Scratch

If you want to build the folder structure yourself and paste in the source files:

### 1. Create the project

```bash
mkdir astra-module-splitter
cd astra-module-splitter
npm init -y
```

### 2. Install dependencies

```bash
# Runtime dependency — TypeScript Compiler API
npm install typescript

# Dev dependencies — build, test, lint
npm install --save-dev \
  @types/jest \
  @types/node \
  jest \
  ts-jest \
  rimraf \
  @typescript-eslint/eslint-plugin \
  @typescript-eslint/parser \
  eslint
```

### 3. Create the folder structure

```bash
mkdir -p src/{types,core,parser,graph,analysis,resolver,generator,utils}
mkdir -p __tests__
mkdir -p research
```

Your structure should look like this:

```
astra-module-splitter/
├── src/
│   ├── types/
│   │   └── index.ts          ← all shared TypeScript types
│   ├── core/
│   │   ├── moduleSplitter.ts ← main pipeline orchestrator
│   │   └── webviewRenderer.ts← VS Code webview HTML generator
│   ├── parser/
│   │   └── astParser.ts      ← TypeScript Compiler API + fallback
│   ├── graph/
│   │   └── dependencyGraph.ts← Tarjan SCC + Kahn sort
│   ├── analysis/
│   │   ├── metrics.ts        ← CC, CogCC, MI, Halstead, Testability
│   │   ├── smellDetector.ts  ← 20+ smell rules
│   │   └── extractionOracle.ts← 8-factor scoring oracle
│   ├── resolver/
│   │   └── importResolver.ts ← symbol → import path resolution
│   ├── generator/
│   │   └── fileGenerator.ts  ← file content, barrel, test scaffolds
│   ├── utils/
│   │   └── helpers.ts        ← shared utilities
│   └── index.ts              ← public API barrel
├── __tests__/
│   └── pipeline.test.ts      ← 62-test suite
├── research/
│   └── ASTra-v3-paper.md     ← research paper
├── package.json
├── tsconfig.json
└── README.md
```

### 4. Add `tsconfig.json`

Create `tsconfig.json` at the root:

```json
{
  "compilerOptions": {
    "target":               "ES2020",
    "module":               "CommonJS",
    "moduleResolution":     "Node",
    "lib":                  ["ES2020"],
    "outDir":               "./dist",
    "rootDir":              "./src",
    "declaration":          true,
    "declarationMap":       true,
    "sourceMap":            true,
    "strict":               true,
    "noImplicitAny":        true,
    "strictNullChecks":     true,
    "noUnusedLocals":       true,
    "noImplicitReturns":    true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop":      true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck":         true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule":    true
  },
  "include":  ["src/**/*"],
  "exclude":  ["node_modules", "dist", "**/__tests__/**"]
}
```

### 5. Add scripts to `package.json`

Replace your `package.json` scripts section:

```json
{
  "scripts": {
    "build":       "tsc -p tsconfig.json",
    "build:watch": "tsc -p tsconfig.json --watch",
    "clean":       "rimraf dist",
    "prebuild":    "npm run clean",
    "test":        "jest --coverage",
    "test:watch":  "jest --watch",
    "typecheck":   "tsc --noEmit",
    "lint":        "eslint src --ext .ts"
  },
  "jest": {
    "preset":          "ts-jest",
    "testEnvironment": "node",
    "testMatch":       ["**/__tests__/**/*.test.ts"],
    "collectCoverageFrom": ["src/**/*.ts", "!src/index.ts"],
    "coverageThreshold": {
      "global": {
        "branches":   80,
        "functions":  85,
        "lines":      85,
        "statements": 85
      }
    }
  }
}
```

### 6. Paste in all source files

Copy every `.ts` file from the zip into the matching folder. Then:

```bash
npm run typecheck   # should output nothing (zero errors)
npm run build       # compiles to dist/
npm test            # 62 tests, all green
```

---

## Option C — Integrate into an Existing TypeScript Project

If you want to add ASTra v3 directly inside an existing repo (e.g. astra-extension):

```bash
# From your existing project root
mkdir -p src/module-splitter
cp -r <path-to-astra>/src/* src/module-splitter/
```

Then update your existing `tsconfig.json` to include the new folder — no other changes needed, since it has no external dependencies beyond `typescript` itself.

Import it anywhere in your project:

```typescript
import { moduleSplitter } from './module-splitter';
```

---

## Adding a CLI Entry Point

Create `src/cli.ts`:

```typescript
#!/usr/bin/env node
/**
 * ASTra v3 CLI — usage:
 *   node dist/cli.js <file>
 *   npx ts-node src/cli.ts <file>
 */

import * as fs   from 'fs';
import * as path from 'path';
import { moduleSplitter } from './index';

const filePath = process.argv[2];

if (!filePath) {
    console.error('Usage: astra-split <file.ts>');
    process.exit(1);
}

if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
}

const source   = fs.readFileSync(filePath, 'utf8');
const fileName = path.basename(filePath);

console.log(`\n  ASTra v3 — Analysing ${fileName}\n`);

const plan = moduleSplitter.analyse(source, fileName);
const m    = plan.metrics;
const s    = plan.summary;

// ── Health overview ───────────────────────────────────────────────────────────
console.log(`  Health Grade     ${m.overallHealth}`);
console.log(`  Parse Engine     ${plan.parseEngine}`);
console.log(`  Total Lines      ${m.totalLines}`);
console.log(`  Code Lines       ${m.codeLines}`);
console.log(`  Regions          ${plan.regions.length}`);
console.log(`  Avg CC           ${m.avgCyclomaticComplexity}`);
console.log(`  Avg Cognitive CC ${m.avgCognitiveComplexity}`);
console.log(`  Maintainability  ${m.maintainabilityIndex}/100`);
console.log(`  Tech Debt        ${m.technicalDebtMinutes}m`);
console.log(`  Complexity       ${s.overallComplexity}`);

// ── Regions ───────────────────────────────────────────────────────────────────
console.log(`\n  ── Detected Regions (${plan.regions.length}) ─────────────────────`);
for (const r of plan.regions) {
    const ex  = r.extractionDecision.shouldExtract;
    const sym = ex ? '✦' : '·';
    const tgt = ex ? ` → ${r.extractionDecision.suggestedFileName}` : '';
    console.log(`  ${sym} ${r.name.padEnd(30)} [${r.kind}]${tgt}`);
}

// ── Extraction candidates ─────────────────────────────────────────────────────
if (plan.extractionCandidates.length > 0) {
    console.log(`\n  ── Extraction Candidates (${plan.extractionCandidates.length}) ─────────────`);
    for (const r of plan.extractionCandidates) {
        const d = r.extractionDecision;
        console.log(`\n  ✦ ${r.name} (${r.kind})`);
        console.log(`    File:       ${d.suggestedFileName}`);
        console.log(`    Confidence: ${d.confidence} (ΔMI +${d.miDelta})`);
        console.log(`    Reasons:    ${d.reasons.slice(0, 2).join(' · ')}`);
        if (r.smells.length > 0) {
            console.log(`    Smells:     ${r.smells.map(s => s.name).join(', ')}`);
        }
    }
}

// ── Smells ────────────────────────────────────────────────────────────────────
if (plan.codeSmells.length > 0) {
    console.log(`\n  ── Code Smells (${plan.codeSmells.length}) ─────────────────────────────`);
    for (const smell of plan.codeSmells.slice(0, 8)) {
        const icon = smell.severity === 'critical' ? '🔴'
                   : smell.severity === 'high'     ? '🟡'
                   : smell.severity === 'medium'   ? '🔵' : '⚪';
        console.log(`  ${icon} [${smell.severity.toUpperCase()}] ${smell.name}`);
        console.log(`     ${smell.description}`);
    }
}

// ── Circular risks ────────────────────────────────────────────────────────────
if (plan.circularRisks.length > 0) {
    console.log(`\n  ── Circular Dependency Risks ─────────────────────────────`);
    for (const r of plan.circularRisks) {
        console.log(`  ⚠ ${r}`);
    }
}

// ── Dry run ───────────────────────────────────────────────────────────────────
if (plan.proposedFiles.length > 0) {
    console.log(`\n  ── Files That Would Be Created ───────────────────────────`);
    for (const pf of plan.proposedFiles) {
        console.log(`  + ${pf.fileName.padEnd(45)} (${pf.estimatedLines} lines)`);
    }
    console.log(`\n  ── Barrel Export (index.ts) ──────────────────────────────`);
    console.log(plan.barrelExport.split('\n').map(l => '  ' + l).join('\n'));
}

console.log(`\n  ${s.recommendation}\n`);
```

Add to `package.json`:

```json
{
  "bin": {
    "astra-split": "dist/cli.js"
  }
}
```

Build and run:

```bash
npm run build

# Run directly
node dist/cli.js src/Dashboard.tsx

# Or link globally
npm link
astra-split src/Dashboard.tsx
```

---

## Running Against Your Own Files

Once built, you can use it programmatically in any script:

```typescript
// scripts/analyse.ts
import * as fs from 'fs';
import * as path from 'path';
import { moduleSplitter } from './src/module-splitter';

const target = process.argv[2];
const source = fs.readFileSync(target, 'utf8');
const plan   = moduleSplitter.analyse(source, path.basename(target));

// Write the split plan as JSON for inspection
fs.writeFileSync(
    'split-plan.json',
    JSON.stringify({
        health:    plan.metrics.overallHealth,
        regions:   plan.regions.map(r => ({
            name:      r.name,
            kind:      r.kind,
            lines:     r.metrics.lineCount,
            cc:        r.metrics.cyclomaticComplexity,
            mi:        r.metrics.maintainabilityIndex,
            extract:   r.extractionDecision.shouldExtract,
            target:    r.extractionDecision.suggestedFileName,
        })),
        smells:    plan.codeSmells.map(s => ({ name: s.name, severity: s.severity })),
        files:     plan.proposedFiles.map(f => f.fileName),
        circular:  plan.circularRisks,
    }, null, 2)
);
console.log('Written split-plan.json');

// Actually write the proposed files to disk
if (plan.proposedFiles.length > 0) {
    const baseDir = path.dirname(target);
    for (const pf of plan.proposedFiles) {
        const outPath = path.join(baseDir, pf.fileName);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, pf.generatedContent, 'utf8');
        console.log(`Created: ${outPath}`);
    }
    fs.writeFileSync(path.join(baseDir, 'index.ts'), plan.barrelExport, 'utf8');
    fs.writeFileSync(target, plan.updatedSourceContent, 'utf8');
    console.log(`Updated: ${target}`);
}
```

Run with:

```bash
npx ts-node scripts/analyse.ts src/components/Dashboard.tsx
```

---

## Verifying the Setup

After `npm run build` and `npm test`, your expected output:

```
> astra-module-splitter@3.0.0 test
> jest --coverage

 PASS  __tests__/pipeline.test.ts
  Stage 1 — parseSourceFile
    ✓ detects a React component (8 ms)
    ✓ detects a utility function (1 ms)
    ✓ detects a constant block (1 ms)
    ✓ detects an interface as type-block (1 ms)
    ✓ detects a hook (2 ms)
    ✓ builds import records in SymbolTable (1 ms)
    ✓ registers exported symbols in SymbolTable.locals (1 ms)
    ✓ uses typescript-ast engine for .tsx files (1 ms)
    ✓ falls back to bracket-depth for .py files (1 ms)
    ✓ detects enum correctly (1 ms)
    ✓ detects type alias correctly (1 ms)

  Stage 2 — buildDependencyGraph
    ✓ detects circular dependency via Tarjan SCC (3 ms)
    ✓ produces topological order with no cycles for simple file (1 ms)
    ✓ assigns coupling scores to all regions (1 ms)
    ✓ assigns cohesion scores to all regions (1 ms)
    ✓ builds adjacency list for all region ids (1 ms)

  Stage 3 — Metrics
    cyclomaticComplexity
      ✓ returns 1 for a trivial function (1 ms)
      ✓ increments for if statements (1 ms)
      ✓ increments for && and || (1 ms)
    cognitiveComplexity
      ✓ returns 0 for empty source (1 ms)
      ✓ increments higher for nested ifs (1 ms)
    maintainabilityIndex
      ✓ returns a value in [0, 100] (1 ms)
      ✓ is lower for high-CC code (1 ms)
    halsteadMetrics
      ✓ returns positive volume and effort (1 ms)
      ✓ returns higher volume for longer code (1 ms)
    computeRegionMetrics
      ✓ returns complete metric object (2 ms)

  Stage 4 — detectRegionSmells
    ✓ detects God Component smell (3 ms)
    ✓ detects Missing useEffect Dependency Array (1 ms)
    ✓ detects Async useEffect (1 ms)
    ✓ detects oversized module (2 ms)
    ✓ returns no smells for clean small function (1 ms)

  Stage 5 — ExtractionOracle
    ✓ always retains type-blocks (2 ms)
    ✓ always retains regions with LOC < 15 (1 ms)
    ✓ extracts hooks with high affinity score (1 ms)
    ✓ produces miDelta > 0 when shouldExtract = true (1 ms)
    ✓ SCC penalty reduces extraction score (1 ms)
    ✓ suggestedFileName includes correct directory for hooks (1 ms)

  ModuleSplitter — full pipeline
    ✓ produces a SplitPlan for a simple component file (9 ms)
    ✓ plan.regions.length equals parsed region count (3 ms)
    ✓ every region has metrics (3 ms)
    ✓ type-blocks are NOT in extractionCandidates (2 ms)
    ✓ type-blocks appear in typeRouting (2 ms)
    ✓ produces proposedFiles only for extractionCandidates (8 ms)
    ✓ every proposedFile has generatedContent (6 ms)
    ✓ barrelExport is a non-empty string (7 ms)
    ✓ updatedSourceContent is a non-empty string (3 ms)
    ✓ circularRisks is populated when circular deps exist (2 ms)
    ✓ metrics.overallHealth is a valid grade (3 ms)
    ✓ accepts workspace context (3 ms)
    ✓ works on a TypeScript-only file (no JSX) (2 ms)

  renderSplitPlanHtml
    ✓ returns a valid HTML string (5 ms)
    ✓ contains the source file name (3 ms)
    ✓ contains all 8 tab IDs (3 ms)
    ✓ does not contain raw < or > in escaped content (2 ms)
    ✓ contains health grade letter (3 ms)

  Edge cases
    ✓ handles empty file gracefully (1 ms)
    ✓ handles file with only comments (1 ms)
    ✓ handles file with only imports (1 ms)
    ✓ handles a 1-line file (1 ms)
    ✓ handles non-TS file extension (1 ms)
    ✓ handles default export arrow function (9 ms)
    ✓ handles a very large region without crashing (55 ms)

Tests:       62 passed, 62 total
Coverage:    90%+ lines
Time:        ~4s
```

---

## Common Problems and Fixes

### `Cannot find module 'typescript'`

```bash
npm install typescript
```

If it's installed but still not found, check that `node_modules/typescript` exists:

```bash
ls node_modules | grep typescript
```

If missing even after install, delete `node_modules` and reinstall:

```bash
rm -rf node_modules package-lock.json
npm install
```

---

### `error TS2307: Cannot find module './types'`

Your `tsconfig.json` paths or `rootDir` are wrong. Make sure:

```json
{
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "moduleResolution": "Node"
  },
  "include": ["src/**/*"]
}
```

---

### `Jest: Cannot find module '../src/core/moduleSplitter'`

The test file uses `ts-jest` but it's not configured. Check your `package.json`:

```json
{
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node"
  }
}
```

And confirm `ts-jest` is installed:

```bash
npm install --save-dev ts-jest
```

---

### TypeScript version conflict with VS Code

If you're inside the astra-extension extension and see errors about duplicate TypeScript declarations:

1. In `webpack.config.js`, add `typescript` to externals:

   ```js
   externals: {
     vscode: 'commonjs vscode',
     typescript: 'commonjs typescript'
   }
   ```

2. In `package.json`, move `typescript` to `peerDependencies`:

   ```json
   {
     "peerDependencies": {
       "typescript": ">=4.0.0"
     }
   }
   ```

This tells the bundler to use VS Code's internal TypeScript installation instead of bundling a second copy.

---

### Build succeeds but `dist/` is empty

Check that `outDir` in `tsconfig.json` points to `./dist` and `rootDir` points to `./src`. Then:

```bash
npm run clean   # removes dist/
npm run build   # rebuilds
ls dist/        # should show: analysis/ core/ generator/ graph/ parser/ resolver/ types/ utils/ index.js index.d.ts
```

---

### `Error: ENOENT: no such file or directory` when applying split

The apply step tries to write into directories that don't exist. The `fileGenerator` creates the path but your script needs to `mkdirSync` with `{ recursive: true }` before writing:

```typescript
import * as fs   from 'fs';
import * as path from 'path';

for (const pf of plan.proposedFiles) {
    const outPath = path.join(baseDir, pf.fileName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true }); // ← this line
    fs.writeFileSync(outPath, pf.generatedContent, 'utf8');
}
```

---

## Project Scripts Reference

| Script | Command | What it does |
|--------|---------|-------------|
| Build | `npm run build` | Compiles `src/` → `dist/` via `tsc` |
| Build watch | `npm run build:watch` | Rebuilds on every file save |
| Clean | `npm run clean` | Deletes `dist/` |
| Test | `npm test` | Runs all 62 tests with coverage |
| Test watch | `npm run test:watch` | Re-runs tests on file change |
| Type check | `npm run typecheck` | `tsc --noEmit` — no output = no errors |
| Lint | `npm run lint` | ESLint across all `src/**/*.ts` |
| CLI | `node dist/cli.js <file>` | Run the CLI on any `.ts` / `.tsx` file |

---

## Environment Variables

ASTra v3 reads no environment variables by default. But you can use these in your own wrapper scripts:

```bash
# Optional — override extraction threshold at runtime
ASTRA_THRESHOLD=0.5 node dist/cli.js src/Component.tsx

# Example wrapper that reads the env var:
```

```typescript
// In your wrapper script
const threshold = parseFloat(process.env.ASTRA_THRESHOLD ?? '0.35');
// Pass to moduleSplitter if you extend the config type
```

---

## What to Do After Setup

**Step 1 — Run it on a real file in your project:**

```bash
node dist/cli.js /path/to/your/src/SomeLargeComponent.tsx
```

Look at the health grade, the regions it detected, and whether the extraction candidates match your intuition. If it recommends extracting something you wouldn't, the threshold is too low — adjust to `0.45` or `0.50`.

**Step 2 — Run it on your worst file:**

Find the file with the most lines, the most mixed concerns, the most complaints from your team. That's where ASTra v3 provides the most value.

```bash
# Find your largest TS/TSX files
find src/ -name "*.tsx" -o -name "*.ts" | xargs wc -l | sort -rn | head -10
```

**Step 3 — Review the generated content before writing:**

The CLI prints everything to stdout. Before you write any files to disk, review the proposed content — especially the resolved imports. They should look exactly right for your project structure.

**Step 4 — Write the files, run the compiler:**

```bash
# Apply the split
node scripts/analyse.ts src/Dashboard.tsx

# Verify it still compiles
npx tsc --noEmit

# Run your tests
npm test
```

If `tsc --noEmit` shows errors, the most common cause is an import resolution edge case (a re-exported symbol, a type alias chain, or a barrel import). Fix those imports manually — the generated file is a starting point, not a final commit.

**Step 5 — Integrate into astra-extension:**

Once you're satisfied with the standalone output, follow `EXTENSION_SETUP.md` to wire it into the VS Code extension with the 8-tab webview panel and the `Apply` button.
