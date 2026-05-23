/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Metrics Engine                                                   ║
 * ║                                                                              ║
 * ║  Computes all code quality metrics per region and per file.                  ║
 * ║                                                                              ║
 * ║  Metrics implemented:                                                         ║
 * ║    ▸ Cyclomatic Complexity   (McCabe 1976)                                   ║
 * ║    ▸ Cognitive Complexity    (Sonar 2018 — EXACT AST walk, replaces approx) ║
 * ║    ▸ Maintainability Index   (SEI/Carnegie Mellon — Oman & Hagemeister 1992) ║
 * ║    ▸ Halstead Volume & Effort (Halstead 1977)                                ║
 * ║    ▸ Testability Score       (custom composite)                              ║
 * ║    ▸ Bundle Weight           (weighted LoC)                                  ║
 * ║    ▸ Technical Debt Minutes  (SQALE-like estimation)                         ║
 * ║    ▸ LCOM4 / TCC / LCC      (class cohesion — class regions only)          ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type {
    ASTRegion,
    RegionMetrics,
    FileMetrics,
    EnrichedRegion,
    HealthGrade,
} from '../types';
import { cognitiveComplexityExact }  from './cognitiveComplexityExact';
import { computeLCOM4 }              from './lcom4';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function count(src: string, re: RegExp): number {
    return (src.match(re) ?? []).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cyclomatic Complexity (McCabe)
// ─────────────────────────────────────────────────────────────────────────────

export function cyclomaticComplexity(src: string): number {
    return (
        1 +
        count(src, /\bif\b/g)     +
        count(src, /\belse\b/g)   +
        count(src, /\bfor\b/g)    +
        count(src, /\bwhile\b/g)  +
        count(src, /\bdo\b/g)     +
        count(src, /\bswitch\b/g) +
        count(src, /\bcase\b/g)   +
        count(src, /\bcatch\b/g)  +
        count(src, /\?\?|\?\./g)  +
        count(src, /&&|\|\|/g)
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive Complexity (SonarSource model)
// Increments for structural nesting AND nesting level multiplier.
// ─────────────────────────────────────────────────────────────────────────────

export function cognitiveComplexity(src: string): number {
    const lines  = src.split('\n');
    let score    = 0;
    let nesting  = 0;

    const NEST_INC  = /^\s*(?:if|else\s+if|for|while|do|switch|catch|(?:function|=>\s*\{))/;
    const NEST_DEC  = /^\s*\}/;
    const FLAT_INC  = /^\s*(?:else|case|default|break\s+\w|continue|goto)/;
    const BOOL_CONN = /&&|\|\||!(?!=)/g;

    for (const line of lines) {
        const trimmed = line.trim();
        if (NEST_INC.test(trimmed)) {
            score   += 1 + nesting;
            nesting += 1;
        } else if (FLAT_INC.test(trimmed)) {
            score += 1;
        }
        if (NEST_DEC.test(trimmed) && nesting > 0) {
            nesting -= 1;
        }
        // Boolean connective operators add 1 each, regardless of nesting
        score += count(line, BOOL_CONN);
    }

    return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Halstead Metrics (operator/operand vocabulary model)
// ─────────────────────────────────────────────────────────────────────────────

interface HalsteadMetrics {
    volume: number;
    effort: number;
    difficulty: number;
    time: number;       // estimated programming time in seconds
    bugs: number;       // estimated delivered bugs
}

export function halsteadMetrics(src: string): HalsteadMetrics {
    // Operators: symbols, keywords that branch/combine
    const operators = src.match(
        /[\+\-\*\/\%\=\!\<\>]=?|&&|\|\||\?\?|=>|::|[\(\)\[\]\{\},;:\?]|\b(?:if|else|for|while|do|switch|case|break|return|typeof|instanceof|in|of|new|delete|void|throw|catch|finally|import|export)\b/g
    ) ?? [];

    // Operands: identifiers, literals
    const operands = src.match(
        /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b|"[^"]*"|'[^']*'|`[^`]*`|\b\d+(?:\.\d+)?\b/g
    ) ?? [];

    const n1 = new Set(operators).size || 1;   // distinct operators
    const n2 = new Set(operands).size  || 1;   // distinct operands
    const N1 = operators.length         || 1;  // total operators
    const N2 = operands.length          || 1;  // total operands

    const vocabulary = n1 + n2;
    const length     = N1 + N2;
    const volume     = length * Math.log2(vocabulary);
    const difficulty = (n1 / 2) * (N2 / n2);
    const effort     = difficulty * volume;
    const time       = effort / 18;             // Halstead programming time model
    const bugs       = Math.pow(effort, 2/3) / 3000;

    return {
        volume:     Math.round(volume),
        effort:     Math.round(effort),
        difficulty: Math.round(difficulty * 10) / 10,
        time:       Math.round(time),
        bugs:       Math.round(bugs * 100) / 100,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintainability Index (SEI formula, normalised 0–100)
// MI = 171 - 5.2*ln(V) - 0.23*CC - 16.2*ln(LOC)
// ─────────────────────────────────────────────────────────────────────────────

export function maintainabilityIndex(
    src: string,
    lineCount: number,
    cc: number
): number {
    const tokens = src.match(/\b[a-zA-Z_$]\w*\b/g) ?? [];
    const unique = new Set(tokens).size;
    const hv     = unique > 1 ? unique * Math.log2(unique) : 1;
    const loc    = Math.max(1, lineCount);
    const raw    = 171 - 5.2 * Math.log(hv) - 0.23 * cc - 16.2 * Math.log(loc);
    return Math.max(0, Math.min(100, Math.round((raw * 100) / 171)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Testability Score (0–100, higher = easier to test)
// ─────────────────────────────────────────────────────────────────────────────

export function testabilityScore(
    region: ASTRegion,
    cc: number,
    nesting: number
): number {
    let score = 100;
    score -= Math.min(40, cc * 3);           // complexity penalty
    score -= Math.min(20, nesting * 4);      // deep nesting harder to test
    score -= region.hasAsyncOps ? 10 : 0;   // async adds test complexity
    score -= region.hasJSX      ? 5  : 0;   // JSX needs render testing
    // Hooks are highly testable via renderHook
    if (region.kind === 'hook') score += 10;
    // Pure utility functions are most testable
    if (region.kind === 'utility-function' && !region.hasAsyncOps) score += 15;
    return Math.max(0, Math.min(100, score));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle weight estimation (weighted LoC)
// ─────────────────────────────────────────────────────────────────────────────

const KIND_WEIGHT: Record<string, number> = {
    'react-component': 2.0,
    'hook':            1.5,
    'context-provider': 1.8,
    'hoc':             1.6,
    'class':           1.8,
    'utility-function': 1.0,
    'constant-block':  0.5,
    'type-block':      0.1,  // types are stripped at compile time
    'enum':            0.4,
    'namespace':       1.2,
};

export function bundleWeight(kind: string, lineCount: number): number {
    return Math.round(lineCount * (KIND_WEIGHT[kind] ?? 1.0) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Technical Debt (SQALE-inspired, minutes)
// ─────────────────────────────────────────────────────────────────────────────

export function technicalDebtMinutes(
    cc: number,
    mi: number,
    lineCount: number,
    smellCount: number
): number {
    let debt = 0;
    if (cc > 10)      debt += (cc - 10) * 5;    // 5 min per extra CC point
    if (mi < 50)      debt += (50 - mi) * 2;    // 2 min per MI point below 50
    if (lineCount > 100) debt += (lineCount - 100) * 0.5;
    debt += smellCount * 15;                     // 15 min per smell
    return Math.round(debt);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-region metric computation
// ─────────────────────────────────────────────────────────────────────────────

export function computeRegionMetrics(
    region: ASTRegion,
    smellCount: number
): RegionMetrics {
    const src         = region.lines.join('\n');
    const lineCount   = region.lines.length;
    const blankLines  = region.lines.filter(l => l.trim() === '').length;
    const commentLines= region.lines.filter(
        l => l.trim().startsWith('//') || l.trim().startsWith('*')
    ).length;
    const codeLines   = lineCount - blankLines - commentLines;
    const cc          = cyclomaticComplexity(src);

    // Exact AST-walk cognitive complexity (replaces line-level approximation)
    const cog         = cognitiveComplexityExact(src);

    const mi          = maintainabilityIndex(src, lineCount, cc);
    const hal         = halsteadMetrics(src);
    const test        = testabilityScore(region, cc, region.maxBracketDepth);
    const bw          = bundleWeight(region.kind, codeLines);
    const _debt       = technicalDebtMinutes(cc, mi, lineCount, smellCount); void _debt;

    // LCOM4 cohesion — only computed for class and decorator regions
    let lcom4: number | undefined;
    let tcc:   number | undefined;
    let lcc:   number | undefined;
    if (region.kind === 'class' || region.kind === 'decorator') {
        try {
            const lcomResult = computeLCOM4(src);
            if (lcomResult.methodCount > 0) {
                lcom4 = lcomResult.lcom4;
                tcc   = lcomResult.tcc;
                lcc   = lcomResult.lcc;
            }
        } catch { /* non-fatal — LCOM4 is optional enrichment */ }
    }

    return {
        lineCount, codeLines, commentLines, blankLines,
        cyclomaticComplexity: cc,
        cognitiveComplexity:  cog,
        nestingDepth:         region.maxBracketDepth,
        maintainabilityIndex: mi,
        halsteadVolume:       hal.volume,
        halsteadEffort:       hal.effort,
        bundleWeight:         bw,
        testabilityScore:     test,
        lcom4, tcc, lcc,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// File-level aggregated metrics
// ─────────────────────────────────────────────────────────────────────────────

function healthGrade(mi: number, avgCC: number): HealthGrade {
    if (mi > 85 && avgCC < 4)  return 'S';
    if (mi > 70 && avgCC < 6)  return 'A';
    if (mi > 55 && avgCC < 9)  return 'B';
    if (mi > 40 && avgCC < 13) return 'C';
    if (mi > 25 && avgCC < 18) return 'D';
    return 'F';
}

export function computeFileMetrics(
    sourceCode: string,
    enrichedRegions: EnrichedRegion[]
): FileMetrics {
    const lines        = sourceCode.split('\n');
    const blankLines   = lines.filter(l => l.trim() === '').length;
    const commentLines = lines.filter(
        l => l.trim().startsWith('//') || l.trim().startsWith('*')
    ).length;
    const codeLines = lines.length - blankLines - commentLines;

    const ccs   = enrichedRegions.map(r => r.metrics.cyclomaticComplexity);
    const cogs  = enrichedRegions.map(r => r.metrics.cognitiveComplexity);
    const nests = enrichedRegions.map(r => r.metrics.nestingDepth);
    const mis   = enrichedRegions.map(r => r.metrics.maintainabilityIndex);

    const avg = (arr: number[]) =>
        arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const max = (arr: number[]) =>
        arr.length ? Math.max(...arr) : 0;

    const avgCC = Math.round(avg(ccs) * 10) / 10;
    const avgMI = Math.round(avg(mis));

    // Duplicate logic risk — token frequency analysis
    const tokenFreq: Record<string, number> = {};
    for (const m of (sourceCode.match(/\b[a-zA-Z_]\w{3,}\b/g) ?? [])) {
        tokenFreq[m] = (tokenFreq[m] ?? 0) + 1;
    }
    const dupRisk = Math.min(1,
        Object.values(tokenFreq).filter(v => v > 5).length / 30
    );

    const totalDebt = enrichedRegions.reduce((s, r) =>
        s + technicalDebtMinutes(
            r.metrics.cyclomaticComplexity,
            r.metrics.maintainabilityIndex,
            r.metrics.lineCount,
            r.smells.length
        ), 0
    );

    return {
        totalLines: lines.length,
        codeLines,
        blankLines,
        commentLines,
        avgCyclomaticComplexity: avgCC,
        maxCyclomaticComplexity: max(ccs),
        avgCognitiveComplexity: Math.round(avg(cogs) * 10) / 10,
        avgNestingDepth: Math.round(avg(nests) * 10) / 10,
        maxNestingDepth: max(nests),
        maintainabilityIndex: avgMI,
        halsteadVolume: Math.round(avg(enrichedRegions.map(r => r.metrics.halsteadVolume))),
        bundleImpactScore: enrichedRegions.reduce((s, r) => s + r.metrics.bundleWeight, 0),
        duplicateLogicRisk: Math.round(dupRisk * 100) / 100,
        technicalDebtMinutes: totalDebt,
        overallHealth: healthGrade(avgMI, avgCC),
    };
}
