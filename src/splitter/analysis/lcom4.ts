/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — LCOM4 Cohesion Metric                                           ║
 * ║                                                                              ║
 * ║  Implements the full Lack of Cohesion in Methods 4 (LCOM4) metric using     ║
 * ║  the actual call/field graph between methods, replacing the simple           ║
 * ║  usedSymbols/localBindings ratio approximation.                             ║
 * ║                                                                              ║
 * ║  LCOM4 Definition (Hitz & Montazeri 1995):                                  ║
 * ║    Two methods A and B are "connected" if they:                             ║
 * ║      a) Both access the same instance field/property, OR                   ║
 * ║      b) One calls the other (directly or via a chain)                      ║
 * ║    LCOM4 = number of connected components in the method-field graph.        ║
 * ║    LCOM4 = 1  → fully cohesive (ideal)                                     ║
 * ║    LCOM4 > 1  → should be split into LCOM4 separate classes                ║
 * ║                                                                              ║
 * ║  Input: a class or object-literal region's source + AST node               ║
 * ║  Output: LCOM4 score + connected component breakdown                        ║
 * ║                                                                              ║
 * ║  Also computes:                                                              ║
 * ║    ▸ TCC (Tight Class Cohesion) — ratio of directly connected method pairs  ║
 * ║    ▸ LCC (Loose Class Cohesion) — TCC extended with indirect connections    ║
 * ║    ▸ Suggested split groups — which methods belong together                 ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as ts from 'typescript';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MethodNode {
    name:          string;
    /** Fields/properties this method reads or writes */
    accessedFields: Set<string>;
    /** Methods this method directly calls (within same class) */
    calledMethods:  Set<string>;
    lineStart:     number;
    lineEnd:       number;
    isPrivate:     boolean;
    isStatic:      boolean;
}

