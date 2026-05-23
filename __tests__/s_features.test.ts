import { parseSourceFile } from "../src/splitter/parser/astParser";
import { semanticTypeResolver } from "../src/splitter/semantic/semanticTypeResolver";
import {
  cognitiveComplexityExact,
  cognitiveComplexityWeighted,
} from "../src/splitter/analysis/cognitiveComplexityExact";
import { commentQualityMetric } from "../src/splitter/analysis/metrics";
import * as h from "../src/splitter/utils/helpers";

test("S-category features smoke test", () => {
  // A3 — multi-declaration splitting
  const srcA3 = `export const a = () => 1, b = () => 2, C = 3;`;
  const res = parseSourceFile(srcA3, "file.ts");
  const names = res.regions.map((r) => r.name).sort();
  expect(names).toContain("a");
  expect(names).toContain("b");
  expect(names).toContain("C");
  expect(names.length).toBeGreaterThanOrEqual(3);

  // D5 — strict mode detection
  const srcD5 = `"use strict"; export function foo() {}`;
  const info = semanticTypeResolver.resolveFile("/tmp/x.ts", srcD5);
  expect(info.resolved).toBe(true);
  expect(info.strict).toBe(true);

  // C2 — weighted cognitive complexity
  const srcC2 = `function f(x){ if(x) { for(let i=0;i<10;i++){ if(i%2) return i; } } }`;
  const base = cognitiveComplexityExact(srcC2);
  const weighted = cognitiveComplexityWeighted(srcC2, 2);
  expect(weighted).toBeGreaterThan(base);

  // A2 — chained method detection
  expect(
    h.hasChainedCalls("obj.fetch().then(x => x).map(y => y).filter(Boolean);"),
  ).toBe(true);
  expect(h.hasChainedCalls("const a = foo(bar);")).toBe(false);

  // C3 — comment quality metric
  const srcC3 = `// one\n// two\nconst a = 1;\nconst b = 2;\n`;
  const q = commentQualityMetric(srcC3);
  expect(q).toBeGreaterThan(0);
  expect(typeof q).toBe("number");

  // Helpers — exercise common helpers for coverage
  expect(h.esc("<&>")).toContain("&lt;");
  expect(h.toKebabCase("MyThing")).toBe("my-thing");
  expect(h.toTitleCase("myThing")).toBe("My Thing");
  expect(h.truncate("abcd", 3).length).toBeGreaterThan(0);
  expect(h.unique([1, 2, 2])).toEqual([1, 2]);
  const g = h.groupBy(["a", "bb", "ccc"], (s) => s.length.toString() as string);
  expect(Object.keys(g).length).toBeGreaterThan(0);
  expect(h.clamp(5, 1, 4)).toBe(4);
  expect(h.severityRank("high")).toBeGreaterThan(0);
  expect(h.confidencePercent("high")).toBeGreaterThan(0);
  expect(h.formatMinutes(90)).toContain("h");
  expect(h.basename("/a/b/c.txt")).toBe("c.txt");
  expect(h.dirname("/a/b/c.txt")).toBe("/a/b");
  expect(h.extname("/a/b/c.txt")).toBe(".txt");
  expect(h.stripExtension("file.ts")).toBe("file");
  expect(h.hasChainedCalls("a().b().c()")).toBe(true);
});
