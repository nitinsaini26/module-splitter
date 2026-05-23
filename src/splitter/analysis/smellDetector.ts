/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Code Smell Detector                                             ║
 * ║                                                                              ║
 * ║  Detects 20+ code smells across React, TypeScript, and general patterns.    ║
 * ║  Each smell carries severity, description, affected regions, and an         ║
 * ║  auto-fix flag indicating whether the splitter can remediate it.            ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type { ASTRegion, CodeSmell, RegionKind } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Per-region smell detection
// ─────────────────────────────────────────────────────────────────────────────

function count(src: string, re: RegExp): number {
    return (src.match(re) ?? []).length;
}

export interface RegionSmell {
    name: string;
    severity: CodeSmell['severity'];
    description: string;
    recommendation: string;
    autoFixable: boolean;
}

export function detectRegionSmells(
    region: ASTRegion,
    lineCount: number,
    cc: number,
    nesting: number
): RegionSmell[] {
    const smells: RegionSmell[] = [];
    const src = region.lines.join('\n');
    const kind: RegionKind = region.kind;

    // ── React-specific smells ────────────────────────────────────────────────

    if (kind === 'react-component' || kind === 'context-provider') {
        let concerns = 0;
        if (/useState|useReducer/.test(src))         concerns++;
        if (/useEffect/.test(src))                   concerns++;
        if (/fetch|axios|useSWR|useQuery/.test(src)) concerns++;
        if (/\.(map|filter|reduce)\(/.test(src))     concerns++;
        if (/styled\.|css`|className/.test(src))     concerns++;
        if (/dispatch|createSlice|useSelector/.test(src)) concerns++;

        if (concerns >= 4) {
            smells.push({
                name: 'God Component',
                severity: 'critical',
                description: `Component handles ${concerns} distinct concerns (state, effects, data-fetching, transforms, styles, store)`,
                recommendation: 'Extract each concern into dedicated hooks and sub-components',
                autoFixable: true,
            });
        }

        // Prop drilling detection (props.x.y.z)
        if (count(src, /props\.\w+\.\w+\.\w+/g) >= 2) {
            smells.push({
                name: 'Prop Drilling',
                severity: 'high',
                description: 'Props passed through multiple levels (>2 depth)',
                recommendation: 'Introduce React Context or a custom hook to pass shared state',
                autoFixable: false,
            });
        }

        // Mixed API + render
        if (/fetch\(|axios\.|\.then\(/.test(src) && /<[A-Z][\w]*/.test(src)) {
            smells.push({
                name: 'Mixed Concerns — API + Render',
                severity: 'high',
                description: 'Data-fetching logic co-located with JSX render',
                recommendation: 'Extract API calls into a dedicated custom hook',
                autoFixable: true,
            });
        }

        // Excessive inline styles
        if (count(src, /style\s*=\s*\{\{/g) > 3) {
            smells.push({
                name: 'Excessive Inline Styles',
                severity: 'low',
                description: 'More than 3 inline style objects in component',
                recommendation: 'Move inline styles to CSS modules or styled-components',
                autoFixable: false,
            });
        }

        // Missing useMemo on mapped JSX
        if (
            !/useCallback|useMemo/.test(src) &&
            /\.map\(.*=>\s*</.test(src) &&
            lineCount > 40
        ) {
            smells.push({
                name: 'Missing Memoisation on Mapped JSX',
                severity: 'medium',
                description: 'JSX map() without useMemo may cause unnecessary re-renders',
                recommendation: 'Wrap the mapped array in useMemo(() => ..., [dep]) or extract to a sub-component',
                autoFixable: false,
            });
        }

        // Direct DOM manipulation in React
        if (/document\.(getElementById|querySelector|createElement)/.test(src)) {
            smells.push({
                name: 'Direct DOM Manipulation',
                severity: 'high',
                description: 'Direct DOM access bypasses React reconciliation',
                recommendation: 'Use useRef for element references and React portals for out-of-tree renders',
                autoFixable: false,
            });
        }

        // setState in render body (outside useEffect)
        if (/setState\(|useState/.test(src) && !/<\w/.test(src) === false) {
            if (/setState\([^)]*\)(?!\s*,\s*\(\))/.test(src) && !/useEffect/.test(src)) {
                smells.push({
                    name: 'SetState Outside Effect',
                    severity: 'critical',
                    description: 'Calling setState directly in render body causes infinite re-render',
                    recommendation: 'Move state updates inside useEffect or event handlers',
                    autoFixable: false,
                });
            }
        }
    }

    // ── Hook-specific smells ─────────────────────────────────────────────────

    if (kind === 'hook') {
        // Missing dependency array in useEffect
        if (/useEffect\s*\(\s*(?:async\s*)?\(\s*\)\s*=>/.test(src) && !/,\s*\[/.test(src)) {
            smells.push({
                name: 'Missing useEffect Dependency Array',
                severity: 'high',
                description: 'useEffect without dependency array runs on every render',
                recommendation: 'Add a dependency array: useEffect(() => {...}, [dep1, dep2])',
                autoFixable: false,
            });
        }

        // Async directly in useEffect (should use IIFE)
        if (/useEffect\s*\(\s*async/.test(src)) {
            smells.push({
                name: 'Async useEffect',
                severity: 'medium',
                description: 'useEffect callback should not be async directly',
                recommendation: 'Use an inner async IIFE: useEffect(() => { const run = async () => {...}; run(); }, [])',
                autoFixable: false,
            });
        }
    }

    // ── General smells ───────────────────────────────────────────────────────

    if (lineCount > 200) {
        smells.push({
            name: 'Oversized Module (>200 lines)',
            severity: 'critical',
            description: `Region is ${lineCount} lines — well beyond single-responsibility threshold`,
            recommendation: 'Split into smaller, focused modules (target: <80 lines each)',
            autoFixable: true,
        });
    } else if (lineCount > 100) {
        smells.push({
            name: 'Large Module (>100 lines)',
            severity: 'high',
            description: `Region is ${lineCount} lines`,
            recommendation: 'Consider splitting into smaller, focused modules',
            autoFixable: true,
        });
    }

    if (nesting > 8) {
        smells.push({
            name: 'Extreme Nesting (>8 levels)',
            severity: 'critical',
            description: `Maximum bracket depth is ${nesting}`,
            recommendation: 'Flatten nesting with early returns, guard clauses, or extracted helper functions',
            autoFixable: false,
        });
    } else if (nesting > 5) {
        smells.push({
            name: 'Deep Nesting (>5 levels)',
            severity: 'medium',
            description: `Maximum bracket depth is ${nesting}`,
            recommendation: 'Refactor using early returns or helper functions to reduce nesting',
            autoFixable: false,
        });
    }

    if (cc > 20) {
        smells.push({
            name: 'Extreme Cyclomatic Complexity (>20)',
            severity: 'critical',
            description: `Cyclomatic complexity is ${cc} — extremely hard to test`,
            recommendation: 'Break into smaller functions; aim for CC ≤ 10 per function',
            autoFixable: true,
        });
    } else if (cc > 10) {
        smells.push({
            name: 'High Cyclomatic Complexity (>10)',
            severity: 'high',
            description: `Cyclomatic complexity is ${cc}`,
            recommendation: 'Reduce branching by extracting conditional logic into named predicates',
            autoFixable: true,
        });
    }

    // Magic numbers
    if (count(src, /\b(?<!['"./])(?!0\.)\d{2,}\b(?!['"./])/g) > 4) {
        smells.push({
            name: 'Magic Numbers',
            severity: 'low',
            description: 'Hard-coded numeric literals scattered through code',
            recommendation: 'Extract to named constants (e.g. const MAX_RETRIES = 3)',
            autoFixable: false,
        });
    }

    // Long switch statement
    if (count(src, /\bcase\b/g) > 8) {
        smells.push({
            name: 'Long Switch Statement',
            severity: 'medium',
            description: `Switch has ${count(src, /\bcase\b/g)} cases`,
            recommendation: 'Replace with a lookup map/object or strategy pattern',
            autoFixable: false,
        });
    }

    // TODO / FIXME debt
    if (count(src, /\/\/.*(?:TODO|FIXME|HACK|XXX)/g) > 2) {
        smells.push({
            name: 'TODO/FIXME Debt',
            severity: 'low',
            description: `${count(src, /\/\/.*(?:TODO|FIXME|HACK|XXX)/g)} unresolved TODO/FIXME comments`,
            recommendation: 'Resolve or track in issue tracker; remove inline debt comments',
            autoFixable: false,
        });
    }

    // Console logs in production code
    if (count(src, /\bconsole\.(log|warn|error|debug|info)\b/g) > 0 &&
        !/test|spec|__tests__/.test('')) {
        smells.push({
            name: 'Console Logging',
            severity: 'low',
            description: 'console.* calls found in non-test code',
            recommendation: 'Replace with a proper logger (e.g. pino, winston) or remove before production',
            autoFixable: false,
        });
    }

    // Any type usage (TypeScript anti-pattern)
    if (count(src, /:\s*any\b/g) > 2) {
        smells.push({
            name: 'Excessive `any` Usage',
            severity: 'medium',
            description: `${count(src, /:\s*any\b/g)} uses of \`any\` type — bypasses type safety`,
            recommendation: 'Replace with specific types, generics, or unknown + type guards',
            autoFixable: false,
        });
    }

    // Non-null assertion abuse
    if (count(src, /[^!]!\s*[.[(]/g) > 3) {
        smells.push({
            name: 'Non-null Assertion Abuse',
            severity: 'medium',
            description: 'Multiple non-null assertion operators (!) found',
            recommendation: 'Use optional chaining (?.) or proper null checks instead',
            autoFixable: false,
        });
    }

    return smells;
}

// ─────────────────────────────────────────────────────────────────────────────
// File-level smells (cross-region patterns)
// ─────────────────────────────────────────────────────────────────────────────

export function detectFileSmells(
    regions: ASTRegion[],
    regionSmellMap: Map<string, RegionSmell[]>
): CodeSmell[] {
    const fileSmells: CodeSmell[] = [];

    // Duplicate logic fingerprinting — identical line sequences across regions
    const lineFingerprints = new Map<string, string[]>();

    for (const region of regions) {
        for (let i = 0; i < region.lines.length - 3; i++) {
            const chunk = region.lines
                .slice(i, i + 3)
                .map(l => l.trim())
                .filter(l => l.length > 10)
                .join('|');
            if (chunk.length < 30) continue;

            const existing = lineFingerprints.get(chunk) ?? [];
            existing.push(region.id);
            lineFingerprints.set(chunk, existing);
        }
    }

    const duplicates = [...lineFingerprints.entries()]
        .filter(([, ids]) => new Set(ids).size > 1)
        .map(([, ids]) => [...new Set(ids)]);

    if (duplicates.length > 0) {
        const affectedIds = [...new Set(duplicates.flat())];
        fileSmells.push({
            name: 'Duplicate Logic Detected',
            severity: 'high',
            description: `${duplicates.length} groups of repeated code blocks (≥3 lines) across regions`,
            affectedRegionIds: affectedIds,
            recommendation: 'Extract shared logic into a utility function in utils/',
            autoFixable: true,
        });
    }

    // Circular dependency smell (done post-graph, but check for co-located cycles)
    // Collect all smells into file-level CodeSmell format
    for (const region of regions) {
        const rs = regionSmellMap.get(region.id) ?? [];
        for (const s of rs) {
            fileSmells.push({
                name: s.name,
                severity: s.severity,
                description: s.description,
                affectedRegionIds: [region.id],
                recommendation: s.recommendation,
                autoFixable: s.autoFixable,
            });
        }
    }

    return fileSmells;
}
