/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Dependency Graph Builder                                        ║
 * ║                                                                              ║
 * ║  Builds a precise directed dependency graph between all detected regions    ║
 * ║  in the source file.                                                         ║
 * ║                                                                              ║
 * ║  Algorithms:                                                                  ║
 * ║    ▸ Kahn's Algorithm  — O(V+E) topological sort                            ║
 * ║    ▸ Tarjan's SCC      — O(V+E) cycle detection & strongly-connected sets   ║
 * ║    ▸ Edge weighting    — usage count × kind multiplier for coupling score   ║
 * ║    ▸ Cohesion scoring  — LCOM4-inspired measure per region                  ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type {
    ASTRegion,
    SymbolTable,
    DependencyGraph,
    DependencyEdge,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Edge builder
// ─────────────────────────────────────────────────────────────────────────────

function computeEdgeStrength(
    symbols: string[],
    fromKind: string,
    toKind: string
): number {
    const kindMultiplier =
        toKind === 'hook'              ? 1.4 :
        toKind === 'context-provider'  ? 1.3 :
        toKind === 'utility-function'  ? 0.9 :
        toKind === 'type-block'        ? 0.3 :  // type-only → low runtime coupling
        1.0;
    const raw = Math.min(1, (symbols.length * 0.2) * kindMultiplier);
    return Math.round(raw * 100) / 100;
}

function isTypeOnlySymbols(symbols: string[], table: SymbolTable): boolean {
    return symbols.every(s => {
        const entry = table.locals.get(s);
        return entry?.namespace === 'type';
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Kahn's topological sort
// ─────────────────────────────────────────────────────────────────────────────

function kahnSort(
    regionIds: string[],
    adjacency: Map<string, Set<string>>
): string[] {
    const inDegree = new Map<string, number>();
    for (const id of regionIds) inDegree.set(id, 0);

    for (const [, neighbours] of adjacency) {
        for (const nb of neighbours) {
            inDegree.set(nb, (inDegree.get(nb) ?? 0) + 1);
        }
    }

    const queue = regionIds.filter(id => (inDegree.get(id) ?? 0) === 0);
    const sorted: string[] = [];

    while (queue.length > 0) {
        const node = queue.shift()!;
        sorted.push(node);
        for (const nb of (adjacency.get(node) ?? new Set())) {
            const deg = (inDegree.get(nb) ?? 0) - 1;
            inDegree.set(nb, deg);
            if (deg === 0) queue.push(nb);
        }
    }

    // If sorted.length < regionIds.length → cycle exists (handled via SCC)
    // Append remaining nodes (in original order) for completeness
    const sortedSet = new Set(sorted);
    for (const id of regionIds) {
        if (!sortedSet.has(id)) sorted.push(id);
    }

    return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarjan's SCC
// ─────────────────────────────────────────────────────────────────────────────

function tarjanSCC(
    regionIds: string[],
    adjacency: Map<string, Set<string>>
): string[][] {
    const index    = new Map<string, number>();
    const lowlink  = new Map<string, number>();
    const onStack  = new Map<string, boolean>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let counter = 0;

    const strongConnect = (v: string): void => {
        index.set(v, counter);
        lowlink.set(v, counter);
        counter++;
        stack.push(v);
        onStack.set(v, true);

        for (const w of (adjacency.get(v) ?? new Set())) {
            if (!index.has(w)) {
                strongConnect(w);
                lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
            } else if (onStack.get(w)) {
                lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
            }
        }

        if (lowlink.get(v) === index.get(v)) {
            const scc: string[] = [];
            let w: string;
            do {
                w = stack.pop()!;
                onStack.set(w, false);
                scc.push(w);
            } while (w !== v);
            sccs.push(scc);
        }
    };

    for (const id of regionIds) {
        if (!index.has(id)) strongConnect(id);
    }

    return sccs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coupling & cohesion
// ─────────────────────────────────────────────────────────────────────────────

function computeCouplingScores(
    regionIds: string[],
    edges: DependencyEdge[]
): Map<string, number> {
    const scores = new Map<string, number>(regionIds.map(id => [id, 0]));
    for (const edge of edges) {
        scores.set(edge.from, (scores.get(edge.from) ?? 0) + edge.strength);
        scores.set(edge.to,   (scores.get(edge.to)   ?? 0) + edge.strength * 0.5);
    }
    return scores;
}

function computeCohesionScores(
    regions: ASTRegion[],
    edges: DependencyEdge[]
): Map<string, number> {
    // Simplified LCOM4 variant: cohesion = 1 - (distinct unconnected components / total)
    // For a single region, cohesion is purely internal symbol reuse density.
    const scores = new Map<string, number>();
    for (const r of regions) {
        const used     = r.usedSymbols.size;
        const declared = r.localBindings.size;
        const reuse    = declared > 0 ? Math.min(1, used / (declared + 1)) : 0.5;
        scores.set(r.id, Math.round(reuse * 100) / 100);
    }
    return scores;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public builder
// ─────────────────────────────────────────────────────────────────────────────

export function buildDependencyGraph(
    regions: ASTRegion[],
    symbolTable: SymbolTable
): DependencyGraph {
    const regionIds   = regions.map(r => r.id);
    const regionById  = new Map(regions.map(r => [r.id, r]));
    const nameToId    = new Map(regions.map(r => [r.name, r.id]));

    const edges: DependencyEdge[] = [];
    const adjacency        = new Map<string, Set<string>>(regionIds.map(id => [id, new Set()]));
    const reverseAdjacency = new Map<string, Set<string>>(regionIds.map(id => [id, new Set()]));

    for (const region of regions) {
        // For each symbol used by this region, check if it's declared in another region
        const usedByThis: Map<string, string[]> = new Map(); // targetId → symbols

        for (const sym of region.usedSymbols) {
            // Skip locally bound names
            if (region.localBindings.has(sym)) continue;

            const declId = nameToId.get(sym);
            if (!declId || declId === region.id) continue;

            // Skip if it's in an external import (handled separately)
            const entry = symbolTable.locals.get(sym);
            if (!entry) continue;

            const bucket = usedByThis.get(declId) ?? [];
            bucket.push(sym);
            usedByThis.set(declId, bucket);
        }

        for (const [targetId, symbols] of usedByThis) {
            const fromRegion = regionById.get(region.id)!;
            const toRegion   = regionById.get(targetId)!;
            const strength   = computeEdgeStrength(symbols, fromRegion.kind, toRegion.kind);
            const typeOnly   = isTypeOnlySymbols(symbols, symbolTable);

            edges.push({
                from: region.id,
                to: targetId,
                symbols,
                strength,
                isTypeOnly: typeOnly,
                isCyclic: false,
            });

            adjacency.get(region.id)!.add(targetId);
            reverseAdjacency.get(targetId)!.add(region.id);
        }
    }

    // Run Tarjan to find SCCs
    const sccs = tarjanSCC(regionIds, adjacency);

    // Mark cyclic edges
    const cyclicIds = new Set<string>(
        sccs.filter(s => s.length > 1).flat()
    );
    for (const edge of edges) {
        if (cyclicIds.has(edge.from) && cyclicIds.has(edge.to)) {
            edge.isCyclic = true;
        }
    }

    // Topological sort
    const topologicalOrder = kahnSort(regionIds, adjacency);

    // Coupling & cohesion
    const couplingScores = computeCouplingScores(regionIds, edges);
    const cohesionScores = computeCohesionScores(regions, edges);

    return {
        edges,
        topologicalOrder,
        sccs,
        adjacency,
        reverseAdjacency,
        couplingScores,
        cohesionScores,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Critical path finder (longest dependency chain)
// ─────────────────────────────────────────────────────────────────────────────

export function findCriticalPath(
    topologicalOrder: string[],
    adjacency: Map<string, Set<string>>
): string[] {
    const dist = new Map<string, number>(topologicalOrder.map(id => [id, 0]));
    const prev = new Map<string, string | null>(topologicalOrder.map(id => [id, null]));

    for (const u of topologicalOrder) {
        for (const v of (adjacency.get(u) ?? new Set())) {
            const nd = (dist.get(u) ?? 0) + 1;
            if (nd > (dist.get(v) ?? 0)) {
                dist.set(v, nd);
                prev.set(v, u);
            }
        }
    }

    // Find the node with maximum distance
    let maxNode = topologicalOrder[0];
    let maxDist = 0;
    for (const [id, d] of dist) {
        if (d > maxDist) { maxDist = d; maxNode = id; }
    }

    // Backtrack to find the path
    const path: string[] = [];
    let cur: string | null | undefined = maxNode;
    while (cur != null) {
        path.unshift(cur);
        cur = prev.get(cur) ?? null;
    }

    return path;
}
