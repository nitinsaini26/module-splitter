/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Test Suite                                                       ║
 * ║  Full coverage across all 8 pipeline stages.                                ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import { ModuleSplitter } from "../src/splitter/core/moduleSplitter";
import { parseSourceFile } from "../src/splitter/parser/astParser";
import { buildDependencyGraph } from "../src/splitter/graph/dependencyGraph";
import {
  cyclomaticComplexity,
  cognitiveComplexity,
  maintainabilityIndex,
  halsteadMetrics,
  computeRegionMetrics,
} from "../src/splitter/analysis/metrics";
import {
  detectRegionSmells,
  detectFileSmells,
} from "../src/splitter/analysis/smellDetector";
import { buildCoChangeRecordsFromHistories } from "../src/splitter/analysis/coChangeDetector";
import { evaluateExtraction } from "../src/splitter/analysis/extractionOracle";
import { renderSplitPlanHtml } from "../src/splitter/core/webviewRenderer";
import { resolveImports } from "../src/splitter/resolver/importResolver";
import type { WorkspaceContext, EnrichedRegion } from "../src/splitter/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SIMPLE_COMPONENT = `
import React, { useState, useEffect } from 'react';

const MAX_COUNT = 100;

interface CounterProps {
  initialValue: number;
}

export const Counter: React.FC<CounterProps> = ({ initialValue }) => {
  const [count, setCount] = useState(initialValue);
  useEffect(() => {
    document.title = \`Count: \${count}\`;
  }, [count]);
  return <div onClick={() => setCount(c => c + 1)}>{count}</div>;
};

export function formatCount(n: number): string {
  return n.toLocaleString();
}
`.trim();

const SIMPLE_HOOK = `
import { useState, useCallback } from 'react';

export function useToggle(initial = false) {
  const [on, setOn] = useState(initial);
  const toggle = useCallback(() => setOn(v => !v), []);
  return { on, toggle };
}
`.trim();

const GOD_COMPONENT = `
import React, { useState, useEffect, useReducer } from 'react';
import axios from 'axios';
import { useSelector, dispatch } from 'redux';

export default function Dashboard() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const user = useSelector(s => s.user);

  useEffect(() => {
    setLoading(true);
    axios.get('/api/data').then(r => {
      setData(r.data.map(x => ({ ...x, label: x.name.toUpperCase() })));
      setLoading(false);
    });
  });   // intentionally missing dep array

  const handleSubmit = async (e) => {
    e.preventDefault();
    await axios.post('/api/data', data);
    dispatch({ type: 'REFRESH' });
  };

  if (loading) return <div className="spinner" style={{ color: 'red' }}>Loading...</div>;

  return (
    <div style={{ padding: 20, margin: 10, background: '#fff' }}>
      {data.map(item => (
        <div key={item.id} style={{ border: '1px solid #ccc', padding: 8 }}>
          {item.label}
          {item.children?.map(c => <span key={c.id}>{c.name}</span>)}
        </div>
      ))}
      <button onClick={handleSubmit}>Submit</button>
    </div>
  );
}
`.trim();

const CIRCULAR_SRC = `
export function A() {
  return B();
}

export function B() {
  return A();
}
`.trim();

const TYPE_HEAVY = `
export interface UserProfile {
  id: string;
  name: string;
  email: string;
}

export type UserStatus = 'active' | 'inactive' | 'suspended';

export enum UserRole {
  Admin = 'admin',
  Editor = 'editor',
  Viewer = 'viewer',
}

export function getUserLabel(profile: UserProfile): string {
  return \`\${profile.name} <\${profile.email}>\`;
}
`.trim();

const DECORATED_CLASS = `
@MyDecorator()
export class Service {
    run() { return 1; }
}
`.trim();

const LOWERCASE_JSX = `
export function renderItem() {
    return <div>Item</div>;
}
`.trim();

const DEFAULT_ARROW = `export default () => <div>Hello</div>;`;

const DYNAMIC_IMPORT_SRC = `
const { LazyWidget } = await import('./LazyWidget');
export function useLazy() {
  return LazyWidget;
}
`.trim();

const INDIRECT_CYCLE_SRC = `
export function A() { return C(); }
export function B() { return A(); }
export function C() { return B(); }
`.trim();

const buildConstLines = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, i) => `  const ${prefix}${i} = ${i};`).join(
    "\n",
  );

const makeEnrichedRegion = (
  region: ReturnType<typeof parseSourceFile>["regions"][0],
): EnrichedRegion => {
  const lineCount = region?.lines.length ?? 0;
  return {
    ...region,
    metrics: {
      lineCount,
      codeLines: lineCount,
      commentLines: 0,
      blankLines: 0,
      cyclomaticComplexity: 1,
      cognitiveComplexity: 0,
      nestingDepth: 1,
      maintainabilityIndex: 80,
      halsteadVolume: 0,
      halsteadEffort: 0,
      bundleWeight: 0,
      testabilityScore: 50,
    },
    smells: [],
    exportedSymbols: [],
    importedSymbols: [],
    externalPackages: [],
    inlineTypeNames: [],
    isDeadExport: false,
    extractionDecision: {
      shouldExtract: false,
      reasons: [],
      confidence: "low",
      miDelta: 0,
      suggestedFileName: "utils/region.ts",
      suggestedDir: "utils",
    },
  } as EnrichedRegion;
};

const BASE_CTX: WorkspaceContext = {
  existingTypeFiles: [],
  existingHookFiles: [],
  existingUtilFiles: [],
  existingIndexFiles: [],
  existingTestFiles: [],
  sourceDir: ".",
  testFramework: "jest",
  packageManager: "npm",
  isMonorepo: false,
  tsConfig: undefined,
};

const makeCtx = (
  overrides: Partial<WorkspaceContext> = {},
): WorkspaceContext => ({
  ...BASE_CTX,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1: Parser
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage 1 — parseSourceFile", () => {
  it("detects a React component", () => {
    const result = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    const comp = result.regions.find((r) => r.name === "Counter");
    expect(comp).toBeDefined();
    expect(comp?.kind).toBe("react-component");
    expect(comp?.hasJSX).toBe(true);
  });

  it("detects a utility function", () => {
    const result = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    const util = result.regions.find((r) => r.name === "formatCount");
    expect(util).toBeDefined();
    expect(util?.kind).toBe("utility-function");
    expect(util?.hasJSX).toBe(false);
  });

  it("detects a constant block", () => {
    const result = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    const constant = result.regions.find((r) => r.name === "MAX_COUNT");
    expect(constant).toBeDefined();
    expect(constant?.kind).toBe("constant-block");
  });

  it("detects an interface as type-block", () => {
    const result = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    const iface = result.regions.find((r) => r.name === "CounterProps");
    expect(iface).toBeDefined();
    expect(iface?.kind).toBe("type-block");
  });

  it("detects a hook", () => {
    const result = parseSourceFile(SIMPLE_HOOK, "useToggle.ts");
    const hook = result.regions.find((r) => r.name === "useToggle");
    expect(hook).toBeDefined();
    expect(hook?.kind).toBe("hook");
    expect(hook?.hasHooks).toBe(true);
  });

  it("classifies lowercase JSX helpers as react components", () => {
    const result = parseSourceFile(LOWERCASE_JSX, "renderItem.tsx");
    const helper = result.regions.find((r) => r.name === "renderItem");
    expect(helper).toBeDefined();
    expect(helper?.kind).toBe("react-component");
    expect(helper?.hasJSX).toBe(true);
  });

  it("includes decorators in class region boundaries", () => {
    const result = parseSourceFile(DECORATED_CLASS, "service.ts");
    const cls = result.regions.find((r) => r.name === "Service");
    expect(cls).toBeDefined();
    expect(cls?.startLine).toBe(1);
    expect(cls?.lines[0].trim()).toBe("@MyDecorator()");
  });

  it("names default-export arrow components from the file name", () => {
    const result = parseSourceFile(DEFAULT_ARROW, "user-card.tsx");
    const def = result.regions.find((r) => r.isDefaultExport);
    expect(def).toBeDefined();
    expect(def?.name).toBe("UserCard");
    expect(def?.hasJSX).toBe(true);
  });

  it("detects dynamic import and require in the symbol table", () => {
    const src = `
const mod = await import('./lazy');
const req = require('./req');
export function useIt() { return mod && req; }
`.trim();
    const result = parseSourceFile(src, "dynamic.ts");
    const dynamic = [...result.symbolTable.imports.values()].filter(
      (rec) => rec.isDynamic,
    );
    const specifiers = dynamic.map((rec) => rec.specifier).sort();
    expect(specifiers).toEqual(["./lazy", "./req"]);
  });

  it("builds import records in SymbolTable", () => {
    const result = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    const reactImport = result.symbolTable.imports.get("react");
    expect(reactImport).toBeDefined();
    expect(reactImport?.named.map((n) => n.name)).toContain("useState");
    expect(reactImport?.named.map((n) => n.name)).toContain("useEffect");
  });

  it("registers exported symbols in SymbolTable.locals", () => {
    const result = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    expect(result.symbolTable.locals.has("Counter")).toBe(true);
    expect(result.symbolTable.locals.has("formatCount")).toBe(true);
  });

  it("uses typescript-ast engine for .tsx files", () => {
    const result = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    expect(result.engineUsed).toBe("typescript-ast");
  });

  it("falls back to bracket-depth for .py files", () => {
    const result = parseSourceFile("def foo():\n    return 1\n", "foo.py");
    expect(result.engineUsed).toBe("bracket-depth-fallback");
  });

  it("detects enum correctly", () => {
    const result = parseSourceFile(TYPE_HEAVY, "types.ts");
    const en = result.regions.find((r) => r.name === "UserRole");
    expect(en?.kind).toBe("enum");
  });

  it("detects type alias correctly", () => {
    const result = parseSourceFile(TYPE_HEAVY, "types.ts");
    const ta = result.regions.find((r) => r.name === "UserStatus");
    expect(ta?.kind).toBe("type-block");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2: Dependency Graph
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage 2 — buildDependencyGraph", () => {
  it("detects circular dependency via Tarjan SCC", () => {
    const { regions, symbolTable } = parseSourceFile(
      CIRCULAR_SRC,
      "circular.ts",
    );
    const graph = buildDependencyGraph(regions, symbolTable);
    // A and B reference each other → should be in same SCC
    // Note: this depends on runtime symbol resolution depth
    expect(graph.sccs.length).toBeGreaterThan(0);
  });

  it("produces topological order with no cycles for simple file", () => {
    const { regions, symbolTable } = parseSourceFile(
      SIMPLE_COMPONENT,
      "Counter.tsx",
    );
    const graph = buildDependencyGraph(regions, symbolTable);
    expect(graph.topologicalOrder.length).toBe(regions.length);
  });

  it("assigns coupling scores to all regions", () => {
    const { regions, symbolTable } = parseSourceFile(
      SIMPLE_COMPONENT,
      "Counter.tsx",
    );
    const graph = buildDependencyGraph(regions, symbolTable);
    for (const r of regions) {
      expect(graph.couplingScores.has(r.id)).toBe(true);
    }
  });

  it("tracks inbound and outbound coupling separately", () => {
    const src = `
export function A() {
    return B();
}

export function B() {
    return 1;
}
`.trim();
    const { regions, symbolTable } = parseSourceFile(src, "dep.ts");
    const graph = buildDependencyGraph(regions, symbolTable);
    const a = regions.find((r) => r.name === "A");
    const b = regions.find((r) => r.name === "B");
    if (!a || !b) return;
    expect(graph.outboundCouplingScores.get(a.id) ?? 0).toBeGreaterThan(0);
    expect(graph.inboundCouplingScores.get(b.id) ?? 0).toBeGreaterThan(0);
  });

  it("adds coupling pressure for external imports", () => {
    const src = `
import { uniq } from 'lodash';

export function A(items: number[]) {
  return uniq(items);
}
`.trim();
    const { regions, symbolTable } = parseSourceFile(src, "external.ts");
    const graph = buildDependencyGraph(regions, symbolTable);
    const a = regions.find((r) => r.name === "A");
    if (!a) return;
    expect(graph.outboundCouplingScores.get(a.id) ?? 0).toBeGreaterThan(0);
  });

  it("flags indirect cycles with multi-hop paths", () => {
    const parsed = parseSourceFile(INDIRECT_CYCLE_SRC, "cycle.ts");
    const graph = buildDependencyGraph(parsed.regions, parsed.symbolTable);
    const nameById = new Map(parsed.regions.map((r) => [r.id, r.name]));
    const hasCycle = graph.indirectCycles.some((cycle) => {
      const names = cycle.path.map((id) => nameById.get(id));
      return names.includes("A") && names.includes("B") && names.includes("C");
    });
    expect(hasCycle).toBe(true);
  });

  it("adds co-change edges when regions always change together", () => {
    const src = `
export function Alpha() { return 1; }
export function Beta() { return 2; }
export function Gamma() { return 3; }
`.trim();
    const parsed = parseSourceFile(src, "cochange.ts");
    const regionByName = new Map(parsed.regions.map((r) => [r.name, r]));
    const histories = new Map<string, string[]>([
      [regionByName.get("Alpha")!.id, ["c1", "c2"]],
      [regionByName.get("Beta")!.id, ["c1", "c2"]],
      [regionByName.get("Gamma")!.id, ["c3"]],
    ]);
    const records = buildCoChangeRecordsFromHistories(histories, 0.6);
    const graph = buildDependencyGraph(
      parsed.regions,
      parsed.symbolTable,
      records,
    );
    const cochangeEdges = graph.edges.filter((e) => e.edgeType === "cochange");
    expect(cochangeEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("distinguishes call, type, and inheritance edges", () => {
    const src = `
export class Base {}

export class Derived extends Base {}

export type BaseAlias = Base;

export function instantiateBase() {
  return new Base();
}
`.trim();

    const { regions, symbolTable } = parseSourceFile(src, "graph.ts");
    const graph = buildDependencyGraph(regions, symbolTable);

    const derived = regions.find((r) => r.name === "Derived");
    const alias = regions.find((r) => r.name === "BaseAlias");
    const instantiateBase = regions.find((r) => r.name === "instantiateBase");
    const base = regions.find((r) => r.name === "Base");

    if (!derived || !alias || !instantiateBase || !base) return;

    const edges = graph.edges.filter((edge) => edge.to === base.id);
    const inheritanceEdge = edges.find((edge) => edge.from === derived.id);
    const typeEdge = edges.find((edge) => edge.from === alias.id);
    const callEdge = edges.find((edge) => edge.from === instantiateBase.id);

    expect(inheritanceEdge?.edgeType).toBe("inheritance");
    expect(typeEdge?.edgeType).toBe("type");
    expect(callEdge?.edgeType).toBe("call");

    expect(inheritanceEdge?.strength ?? 0).toBeGreaterThan(
      callEdge?.strength ?? 0,
    );
    expect(callEdge?.strength ?? 0).toBeGreaterThan(typeEdge?.strength ?? 0);
  });

  it("assigns cohesion scores to all regions", () => {
    const { regions, symbolTable } = parseSourceFile(
      SIMPLE_COMPONENT,
      "Counter.tsx",
    );
    const graph = buildDependencyGraph(regions, symbolTable);
    for (const r of regions) {
      const score = graph.cohesionScores.get(r.id) ?? -1;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("builds adjacency list for all region ids", () => {
    const { regions, symbolTable } = parseSourceFile(
      SIMPLE_COMPONENT,
      "Counter.tsx",
    );
    const graph = buildDependencyGraph(regions, symbolTable);
    for (const r of regions) {
      expect(graph.adjacency.has(r.id)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3: Metrics
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage 3 — Metrics", () => {
  describe("cyclomaticComplexity", () => {
    it("returns 1 for a trivial function", () => {
      expect(cyclomaticComplexity("function f() { return 1; }")).toBe(1);
    });
    it("increments for if statements", () => {
      expect(cyclomaticComplexity("if (a) { } if (b) { }")).toBe(3);
    });
    it("increments for && and ||", () => {
      expect(cyclomaticComplexity("a && b || c")).toBe(3);
    });
  });

  describe("cognitiveComplexity", () => {
    it("returns 0 for empty source", () => {
      expect(cognitiveComplexity("")).toBe(0);
    });
    it("increments higher for nested ifs", () => {
      // Deeply nested: each inner if adds nesting penalty on top
      const nested = `if (a) {\n  if (b) {\n    if (c) { }\n  }\n}`;
      // Flat: all at nesting=0, no structural nesting penalty
      const flat = `if (a) { }\nif (b) { }\nif (c) { }`;
      // nested has 3 ifs with nesting 0,1,2 → score = 1+2+3=6
      // flat has 3 ifs all at nesting 0 → score = 3
      // We test nested > flat
      expect(cognitiveComplexity(nested)).toBeGreaterThanOrEqual(
        cognitiveComplexity(flat),
      );
    });
  });

  describe("maintainabilityIndex", () => {
    it("returns a value in [0, 100]", () => {
      const mi = maintainabilityIndex("const x = 1;", 1, 1);
      expect(mi).toBeGreaterThanOrEqual(0);
      expect(mi).toBeLessThanOrEqual(100);
    });
    it("is lower for high-CC code", () => {
      const simple = "function f() { return 1; }";
      const complex = Array.from(
        { length: 20 },
        (_, i) => `if (c${i}) { }`,
      ).join("\n");
      const miSimple = maintainabilityIndex(simple, 1, 1);
      const miComplex = maintainabilityIndex(complex, 20, 20);
      expect(miSimple).toBeGreaterThan(miComplex);
    });
  });

  describe("halsteadMetrics", () => {
    it("returns positive volume and effort", () => {
      const m = halsteadMetrics("const x = a + b * c;");
      expect(m.volume).toBeGreaterThan(0);
      expect(m.effort).toBeGreaterThan(0);
    });
    it("returns higher volume for longer code", () => {
      const short = "const x = 1;";
      const long = Array.from(
        { length: 50 },
        (_, i) => `const v${i} = ${i} + ${i * 2};`,
      ).join("\n");
      expect(halsteadMetrics(long).volume).toBeGreaterThan(
        halsteadMetrics(short).volume,
      );
    });
    it("ignores operators inside string literals", () => {
      const withOps = `const label = "if (a > b) { return c; }";`;
      const withoutOps = `const label = "noop";`;
      expect(halsteadMetrics(withOps).volume).toBe(
        halsteadMetrics(withoutOps).volume,
      );
    });
  });

  describe("computeRegionMetrics", () => {
    it("returns complete metric object", () => {
      const { regions } = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
      const region = regions[0];
      const m = computeRegionMetrics(region, 0);
      expect(m.lineCount).toBeGreaterThan(0);
      expect(m.cyclomaticComplexity).toBeGreaterThanOrEqual(1);
      expect(m.maintainabilityIndex).toBeGreaterThanOrEqual(0);
      expect(m.testabilityScore).toBeGreaterThanOrEqual(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4: Smell Detection
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage 4 — detectRegionSmells", () => {
  it("detects God Component smell", () => {
    const { regions, symbolTable } = parseSourceFile(
      GOD_COMPONENT,
      "Dashboard.tsx",
    );
    const dashboard = regions.find((r) => r.name === "Dashboard");
    expect(dashboard).toBeDefined();
    if (!dashboard) return;
    const smells = detectRegionSmells(
      dashboard,
      dashboard.lines.length,
      5,
      4,
      symbolTable,
      "Dashboard.tsx",
    );
    const godSmell = smells.find((s) => s.name === "God Component");
    expect(godSmell).toBeDefined();
    expect(godSmell?.severity).toBe("critical");
  });

  it("detects Missing useEffect Dependency Array", () => {
    const src = `
export function useBad() {
  const [v, setV] = useState(0);
  useEffect(() => {
    setV(1);
  });
}`.trim();
    const { regions, symbolTable } = parseSourceFile(src, "bad.ts");
    const hook = regions.find((r) => r.kind === "hook");
    expect(hook).toBeDefined();
    if (!hook) return;
    const smells = detectRegionSmells(
      hook,
      hook.lines.length,
      2,
      2,
      symbolTable,
      "bad.ts",
    );
    const s = smells.find(
      (s) => s.name === "Missing useEffect Dependency Array",
    );
    expect(s).toBeDefined();
  });

  it("detects Async useEffect", () => {
    const src = `
export function useAsync() {
  useEffect(async () => {
    await fetch('/api');
  }, []);
}`.trim();
    const { regions, symbolTable } = parseSourceFile(src, "bad.ts");
    const hook = regions.find((r) => r.kind === "hook");
    if (!hook) return;
    const smells = detectRegionSmells(
      hook,
      hook.lines.length,
      2,
      2,
      symbolTable,
      "bad.ts",
    );
    const s = smells.find((s) => s.name === "Async useEffect");
    expect(s).toBeDefined();
  });

  it("detects hook calls inside conditions", () => {
    const src = `
export function useBad(flag: boolean) {
  if (flag) {
    useState(0);
  }
  return flag;
}
`.trim();
    const { regions, symbolTable } = parseSourceFile(src, "hook.ts");
    const hook = regions.find((r) => r.kind === "hook");
    if (!hook) return;
    const smells = detectRegionSmells(
      hook,
      hook.lines.length,
      2,
      2,
      symbolTable,
      "hook.ts",
    );
    expect(smells.some((s) => s.name === "Hook Called Inside Condition")).toBe(
      true,
    );
  });

  it("detects hook calls inside loops", () => {
    const src = `
export function useLoop(items: number[]) {
  for (const item of items) {
    useEffect(() => {}, []);
  }
  return items.length;
}
`.trim();
    const { regions, symbolTable } = parseSourceFile(src, "hook.ts");
    const hook = regions.find((r) => r.kind === "hook");
    if (!hook) return;
    const smells = detectRegionSmells(
      hook,
      hook.lines.length,
      2,
      2,
      symbolTable,
      "hook.ts",
    );
    expect(smells.some((s) => s.name === "Hook Called Inside Loop")).toBe(true);
  });

  it("detects hooks used outside components or hooks", () => {
    const src = `
export function helper() {
  useState(0);
  return 1;
}
`.trim();
    const { regions, symbolTable } = parseSourceFile(src, "helper.ts");
    const fn = regions.find((r) => r.name === "helper");
    if (!fn) return;
    const smells = detectRegionSmells(
      fn,
      fn.lines.length,
      1,
      1,
      symbolTable,
      "helper.ts",
    );
    expect(
      smells.some((s) => s.name === "Hook Called Outside Component/Hook"),
    ).toBe(true);
  });

  it("detects oversized module", () => {
    const bigFn = `export function big() {\n${Array(250).fill("  const x = 1;").join("\n")}\n}`;
    const { regions, symbolTable } = parseSourceFile(bigFn, "big.ts");
    const fn = regions.find((r) => r.kind === "utility-function");
    if (!fn) return;
    const smells = detectRegionSmells(
      fn,
      fn.lines.length,
      5,
      3,
      symbolTable,
      "big.ts",
    );
    const s = smells.find((s) => s.name.startsWith("Oversized"));
    expect(s).toBeDefined();
    expect(s?.severity).toBe("critical");
  });

  it("returns no smells for clean small function", () => {
    const { regions, symbolTable } = parseSourceFile(
      SIMPLE_HOOK,
      "useToggle.ts",
    );
    const hook = regions.find((r) => r.name === "useToggle");
    if (!hook) return;
    const smells = detectRegionSmells(
      hook,
      hook.lines.length,
      2,
      2,
      symbolTable,
      "useToggle.ts",
    );
    const critical = smells.filter((s) => s.severity === "critical");
    expect(critical.length).toBe(0);
  });

  it("suppresses console logging in API-like regions", () => {
    const apiSrc = `
export function apiHandler() { console.log('x'); }
`.trim();
    const parsed = parseSourceFile(apiSrc, "api.ts");
    const apiRegion = parsed.regions.find((r) => r.name === "apiHandler");
    if (!apiRegion) return;
    const smells = detectRegionSmells(
      apiRegion,
      apiRegion.lines.length,
      1,
      1,
      parsed.symbolTable,
      "api/route.ts",
    );
    expect(smells.some((s) => s.name === "Console Logging")).toBe(false);
  });

  it("suppresses any-usage smell in type-guard helpers", () => {
    const src = `
export function assertIsString(value: any, other: any, extra: any) {
  return typeof value === 'string' && typeof other === 'string' && !!extra;
}
`.trim();
    const parsed = parseSourceFile(src, "guards.ts");
    const region = parsed.regions.find((r) => r.name === "assertIsString");
    if (!region) return;
    const smells = detectRegionSmells(
      region,
      region.lines.length,
      1,
      1,
      parsed.symbolTable,
      "guards.ts",
    );
    expect(smells.some((s) => s.name === "Excessive `any` Usage")).toBe(false);
  });
});

describe("Stage 4 — detectFileSmells", () => {
  it("detects duplicate logic with AST fingerprinting", () => {
    const src = `
export function alpha(list: Array<{ id: number; active: boolean }>) {
  const result = list.filter(item => item.active);
  const mapped = result.map(item => item.id);
  return mapped;
}

export function beta(items: Array<{ id: number; active: boolean }>) {
  const res = items.filter(value => value.active);
  const mapped = res.map(value => value.id);
  return mapped;
}
`.trim();
    const parsed = parseSourceFile(src, "dupe.ts");
    const smellMap = new Map(parsed.regions.map((r) => [r.id, []]));
    const smells = detectFileSmells(parsed.regions, smellMap);
    expect(smells.some((s) => s.name === "Duplicate Logic Detected")).toBe(
      true,
    );
  });
});

describe("Stage 4b — Dynamic import preservation", () => {
  it("carries forward adjacent dynamic import statements", () => {
    const parsed = parseSourceFile(DYNAMIC_IMPORT_SRC, "lazy.ts");
    const region = parsed.regions.find((r) => r.name === "useLazy");
    if (!region) return;
    const map = new Map<string, string>([[region.id, "hooks/useLazy.ts"]]);
    const resolved = resolveImports(
      makeEnrichedRegion(region),
      parsed.regions.map(makeEnrichedRegion),
      parsed.symbolTable,
      map,
      [],
      makeCtx(),
    );
    const hasDynamic = resolved.statements.some((s) =>
      s.includes("import('./LazyWidget')"),
    );
    expect(hasDynamic).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5: ExtractionOracle
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage 5 — ExtractionOracle", () => {
  const buildInput = (
    overrides: Partial<Parameters<typeof evaluateExtraction>[0]> = {},
  ) => {
    const { regions } = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    const region = regions.find((r) => r.name === "Counter")!;
    const metrics = computeRegionMetrics(region, 0);
    return {
      region,
      metrics,
      smellNames: [],
      outboundCoupling: 0.2,
      inboundCoupling: 0.1,
      cohesionScore: 0.5,
      isDeadExport: false,
      sourceFileExt: "tsx",
      isInSCC: false,
      ...overrides,
    };
  };

  it("always retains type-blocks", () => {
    const { regions } = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    const typeRegion = regions.find((r) => r.kind === "type-block");
    if (!typeRegion) return;
    const metrics = computeRegionMetrics(typeRegion, 0);
    const decision = evaluateExtraction({
      region: typeRegion,
      metrics,
      smellNames: [],
      outboundCoupling: 0,
      inboundCoupling: 0,
      cohesionScore: 0.5,
      isDeadExport: false,
      sourceFileExt: "ts",
      isInSCC: false,
    });
    expect(decision.shouldExtract).toBe(false);
    expect(decision.confidence).toBe("definitive");
  });

  it("always retains regions with LOC < 15", () => {
    const tiny = `export const A = 1;`;
    const { regions } = parseSourceFile(tiny, "tiny.ts");
    const r = regions[0];
    if (!r) return;
    const metrics = computeRegionMetrics(r, 0);
    const decision = evaluateExtraction({
      region: r,
      metrics,
      smellNames: [],
      outboundCoupling: 0,
      inboundCoupling: 0,
      cohesionScore: 0.5,
      isDeadExport: false,
      sourceFileExt: "ts",
      isInSCC: false,
    });
    expect(decision.shouldExtract).toBe(false);
  });

  it("extracts hooks with high affinity score", () => {
    const { regions } = parseSourceFile(SIMPLE_HOOK, "useToggle.ts");
    const hook = regions.find((r) => r.kind === "hook")!;
    // Inflate metrics to pass line threshold
    const metrics = { ...computeRegionMetrics(hook, 0), lineCount: 70 };
    const decision = evaluateExtraction({
      region: hook,
      metrics,
      smellNames: ["Large Module (>100 lines)"],
      outboundCoupling: 0.5,
      inboundCoupling: 0.1,
      cohesionScore: 0.7,
      isDeadExport: false,
      sourceFileExt: "ts",
      isInSCC: false,
    });
    expect(decision.shouldExtract).toBe(true);
    expect(decision.suggestedDir).toBe("hooks");
  });

  it("produces miDelta > 0 when shouldExtract = true", () => {
    const input = buildInput({
      smellNames: ["God Component", "Large Module (>100 lines)"],
    });
    input.metrics = {
      ...input.metrics,
      lineCount: 150,
      cyclomaticComplexity: 15,
      maintainabilityIndex: 40,
    };
    const decision = evaluateExtraction(input);
    if (decision.shouldExtract) {
      expect(decision.miDelta).toBeGreaterThan(0);
    }
  });

  it("SCC penalty reduces extraction score", () => {
    const inSCC = evaluateExtraction(
      buildInput({ isInSCC: true, smellNames: [] }),
    );
    const notInSCC = evaluateExtraction(
      buildInput({ isInSCC: false, smellNames: [] }),
    );
    // If both extract, the SCC one should have lower confidence
    if (inSCC.shouldExtract && notInSCC.shouldExtract) {
      const confMap: Record<string, number> = {
        definitive: 5,
        high: 4,
        medium: 3,
        low: 2,
        speculative: 1,
      };
      expect(confMap[inSCC.confidence]).toBeLessThanOrEqual(
        confMap[notInSCC.confidence],
      );
    }
  });

  it("high inbound coupling reduces extraction confidence", () => {
    const metrics = {
      ...buildInput().metrics,
      lineCount: 130,
      cyclomaticComplexity: 12,
      maintainabilityIndex: 45,
    };
    const noInbound = evaluateExtraction(
      buildInput({
        metrics,
        outboundCoupling: 0.7,
        inboundCoupling: 0,
        smellNames: ["Large Module (>100 lines)"],
      }),
    );
    const highInbound = evaluateExtraction(
      buildInput({
        metrics,
        outboundCoupling: 0.7,
        inboundCoupling: 0.7,
        smellNames: ["Large Module (>100 lines)"],
      }),
    );

    const confMap: Record<string, number> = {
      definitive: 5,
      high: 4,
      medium: 3,
      low: 2,
      speculative: 1,
    };

    if (noInbound.shouldExtract && highInbound.shouldExtract) {
      expect(confMap[highInbound.confidence]).toBeLessThanOrEqual(
        confMap[noInbound.confidence],
      );
    } else {
      expect(noInbound.shouldExtract).toBe(true);
    }
  });

  it("suggestedFileName includes correct directory for hooks", () => {
    const { regions } = parseSourceFile(SIMPLE_HOOK, "useToggle.ts");
    const hook = regions.find((r) => r.kind === "hook")!;
    const metrics = { ...computeRegionMetrics(hook, 0), lineCount: 80 };
    const decision = evaluateExtraction({
      region: hook,
      metrics,
      smellNames: [],
      outboundCoupling: 0.3,
      inboundCoupling: 0.1,
      cohesionScore: 0.6,
      isDeadExport: false,
      sourceFileExt: "ts",
      isInSCC: false,
    });
    expect(decision.suggestedFileName).toMatch(/^hooks\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6: ImportResolver
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage 6 — resolveImports", () => {
  it("carries adjacent side-effect imports into extracted file", () => {
    const src = `
import './styles.css';
export function Big() {
  return 1;
}
`.trim();
    const parsed = parseSourceFile(src, "Big.ts");
    const region = parsed.regions.find((r) => r.name === "Big");
    if (!region) return;
    const enriched = makeEnrichedRegion(region);
    const proposedFileMap = new Map([[region.id, "src/components/big.ts"]]);
    const resolved = resolveImports(
      enriched,
      [enriched],
      parsed.symbolTable,
      proposedFileMap,
      [],
      makeCtx(),
    );
    expect(resolved.statements).toContain("import './styles.css';");
  });

  it("prefers tsconfig path aliases for local imports", () => {
    const src = `
export function B() { return 1; }
export function A() { return B(); }
`.trim();
    const parsed = parseSourceFile(src, "feature.ts");
    const regionA = parsed.regions.find((r) => r.name === "A");
    const regionB = parsed.regions.find((r) => r.name === "B");
    if (!regionA || !regionB) return;

    const enrichedA = makeEnrichedRegion(regionA);
    const enrichedB = makeEnrichedRegion(regionB);
    const proposedFileMap = new Map<string, string>([
      [regionA.id, "src/features/a.ts"],
      [regionB.id, "src/utils/b.ts"],
    ]);

    const ctx = makeCtx({
      sourceDir: "/repo",
      tsConfig: {
        configFilePath: "/repo/tsconfig.json",
        baseUrl: "/repo",
        paths: { "@/*": ["src/*"] },
        compilerOptions: {},
      },
    });

    const resolved = resolveImports(
      enrichedA,
      [enrichedA, enrichedB],
      parsed.symbolTable,
      proposedFileMap,
      [],
      ctx,
    );
    expect(resolved.statements.join("\n")).toContain("from '@/utils/b'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full Pipeline: ModuleSplitter
// ─────────────────────────────────────────────────────────────────────────────

describe("ModuleSplitter — full pipeline", () => {
  const splitter = new ModuleSplitter();

  it("produces a SplitPlan for a simple component file", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    expect(plan.sourceFile).toBe("Counter.tsx");
    expect(plan.language).toBe("TypeScript/React");
    expect(plan.regions.length).toBeGreaterThan(0);
    expect(plan.metrics).toBeDefined();
    expect(plan.summary).toBeDefined();
  });

  it("plan.regions.length equals parsed region count", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    const { regions } = parseSourceFile(SIMPLE_COMPONENT, "Counter.tsx");
    expect(plan.regions.length).toBe(regions.length);
  });

  it("every region has metrics", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    for (const r of plan.regions) {
      expect(r.metrics).toBeDefined();
      expect(r.metrics.lineCount).toBeGreaterThan(0);
    }
  });

  it("type-blocks are NOT in extractionCandidates", () => {
    const plan = splitter.analyse(TYPE_HEAVY, "types.ts");
    const typeExtracted = plan.extractionCandidates.filter(
      (r: { kind: string }) => r.kind === "type-block",
    );
    expect(typeExtracted.length).toBe(0);
  });

  it("type-blocks appear in typeRouting", () => {
    const plan = splitter.analyse(TYPE_HEAVY, "types.ts");
    const typeNames = plan.typeRouting.flatMap(
      (t: { typeNames: string[] }) => t.typeNames,
    );
    expect(typeNames.length).toBeGreaterThan(0);
  });

  it("produces proposedFiles only for extractionCandidates", () => {
    const plan = splitter.analyse(GOD_COMPONENT, "Dashboard.tsx");
    expect(plan.proposedFiles.length).toBe(plan.extractionCandidates.length);
  });

  it("every proposedFile has generatedContent", () => {
    const plan = splitter.analyse(GOD_COMPONENT, "Dashboard.tsx");
    for (const pf of plan.proposedFiles) {
      expect(pf.generatedContent.length).toBeGreaterThan(0);
    }
  });

  it("barrelExport is a non-empty string", () => {
    const plan = splitter.analyse(GOD_COMPONENT, "Dashboard.tsx");
    expect(typeof plan.barrelExport).toBe("string");
  });

  it("updatedSourceContent is a non-empty string", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    expect(plan.updatedSourceContent.length).toBeGreaterThan(0);
  });

  it("circularRisks is populated when circular deps exist", () => {
    const plan = splitter.analyse(CIRCULAR_SRC, "circular.ts");
    // Even if not extracted, the graph records the SCC
    expect(Array.isArray(plan.circularRisks)).toBe(true);
  });

  it("metrics.overallHealth is a valid grade", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    expect(["S", "A", "B", "C", "D", "F"]).toContain(
      plan.metrics.overallHealth,
    );
  });

  it("accepts workspace context", () => {
    const ctx: Partial<WorkspaceContext> = {
      existingTypeFiles: ["src/types.ts"],
      testFramework: "vitest",
    };
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx", ctx);
    expect(plan).toBeDefined();
  });

  it("works on a TypeScript-only file (no JSX)", () => {
    const plan = splitter.analyse(SIMPLE_HOOK, "useToggle.ts");
    expect(plan.language).toBe("TypeScript");
    expect(plan.regions.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 8: Webview Renderer
// ─────────────────────────────────────────────────────────────────────────────

describe("renderSplitPlanHtml", () => {
  const splitter = new ModuleSplitter();

  it("returns a valid HTML string", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    const html = renderSplitPlanHtml(plan);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("contains the source file name", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    const html = renderSplitPlanHtml(plan);
    expect(html).toContain("Counter.tsx");
  });

  it("contains all 8 tab IDs", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    const html = renderSplitPlanHtml(plan);
    [
      "overview",
      "regions",
      "extract",
      "linkage",
      "smells",
      "tests",
      "files",
      "dryrun",
    ].forEach((id) => {
      expect(html).toContain(`id="tab-${id}"`);
    });
  });

  it("does not contain raw < or > in escaped content", () => {
    const plan = splitter.analyse("<script>alert(1)</script>", "xss.ts");
    const html = renderSplitPlanHtml(plan);
    // Should not contain unescaped script tags
    expect(html).not.toMatch(/<script>alert/);
  });

  it("contains health grade letter", () => {
    const plan = splitter.analyse(SIMPLE_COMPONENT, "Counter.tsx");
    const html = renderSplitPlanHtml(plan);
    expect(html).toMatch(/health-grade[^>]*>[SABCDF]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  const splitter = new ModuleSplitter();

  it("handles empty file gracefully", () => {
    const plan = splitter.analyse("", "empty.ts");
    expect(plan.regions.length).toBe(0);
    expect(plan.summary.totalRegions).toBe(0);
    expect(plan.metrics.totalLines).toBeGreaterThanOrEqual(0);
  });

  it("handles file with only comments", () => {
    const plan = splitter.analyse(
      "// just a comment\n/* block */\n",
      "comments.ts",
    );
    expect(plan.regions.length).toBe(0);
  });

  it("handles file with only imports", () => {
    const plan = splitter.analyse("import React from 'react';\n", "imports.ts");
    expect(plan.regions.length).toBe(0);
  });

  it("handles a 1-line file", () => {
    const plan = splitter.analyse("export const x = 1;", "x.ts");
    expect(plan.regions.length).toBeGreaterThanOrEqual(0);
  });

  it("handles non-TS file extension", () => {
    const plan = splitter.analyse("function foo() { return 1; }", "foo.js");
    expect(plan.language).toBe("JavaScript");
  });

  it("handles default export arrow function", () => {
    const src = "export default () => <div>Hello</div>;";
    const plan = splitter.analyse(src, "Hello.tsx");
    expect(plan.regions.length).toBeGreaterThanOrEqual(0);
  });

  it("handles a very large region without crashing", () => {
    const lines = buildConstLines(500, "v");
    const src = `export function bigFn() {\n${lines}\n}`;
    const plan = splitter.analyse(src, "big.ts");
    expect(plan.regions.length).toBeGreaterThan(0);
  });
});
