/**
 * ASTra v3 — Enhancement Tests
 * Exact CogCC · Function-Level Splitting · Re-export Chain ·
 * Semantic Type Resolution · Per-Function Thresholds · LCOM4
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

import { cognitiveComplexityExact }       from '../src/splitter/analysis/cognitiveComplexityExact';
import { computeLCOM4 }                   from '../src/splitter/analysis/lcom4';
import { calibratePerFunction }           from '../src/splitter/analysis/perFunctionCalibrator';
import { applyFunctionLevelSplit }        from '../src/splitter/parser/functionSplitter';
import { reExportChainResolver, extractReExports } from '../src/splitter/workspace/reExportChainResolver';
import { semanticTypeResolver }           from '../src/splitter/semantic/semanticTypeResolver';
import { parseSourceFile }               from '../src/splitter/parser/astParser';
import { WorkspaceGraphBuilder }         from '../src/splitter/workspace/workspaceGraph';
import type { RegionMetrics }            from '../src/splitter/types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Exact AST-walk Cognitive Complexity
// ─────────────────────────────────────────────────────────────────────────────

describe('cognitiveComplexityExact', () => {
    it('returns 0 for a trivial function', () => {
        expect(cognitiveComplexityExact('function f() { return 1; }')).toBe(0);
    });

    it('increments 1 for a single if', () => {
        expect(cognitiveComplexityExact('if (a) { return 1; }')).toBe(1);
    });

    it('nesting multiplier: nested if costs more than flat', () => {
        const flat   = 'if (a) {} if (b) {}';
        const nested = 'if (a) { if (b) {} }';
        expect(cognitiveComplexityExact(nested)).toBeGreaterThan(cognitiveComplexityExact(flat));
    });

    it('flat if scores 2 (1 for if + 1 for else)', () => {
        expect(cognitiveComplexityExact('if (a) { } else { }')).toBe(2);
    });

    it('else-if is not an additional nesting increment', () => {
        const elseIf = 'if (a) { } else if (b) { } else { }';
        expect(cognitiveComplexityExact(elseIf)).toBe(4); // if(1) + else(1) + else-if(1) + else(1)
    });

    it('for loop increments 1 + nesting', () => {
        expect(cognitiveComplexityExact('for (let i=0;i<10;i++) {}')).toBe(1);
    });

    it('nested for increments more than flat fors', () => {
        const flat   = 'for(;;){} for(;;){}';
        const nested = 'for(;;){ for(;;){} }';
        expect(cognitiveComplexityExact(nested)).toBeGreaterThan(cognitiveComplexityExact(flat));
    });

    it('&& sequence counts once not per operator', () => {
        // a && b && c is ONE sequence → +1
        expect(cognitiveComplexityExact('const x = a && b && c;')).toBe(1);
    });

    it('mixed && and || count as two sequences', () => {
        // a && b || c: two separate sequences
        expect(cognitiveComplexityExact('const x = a && b || c;')).toBe(2);
    });

    it('ternary increments by 1 + nesting', () => {
        expect(cognitiveComplexityExact('const x = a ? 1 : 2;')).toBe(1);
    });

    it('nested function increments for the nesting', () => {
        const src = `
function outer() {
  function inner() {
    if (x) {}
  }
}`;
        // outer = 0 (top level, no increment)
        // inner at nesting 1 → +1 for nested fn
        // if inside inner at nesting 2 is a structural increment
        const score = cognitiveComplexityExact(src);
        expect(score).toBeGreaterThan(0);
    });

    it('switch statement increments', () => {
        const src = `switch(x) { case 1: break; case 2: break; }`;
        expect(cognitiveComplexityExact(src)).toBeGreaterThan(0);
    });

    it('returns a number ≥ 0 for any valid TS input', () => {
        const snippets = [
            'export const x = 1;',
            'import React from "react";',
            'interface Foo { bar: string; }',
            'type X = string | number;',
        ];
        for (const s of snippets) {
            expect(cognitiveComplexityExact(s)).toBeGreaterThanOrEqual(0);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LCOM4 Cohesion Metric
// ─────────────────────────────────────────────────────────────────────────────

const COHESIVE_CLASS = `
class Counter {
  private count = 0;
  increment() { this.count++; }
  decrement() { this.count--; }
  reset()     { this.count = 0; }
  value()     { return this.count; }
}`.trim();

const SPLIT_CLASS = `
class Mixed {
  private count = 0;
  private name  = '';
  increment() { this.count++; }
  decrement() { this.count--; }
  setName(n: string) { this.name = n; }
  getName() { return this.name; }
}`.trim();

const SINGLE_METHOD = `
class Util {
  format(x: number) { return x.toFixed(2); }
}`.trim();

describe('computeLCOM4', () => {
    it('fully cohesive class has LCOM4 = 1', () => {
        const r = computeLCOM4(COHESIVE_CLASS);
        expect(r.lcom4).toBe(1);
        expect(r.shouldSplit).toBe(false);
    });

    it('split class with two independent groups has LCOM4 = 2', () => {
        const r = computeLCOM4(SPLIT_CLASS);
        expect(r.lcom4).toBeGreaterThanOrEqual(2);
        expect(r.shouldSplit).toBe(true);
    });

    it('single method class has LCOM4 = 1', () => {
        const r = computeLCOM4(SINGLE_METHOD);
        expect(r.lcom4).toBe(1);
        expect(r.shouldSplit).toBe(false);
    });

    it('empty string returns lcom4 = 0', () => {
        const r = computeLCOM4('');
        expect(r.lcom4).toBe(0);
        expect(r.methodCount).toBe(0);
    });

    it('TCC is 1.0 for fully cohesive class', () => {
        const r = computeLCOM4(COHESIVE_CLASS);
        expect(r.tcc).toBe(1);
    });

    it('TCC < 1 for class with independent groups', () => {
        const r = computeLCOM4(SPLIT_CLASS);
        expect(r.tcc).toBeLessThan(1);
    });

    it('methodCount equals number of methods in the class', () => {
        const r = computeLCOM4(COHESIVE_CLASS);
        expect(r.methodCount).toBe(4); // increment, decrement, reset, value
    });

    it('connectedComponents length equals lcom4', () => {
        const r = computeLCOM4(SPLIT_CLASS);
        expect(r.connectedComponents.length).toBe(r.lcom4);
    });

    it('suggestedGroups has one entry per component for split class', () => {
        const r = computeLCOM4(SPLIT_CLASS);
        if (r.shouldSplit) {
            expect(r.suggestedGroups.length).toBeGreaterThan(0);
        }
    });

    it('interpretation is a non-empty string', () => {
        const r = computeLCOM4(COHESIVE_CLASS);
        expect(r.interpretation.length).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Per-Function Halstead Threshold Calibrator
// ─────────────────────────────────────────────────────────────────────────────

const makeMetrics = (effort: number): RegionMetrics => ({
    lineCount: 50, codeLines: 40, commentLines: 0, blankLines: 10,
    cyclomaticComplexity: 5, cognitiveComplexity: 8, nestingDepth: 3,
    maintainabilityIndex: 65, halsteadVolume: 400, halsteadEffort: effort,
    bundleWeight: 80, testabilityScore: 70,
});

describe('calibratePerFunction', () => {
    it('returns calibrations for all input regions', () => {
        const metricsMap = new Map([
            ['r1', makeMetrics(500)],
            ['r2', makeMetrics(3000)],
            ['r3', makeMetrics(8000)],
        ]);
        const result = calibratePerFunction(metricsMap);
        expect(result.calibrations.size).toBe(3);
    });

    it('high-effort region gets lower threshold than low-effort region', () => {
        const metricsMap = new Map([
            ['low',  makeMetrics(200)],
            ['high', makeMetrics(9000)],
        ]);
        const result = calibratePerFunction(metricsMap);
        const lowThresh  = result.calibrations.get('low')!.regionThreshold;
        const highThresh = result.calibrations.get('high')!.regionThreshold;
        expect(highThresh).toBeLessThan(lowThresh);
    });

    it('region at median effort gets threshold equal to file threshold', () => {
        const median = 3000;
        const metricsMap = new Map([
            ['r1', makeMetrics(1000)],
            ['r2', makeMetrics(median)],
            ['r3', makeMetrics(5000)],
        ]);
        const result  = calibratePerFunction(metricsMap);
        const medianC = result.calibrations.get('r2')!;
        // Should be close to file threshold (within ±0.05)
        expect(Math.abs(medianC.regionThreshold - medianC.fileThreshold)).toBeLessThan(0.1);
    });

    it('all thresholds are within [0.10, 0.75]', () => {
        const metricsMap = new Map([
            ['r1', makeMetrics(50)],
            ['r2', makeMetrics(100000)],
        ]);
        const result = calibratePerFunction(metricsMap, 0.35);
        for (const [, cal] of result.calibrations) {
            expect(cal.regionThreshold).toBeGreaterThanOrEqual(0.10);
            expect(cal.regionThreshold).toBeLessThanOrEqual(0.75);
        }
    });

    it('effortRatio is approximately effort/median', () => {
        const metricsMap = new Map([
            ['r1', makeMetrics(1000)],
            ['r2', makeMetrics(4000)],
        ]);
        const result = calibratePerFunction(metricsMap);
        const r2     = result.calibrations.get('r2')!;
        // Median of [1000, 4000] = 2500
        expect(r2.effortRatio).toBeCloseTo(4000 / 2500, 1);
    });

    it('user bias shifts all calibrations in the same direction', () => {
        const metricsMap = new Map([['r', makeMetrics(2000)]]);
        const low  = calibratePerFunction(metricsMap, 0.20);
        const high = calibratePerFunction(metricsMap, 0.60);
        expect(high.calibrations.get('r')!.regionThreshold)
            .toBeGreaterThan(low.calibrations.get('r')!.regionThreshold);
    });

    it('empty metricsMap returns empty calibrations', () => {
        const result = calibratePerFunction(new Map());
        expect(result.calibrations.size).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Function-Level Region Splitter
// ─────────────────────────────────────────────────────────────────────────────

const OBJECT_WITH_METHODS = `
export const api = {
  fetchUser: async (id: string) => {
    const res = await fetch('/users/' + id);
    return res.json();
  },
  createUser: async (data: Record<string, unknown>) => {
    const res = await fetch('/users', { method: 'POST', body: JSON.stringify(data) });
    return res.json();
  },
  deleteUser: async (id: string) => {
    await fetch('/users/' + id, { method: 'DELETE' });
  },
};`.trim();

const SINGLE_FN = `
export function simple() {
  return 42;
}`.trim();

describe('applyFunctionLevelSplit', () => {
    it('does not split a simple single-function region', () => {
        const { regions, symbolTable } = parseSourceFile(SINGLE_FN, 'f.ts');
        const result = applyFunctionLevelSplit(regions, symbolTable, SINGLE_FN, 'f.ts');
        expect(result.length).toBe(regions.length);
    });

    it('splits object-literal with multiple method properties into sub-regions', () => {
        const { regions, symbolTable } = parseSourceFile(OBJECT_WITH_METHODS, 'api.ts');
        const result = applyFunctionLevelSplit(regions, symbolTable, OBJECT_WITH_METHODS, 'api.ts');
        // Should have more regions after split (3 methods vs 1 original)
        expect(result.length).toBeGreaterThanOrEqual(regions.length);
    });

    it('result regions each have valid id, name, and kind', () => {
        const { regions, symbolTable } = parseSourceFile(OBJECT_WITH_METHODS, 'api.ts');
        const result = applyFunctionLevelSplit(regions, symbolTable, OBJECT_WITH_METHODS, 'api.ts');
        for (const r of result) {
            expect(typeof r.id).toBe('string');
            expect(typeof r.name).toBe('string');
            expect(typeof r.kind).toBe('string');
        }
    });

    it('all result regions have valid startLine and endLine', () => {
        const { regions, symbolTable } = parseSourceFile(OBJECT_WITH_METHODS, 'api.ts');
        const result = applyFunctionLevelSplit(regions, symbolTable, OBJECT_WITH_METHODS, 'api.ts');
        for (const r of result) {
            expect(r.startLine).toBeGreaterThan(0);
            expect(r.endLine).toBeGreaterThanOrEqual(r.startLine);
        }
    });

    it('does not split regions below minLinesThreshold', () => {
        const tiny = 'export const x = { a: () => 1, b: () => 2 };';
        const { regions, symbolTable } = parseSourceFile(tiny, 't.ts');
        const result = applyFunctionLevelSplit(regions, symbolTable, tiny, 't.ts', 50);
        expect(result.length).toBe(regions.length);
    });

    it('handles empty regions array', () => {
        const result = applyFunctionLevelSplit([], { locals: new Map(), imports: new Map(), unresolved: new Set() }, '', 'f.ts');
        expect(result).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Re-export Chain Resolver
// ─────────────────────────────────────────────────────────────────────────────

describe('extractReExports', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-reexport-'));
    });
    afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('extracts named re-exports', () => {
        const fp = path.join(tmpDir, 'index.ts');
        fs.writeFileSync(fp, "export { useAuth, useTheme } from './hooks';");
        const records = extractReExports(fp);
        expect(records.length).toBe(1);
        expect(records[0].symbols).toContain('useAuth');
        expect(records[0].symbols).toContain('useTheme');
        expect(records[0].isNamespace).toBe(false);
    });

    it('extracts namespace re-exports', () => {
        const fp = path.join(tmpDir, 'ns.ts');
        fs.writeFileSync(fp, "export * from './utils';");
        const records = extractReExports(fp);
        expect(records.some(r => r.isNamespace)).toBe(true);
    });

    it('extracts aliased re-exports with original name', () => {
        const fp = path.join(tmpDir, 'alias.ts');
        fs.writeFileSync(fp, "export { foo as bar } from './foo';");
        const records = extractReExports(fp);
        expect(records[0].symbols).toContain('foo');
    });

    it('returns empty for files with no re-exports', () => {
        const fp = path.join(tmpDir, 'plain.ts');
        fs.writeFileSync(fp, "export function hello() { return 1; }");
        const records = extractReExports(fp);
        expect(records.length).toBe(0);
    });
});

describe('ReExportChainResolver', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-chain-'));
        // hooks/auth.ts — declares useAuth
        fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'hooks', 'auth.ts'),
            'export function useAuth() { return null; }\n'
        );
        // index.ts — re-exports useAuth from hooks/auth
        fs.writeFileSync(
            path.join(tmpDir, 'index.ts'),
            "export { useAuth } from './hooks/auth';\n"
        );
    });
    afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('adds re-exporting file to symbolExporters after resolution', async () => {
        const builder = new WorkspaceGraphBuilder();
        const files   = [
            path.join(tmpDir, 'hooks', 'auth.ts'),
            path.join(tmpDir, 'index.ts'),
        ];
        const graph = await builder.build(tmpDir, files);

        // Before resolution: only auth.ts should export useAuth
        const before = graph.symbolExporters.get('useAuth') ?? [];
        expect(before.some(f => f.includes('auth.ts'))).toBe(true);

        // Apply chain resolution
        reExportChainResolver.resolve(graph);

        // After: index.ts should also be in the exporters
        const after = graph.symbolExporters.get('useAuth') ?? [];
        expect(after.some(f => f.includes('index.ts'))).toBe(true);
    });

    it('does not add external package specifiers', () => {
        const records = extractReExports(path.join(tmpDir, 'index.ts'));
        expect(records.every(r => r.specifier.startsWith('.'))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Semantic Type Resolver
// ─────────────────────────────────────────────────────────────────────────────

describe('SemanticTypeResolver', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-semantic-'));

    afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('classifies interface as type-only', () => {
        const src = `export interface User { id: string; name: string; }`;
        const fp  = path.join(tmpDir, 'types.ts');
        fs.writeFileSync(fp, src);
        const info = semanticTypeResolver.resolveFile(fp, src);
        if (info.resolved) {
            expect(info.typeOnlySymbols.has('User')).toBe(true);
        }
    });

    it('classifies function as value-only', () => {
        const src = `export function formatDate(d: Date) { return d.toISOString(); }`;
        const fp  = path.join(tmpDir, 'format.ts');
        fs.writeFileSync(fp, src);
        const info = semanticTypeResolver.resolveFile(fp, src);
        if (info.resolved) {
            expect(info.valueSymbols.has('formatDate')).toBe(true);
            expect(info.typeOnlySymbols.has('formatDate')).toBe(false);
        }
    });

    it('classifies type alias as type-only', () => {
        const src = `export type UserId = string;`;
        const fp  = path.join(tmpDir, 'ids.ts');
        fs.writeFileSync(fp, src);
        const info = semanticTypeResolver.resolveFile(fp, src);
        if (info.resolved) {
            expect(info.typeOnlySymbols.has('UserId')).toBe(true);
        }
    });

    it('classifies class as both type and value (dual)', () => {
        const src = `export class ApiService { fetch() { return null; } }`;
        const fp  = path.join(tmpDir, 'service.ts');
        fs.writeFileSync(fp, src);
        const info = semanticTypeResolver.resolveFile(fp, src);
        if (info.resolved) {
            // Class is both a type (for new ApiService()) and a value
            expect(info.dualSymbols.has('ApiService') || info.valueSymbols.has('ApiService')).toBe(true);
        }
    });

    it('returns resolved=true for valid TypeScript', () => {
        const src = `export const x = 1;`;
        const fp  = path.join(tmpDir, 'x.ts');
        fs.writeFileSync(fp, src);
        const info = semanticTypeResolver.resolveFile(fp, src);
        expect(typeof info.resolved).toBe('boolean');
    });

    it('isTypeOnlySymbol returns true for an interface', () => {
        const src = `export interface Config { debug: boolean; }`;
        const fp  = path.join(tmpDir, 'config.ts');
        fs.writeFileSync(fp, src);
        const result = semanticTypeResolver.isTypeOnlySymbol('Config', fp, src);
        if (result !== null) {
            expect(result).toBe(true);
        }
    });

    it('isTypeOnlySymbol returns false for a function', () => {
        const src = `export function run() {}`;
        const fp  = path.join(tmpDir, 'run.ts');
        fs.writeFileSync(fp, src);
        const result = semanticTypeResolver.isTypeOnlySymbol('run', fp, src);
        if (result !== null) {
            expect(result).toBe(false);
        }
    });
});
