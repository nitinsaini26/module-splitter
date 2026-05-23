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
  SymbolUsageKind,
  CoChangeRecord,
  IndirectCycle,
} from "../types";

const EDGE_TYPE_WEIGHT: Record<SymbolUsageKind, number> = {
  call: 1.5,
  type: 0.1,
  reexport: 0,
  inheritance: 2.0,
  reference: 1.0,
  cochange: 1.2,
};

const EDGE_TYPE_PRECEDENCE: SymbolUsageKind[] = [
  "inheritance",
  "call",
  "reference",
  "type",
  "reexport",
  "cochange",
];

function chooseEdgeType(symbolKinds: SymbolUsageKind[]): SymbolUsageKind {
  for (const kind of EDGE_TYPE_PRECEDENCE) {
    if (symbolKinds.includes(kind)) return kind;
  }
  return "reference";
}

function externalDependencyWeight(symbolKinds: SymbolUsageKind[]): number {
  const edgeType = chooseEdgeType(symbolKinds);
  return 0.2 * EDGE_TYPE_WEIGHT[edgeType];
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge builder
// ─────────────────────────────────────────────────────────────────────────────

function computeEdgeStrength(
  symbols: string[],
  symbolKinds: SymbolUsageKind[],
  fromKind: string,
  toKind: string,
): number {
  const kindMultiplier =
    toKind === "hook"
      ? 1.4
      : toKind === "context-provider"
        ? 1.3
        : toKind === "utility-function"
          ? 0.9
          : toKind === "type-block"
            ? 0.3 // type-only → low runtime coupling
            : 1.0;
  const weighted = symbolKinds.reduce(
    (total, kind) => total + 0.2 * kindMultiplier * EDGE_TYPE_WEIGHT[kind],
    0,
  );
  const raw = Math.min(
    1,
    weighted > 0 ? weighted : symbols.length * 0.2 * kindMultiplier,
  );
  return Math.round(raw * 100) / 100;
}

function isTypeOnlySymbols(
  symbols: string[],
  table: SymbolTable,
  symbolKinds: SymbolUsageKind[],
): boolean {
  if (symbolKinds.length > 0) {
    return symbolKinds.every((kind) => kind === "type");
  }
  return symbols.every((s) => {
    const entry = table.locals.get(s);
    return entry?.namespace === "type";
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Indirect cycle detection (multi-hop reachability)
// ─────────────────────────────────────────────────────────────────────────────

function shortestPath(
  adjacency: Map<string, Set<string>>,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from];
  const queue: string[] = [from];
  const prev = new Map<string, string | null>([[from, null]]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const nb of adjacency.get(current) ?? new Set()) {
      if (prev.has(nb)) continue;
      prev.set(nb, current);
      if (nb === to) {
        const path: string[] = [to];
        let cur: string | null = current;
        while (cur) {
          path.unshift(cur);
          cur = prev.get(cur) ?? null;
        }
        return path;
      }
      queue.push(nb);
    }
  }

  return null;
}

function detectIndirectCycles(
  regionIds: string[],
  adjacency: Map<string, Set<string>>,
): IndirectCycle[] {
  const cycles: IndirectCycle[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < regionIds.length; i++) {
    for (let j = i + 1; j < regionIds.length; j++) {
      const a = regionIds[i];
      const b = regionIds[j];
      const pathAB = shortestPath(adjacency, a, b);
      if (!pathAB || pathAB.length < 2) continue;
      const pathBA = shortestPath(adjacency, b, a);
      if (!pathBA || pathBA.length < 2) continue;

      const isIndirect = pathAB.length > 2 || pathBA.length > 2;
      if (!isIndirect) continue;

      const key = `${a}::${b}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cyclePath = [...pathAB, ...pathBA.slice(1)];
      cycles.push({ from: a, to: b, path: cyclePath });
    }
  }

  return cycles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kahn's topological sort
// ─────────────────────────────────────────────────────────────────────────────

function kahnSort(
  regionIds: string[],
  adjacency: Map<string, Set<string>>,
): string[] {
  const inDegree = new Map<string, number>();
  for (const id of regionIds) inDegree.set(id, 0);

  for (const [, neighbours] of adjacency) {
    for (const nb of neighbours) {
      inDegree.set(nb, (inDegree.get(nb) ?? 0) + 1);
    }
  }

  const queue = regionIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const sorted: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const nb of adjacency.get(node) ?? new Set()) {
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
  adjacency: Map<string, Set<string>>,
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongConnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.set(v, true);

    for (const w of adjacency.get(v) ?? new Set()) {
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
  edges: DependencyEdge[],
): {
  total: Map<string, number>;
  outbound: Map<string, number>;
  inbound: Map<string, number>;
} {
  const outbound = new Map<string, number>(regionIds.map((id) => [id, 0]));
  const inbound = new Map<string, number>(regionIds.map((id) => [id, 0]));

  for (const edge of edges) {
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + edge.strength);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + edge.strength);
  }

  const total = new Map<string, number>(regionIds.map((id) => [id, 0]));
  for (const id of regionIds) {
    const out = outbound.get(id) ?? 0;
    const inb = inbound.get(id) ?? 0;
    total.set(id, out + inb * 0.5);
  }

  return { total, outbound, inbound };
}

function computeCohesionScores(
  regions: ASTRegion[],
  edges: DependencyEdge[],
): Map<string, number> {
  // Simplified LCOM4 variant: cohesion = 1 - (distinct unconnected components / total)
  // For a single region, cohesion is purely internal symbol reuse density.
  const scores = new Map<string, number>();
  for (const r of regions) {
    const used = r.usedSymbols.size;
    const declared = r.localBindings.size;
    const reuse = declared > 0 ? Math.min(1, used / (declared + 1)) : 0.5;
    scores.set(r.id, Math.round(reuse * 100) / 100);
  }
  return scores;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public builder
// ─────────────────────────────────────────────────────────────────────────────

export function buildDependencyGraph(
  regions: ASTRegion[],
  symbolTable: SymbolTable,
  coChangeRecords: CoChangeRecord[] = [],
): DependencyGraph {
  const regionIds = regions.map((r) => r.id);
  const regionById = new Map(regions.map((r) => [r.id, r]));
  const nameToId = new Map(regions.map((r) => [r.name, r.id]));

  const edges: DependencyEdge[] = [];
  const adjacency = new Map<string, Set<string>>(
    regionIds.map((id) => [id, new Set()]),
  );
  const reverseAdjacency = new Map<string, Set<string>>(
    regionIds.map((id) => [id, new Set()]),
  );

  for (const region of regions) {
    // For each symbol used by this region, check if it's declared in another region
    const usedByThis: Map<
      string,
      { symbols: string[]; symbolKinds: SymbolUsageKind[] }
    > = new Map(); // targetId → symbols

    for (const sym of region.usedSymbols) {
      // Skip locally bound names
      if (region.localBindings.has(sym)) continue;

      const declId = nameToId.get(sym);
      if (!declId || declId === region.id) continue;

      // Skip if it's in an external import (handled separately)
      const entry = symbolTable.locals.get(sym);
      if (!entry) continue;

      const usageKinds = region.symbolUsageKinds?.get(sym) ?? ["reference"];
      const bucket = usedByThis.get(declId) ?? {
        symbols: [],
        symbolKinds: [],
      };
      bucket.symbols.push(sym);
      bucket.symbolKinds.push(...usageKinds);
      usedByThis.set(declId, bucket);
    }

    for (const [targetId, bucket] of usedByThis) {
      const fromRegion = regionById.get(region.id)!;
      const toRegion = regionById.get(targetId)!;
      const strength = computeEdgeStrength(
        bucket.symbols,
        bucket.symbolKinds,
        fromRegion.kind,
        toRegion.kind,
      );
      const edgeType = chooseEdgeType(bucket.symbolKinds);
      const typeOnly = isTypeOnlySymbols(
        bucket.symbols,
        symbolTable,
        bucket.symbolKinds,
      );

      edges.push({
        from: region.id,
        to: targetId,
        symbols: bucket.symbols,
        edgeType,
        strength,
        isTypeOnly: typeOnly,
        isCyclic: false,
      });

      adjacency.get(region.id)!.add(targetId);
      reverseAdjacency.get(targetId)!.add(region.id);
    }
  }

  const externalCoupling = new Map<string, number>(
    regionIds.map((id) => [id, 0]),
  );

  for (const region of regions) {
    const usageKinds = region.symbolUsageKinds ?? new Map();
    const seen = new Set<string>();
    for (const rec of symbolTable.imports.values()) {
      const aliases: string[] = [];
      if (rec.defaultAlias) aliases.push(rec.defaultAlias);
      if (rec.namespaceAlias) aliases.push(rec.namespaceAlias);
      for (const named of rec.named) aliases.push(named.alias);

      for (const alias of aliases) {
        if (!region.usedSymbols.has(alias)) continue;
        if (region.localBindings.has(alias)) continue;
        if (symbolTable.locals.has(alias)) continue;
        const key = `${rec.specifier}:${alias}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const kinds = usageKinds.get(alias) ?? ["reference"];
        const weight = externalDependencyWeight(kinds);
        if (weight > 0) {
          externalCoupling.set(
            region.id,
            (externalCoupling.get(region.id) ?? 0) + weight,
          );
        }
      }
    }
  }

  // Add co-change coupling edges (symmetrical)
  if (coChangeRecords.length > 0) {
    const edgeLookup = new Map<string, DependencyEdge>();
    for (const edge of edges) {
      edgeLookup.set(`${edge.from}::${edge.to}`, edge);
    }

    for (const record of coChangeRecords) {
      if (!regionById.has(record.regionA) || !regionById.has(record.regionB)) {
        continue;
      }
      const strength = Math.max(0, Math.min(1, record.coupling));
      const pairs: Array<[string, string]> = [
        [record.regionA, record.regionB],
        [record.regionB, record.regionA],
      ];

      for (const [from, to] of pairs) {
        const key = `${from}::${to}`;
        const existing = edgeLookup.get(key);
        if (existing) {
          existing.coChangeCoupling = strength;
          existing.strength = Math.min(1, existing.strength + strength * 0.5);
          continue;
        }

        const edge: DependencyEdge = {
          from,
          to,
          symbols: ["__cochange__"],
          edgeType: "cochange",
          strength,
          isTypeOnly: false,
          isCyclic: false,
          coChangeCoupling: strength,
        };
        edges.push(edge);
        edgeLookup.set(key, edge);
        adjacency.get(from)!.add(to);
        reverseAdjacency.get(to)!.add(from);
      }
    }
  }

  // Run Tarjan to find SCCs
  const sccs = tarjanSCC(regionIds, adjacency);

  // Mark cyclic edges
  const cyclicIds = new Set<string>(sccs.filter((s) => s.length > 1).flat());
  for (const edge of edges) {
    if (cyclicIds.has(edge.from) && cyclicIds.has(edge.to)) {
      edge.isCyclic = true;
    }
  }

  const indirectCycles = detectIndirectCycles(regionIds, adjacency);
  if (indirectCycles.length > 0) {
    for (const cycle of indirectCycles) {
      for (let i = 0; i < cycle.path.length - 1; i++) {
        const from = cycle.path[i];
        const to = cycle.path[i + 1];
        const edge = edges.find((e) => e.from === from && e.to === to);
        if (edge && !edge.isCyclic) {
          edge.isIndirectCycle = true;
          edge.indirectCyclePath = cycle.path;
        }
      }
    }
  }

  // Topological sort
  const topologicalOrder = kahnSort(regionIds, adjacency);

  // Coupling & cohesion
  const coupling = computeCouplingScores(regionIds, edges);
  for (const [id, weight] of externalCoupling) {
    if (weight <= 0) continue;
    coupling.outbound.set(id, (coupling.outbound.get(id) ?? 0) + weight);
    coupling.total.set(id, (coupling.total.get(id) ?? 0) + weight);
  }
  const cohesionScores = computeCohesionScores(regions, edges);

  return {
    edges,
    topologicalOrder,
    sccs,
    indirectCycles,
    adjacency,
    reverseAdjacency,
    couplingScores: coupling.total,
    outboundCouplingScores: coupling.outbound,
    inboundCouplingScores: coupling.inbound,
    cohesionScores,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Critical path finder (longest dependency chain)
// ─────────────────────────────────────────────────────────────────────────────

export function findCriticalPath(
  topologicalOrder: string[],
  adjacency: Map<string, Set<string>>,
): string[] {
  const dist = new Map<string, number>(topologicalOrder.map((id) => [id, 0]));
  const prev = new Map<string, string | null>(
    topologicalOrder.map((id) => [id, null]),
  );

  for (const u of topologicalOrder) {
    for (const v of adjacency.get(u) ?? new Set()) {
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
    if (d > maxDist) {
      maxDist = d;
      maxNode = id;
    }
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