export interface LCOM4Result {
    /** Number of connected components (1 = ideal, >1 = should split) */
    lcom4:               number;
    /** Total method count */
    methodCount:         number;
    /** Total field count */
    fieldCount:          number;
    /** Tight Class Cohesion ∈ [0,1] */
    tcc:                 number;
    /** Loose Class Cohesion ∈ [0,1] */
    lcc:                 number;
    /** Each connected component as an array of method names */
    connectedComponents: string[][];
    /** Whether this class should be split (lcom4 > 1) */
    shouldSplit:         boolean;
    /** Human-readable interpretation */
    interpretation:      string;
    /** If shouldSplit, suggested groupings */
    suggestedGroups:     Array<{ methods: string[]; reason: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST extraction — methods and their field accesses
// ─────────────────────────────────────────────────────────────────────────────

function lineOf(sf: ts.SourceFile, pos: number): number {
    return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function isThisAccess(node: ts.Node): node is ts.PropertyAccessExpression {
    return ts.isPropertyAccessExpression(node) &&
           ts.isThisTypeNode(node.expression as ts.Node) === false &&
           node.expression.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * Extract all `this.fieldName` accesses from within a method body.
 */
function extractFieldAccesses(body: ts.Node): Set<string> {
    const fields = new Set<string>();
    const walk   = (n: ts.Node) => {
        if (isThisAccess(n)) {
            fields.add((n as ts.PropertyAccessExpression).name.text);
        }
        ts.forEachChild(n, walk);
    };
    walk(body);
    return fields;
}

/**
 * Extract all `this.methodName(...)` calls from within a method body.
 */
function extractMethodCalls(body: ts.Node, allMethodNames: Set<string>): Set<string> {
    const calls = new Set<string>();
    const walk  = (n: ts.Node) => {
        if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
            const name = n.expression.name.text;
            if (allMethodNames.has(name)) calls.add(name);
        }
        ts.forEachChild(n, walk);
    };
    walk(body);
    return calls;
}

/**
 * Parse a class declaration or object-literal source into MethodNode[].
 */
function extractMethods(src: string, fileName = '__lcom__.ts'): {
    methods:    MethodNode[];
    fieldNames: Set<string>;
} {
    const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
    const methods:    MethodNode[]  = [];
    const fieldNames: Set<string>   = new Set();

    // Walk looking for class declarations (or the first class in the snippet)
    let classNode: ts.ClassDeclaration | ts.ClassExpression | undefined;

    ts.forEachChild(sf, n => {
        if (!classNode) {
            if (ts.isClassDeclaration(n)) classNode = n;
            else if (ts.isExpressionStatement(n) && ts.isClassExpression(n.expression)) {
                classNode = n.expression;
            }
        }
    });

    if (!classNode) {
        return { methods: [], fieldNames };
    }

    // Collect field names from property declarations
    for (const member of classNode.members) {
        if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
            fieldNames.add(member.name.text);
        }
    }

    // First pass: collect all method names
    const allMethodNames = new Set<string>();
    for (const member of classNode.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
            allMethodNames.add(member.name.text);
        } else if (ts.isConstructorDeclaration(member)) {
            allMethodNames.add('constructor');
        }
    }

    // Second pass: extract field accesses and method calls per method
    for (const member of classNode.members) {
        let name: string | undefined;
        let body: ts.Block | undefined;
        let isPrivate = false;
        let isStatic  = false;

        if (ts.isConstructorDeclaration(member)) {
            name = 'constructor';
            body = member.body;
        } else if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
            name     = member.name.text;
            body     = member.body;
            isPrivate = (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) !== 0 ||
                        name.startsWith('_') || name.startsWith('#');
            isStatic  = (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0;
        } else if (
            (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
            ts.isIdentifier(member.name)
        ) {
            name = member.name.text;
            body = member.body;
        }

        if (!name || !body) continue;

        const accessedFields = extractFieldAccesses(body);
        const calledMethods  = extractMethodCalls(body, allMethodNames);

        // Fields accessed via `this.x = y` in constructor count as field definitions
        if (ts.isConstructorDeclaration(member)) {
            for (const f of accessedFields) fieldNames.add(f);
        }

        methods.push({
            name, accessedFields, calledMethods,
            lineStart: lineOf(sf, member.getStart(sf, true)),
            lineEnd:   lineOf(sf, member.getEnd()),
            isPrivate, isStatic,
        });
    }

    return { methods, fieldNames };
}

// ─────────────────────────────────────────────────────────────────────────────
// Union-Find (Disjoint Set) for connected components
// ─────────────────────────────────────────────────────────────────────────────

class UnionFind {
    private parent: Map<string, string>;
    private rank:   Map<string, number>;

    constructor(nodes: string[]) {
        this.parent = new Map(nodes.map(n => [n, n]));
        this.rank   = new Map(nodes.map(n => [n, 0]));
    }

    find(x: string): string {
        if (this.parent.get(x) !== x) {
            this.parent.set(x, this.find(this.parent.get(x)!));
        }
        return this.parent.get(x)!;
    }

    union(x: string, y: string): void {
        const px = this.find(x);
        const py = this.find(y);
        if (px === py) return;
        const rx = this.rank.get(px) ?? 0;
        const ry = this.rank.get(py) ?? 0;
        if (rx < ry) this.parent.set(px, py);
        else if (rx > ry) this.parent.set(py, px);
        else { this.parent.set(py, px); this.rank.set(px, rx + 1); }
    }

    components(nodes: string[]): string[][] {
        const groups = new Map<string, string[]>();
        for (const n of nodes) {
            const root = this.find(n);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root)!.push(n);
        }
        return [...groups.values()];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TCC / LCC computation
// ─────────────────────────────────────────────────────────────────────────────

function totalPairs(n: number): number {
    return n < 2 ? 1 : (n * (n - 1)) / 2;
}

function computeTCC(methods: MethodNode[]): number {
    const n = methods.length;
    if (n < 2) return 1;
    let connected = 0;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const a = methods[i];
            const b = methods[j];
            // Directly connected: share a field OR one calls the other
            const shareField  = [...a.accessedFields].some(f => b.accessedFields.has(f));
            const aCallsB     = a.calledMethods.has(b.name);
            const bCallsA     = b.calledMethods.has(a.name);
            if (shareField || aCallsB || bCallsA) connected++;
        }
    }
    return connected / totalPairs(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: compute LCOM4 for a class source string
// ─────────────────────────────────────────────────────────────────────────────

export function computeLCOM4(src: string): LCOM4Result {
    const { methods, fieldNames } = extractMethods(src);

    if (methods.length === 0) {
        return {
            lcom4: 0, methodCount: 0, fieldCount: fieldNames.size,
            tcc: 1, lcc: 1, connectedComponents: [],
            shouldSplit: false,
            interpretation: 'No methods found — not a class or empty class',
            suggestedGroups: [],
        };
    }
    if (methods.length === 1) {
        return {
            lcom4: 1, methodCount: 1, fieldCount: fieldNames.size,
            tcc: 1, lcc: 1,
            connectedComponents: [[methods[0].name]],
            shouldSplit: false,
            interpretation: 'Single method — fully cohesive',
            suggestedGroups: [],
        };
    }

    // Build method–method connection graph via Union-Find
    const uf = new UnionFind(methods.map(m => m.name));

    for (let i = 0; i < methods.length; i++) {
        for (let j = i + 1; j < methods.length; j++) {
            const a = methods[i];
            const b = methods[j];

            const shareField = [...a.accessedFields].some(f => b.accessedFields.has(f));
            const aCallsB    = a.calledMethods.has(b.name);
            const bCallsA    = b.calledMethods.has(a.name);

            if (shareField || aCallsB || bCallsA) {
                uf.union(a.name, b.name);
            }
        }
    }

    const components  = uf.components(methods.map(m => m.name));
    const lcom4       = components.length;
    const tcc         = computeTCC(methods);
    const methodCount = methods.length;

    // LCC: same as TCC but includes indirect connections (already handled by Union-Find)
    // Pair is LCC-connected if it's in the same component
    let lccConnected = 0;
    for (let i = 0; i < methods.length; i++) {
        for (let j = i + 1; j < methods.length; j++) {
            if (uf.find(methods[i].name) === uf.find(methods[j].name)) lccConnected++;
        }
    }
    const lcc = lccConnected / totalPairs(methodCount);

    // Interpretation
    const shouldSplit = lcom4 > 1;
    let interpretation: string;
    if (lcom4 === 1)       interpretation = 'Fully cohesive — all methods share state or call each other';
    else if (lcom4 === 2)  interpretation = `Low cohesion (LCOM4=2) — class has 2 independent responsibility groups`;
    else if (lcom4 <= 4)   interpretation = `Poor cohesion (LCOM4=${lcom4}) — class has ${lcom4} independent groups; consider splitting`;
    else                   interpretation = `Very poor cohesion (LCOM4=${lcom4}) — class is doing too many unrelated things`;

    // Suggested groups (one per component with > 1 method)
    const suggestedGroups = components
        .filter(c => c.length > 0)
        .map(c => {
            const groupMethods   = methods.filter(m => c.includes(m.name));
            const allFields      = new Set(groupMethods.flatMap(m => [...m.accessedFields]));
            const fieldList      = [...allFields].slice(0, 4).join(', ');
            return {
                methods: c,
                reason: fieldList
                    ? `Shared state: ${fieldList}`
                    : 'Methods call each other but share no fields',
            };
        });

    return {
        lcom4, methodCount, fieldCount: fieldNames.size,
        tcc:  Math.round(tcc  * 1000) / 1000,
        lcc:  Math.round(lcc  * 1000) / 1000,
        connectedComponents: components,
        shouldSplit, interpretation, suggestedGroups,
    };
}
