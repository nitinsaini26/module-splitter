/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Code Smell Detector                                             ║
 * ║                                                                              ║
 * ║  Detects 20+ code smells across React, TypeScript, and general patterns.    ║
 * ║  Each smell carries severity, description, affected regions, and an         ║
 * ║  auto-fix flag indicating whether the splitter can remediate it.            ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as ts from "typescript";
import type { ASTRegion, CodeSmell, RegionKind, SymbolTable } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Per-region smell detection
// ─────────────────────────────────────────────────────────────────────────────

function count(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

function scriptKindFromPath(filePath: string): ts.ScriptKind {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "tsx" || ext === "jsx") return ts.ScriptKind.TSX;
  if (ext === "js" || ext === "mjs" || ext === "cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function normalizeAstFingerprint(node: ts.Node): string {
  const identMap = new Map<string, number>();
  let identCount = 0;

  const walk = (n: ts.Node): string => {
    if (ts.isIdentifier(n)) {
      const key = n.text;
      if (!identMap.has(key)) identMap.set(key, identCount++);
      return `ID_${identMap.get(key)}`;
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNumericLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      n.kind === ts.SyntaxKind.TemplateHead ||
      n.kind === ts.SyntaxKind.TemplateMiddle ||
      n.kind === ts.SyntaxKind.TemplateTail
    ) {
      return "LIT";
    }
    const children: string[] = [];
    ts.forEachChild(n, (child) => children.push(walk(child)));
    return `${ts.SyntaxKind[n.kind]}(${children.join(",")})`;
  };

  return walk(node);
}

function collectAstFingerprints(
  src: string,
  scriptKind: ts.ScriptKind,
): string[] {
  const sf = ts.createSourceFile(
    "region.tsx",
    src,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const fingerprints: string[] = [];

  const addStatementSequence = (statements: readonly ts.Statement[]): void => {
    if (statements.length < 3) return;
    const stmtPrints = statements.map((stmt) => normalizeAstFingerprint(stmt));
    for (let i = 0; i <= stmtPrints.length - 3; i++) {
      const seqTextLen =
        statements[i].getText(sf).length +
        statements[i + 1].getText(sf).length +
        statements[i + 2].getText(sf).length;
      if (seqTextLen < 60) continue;
      const chunk = stmtPrints.slice(i, i + 3).join("|");
      if (chunk.length < 80) continue;
      fingerprints.push(chunk);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      addStatementSequence(node.statements);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return fingerprints;
}

function detectHookRuleViolations(
  region: ASTRegion,
  src: string,
  filePath: string,
): RegionSmell[] {
  const smells: RegionSmell[] = [];
  const scriptKind = scriptKindFromPath(filePath);
  const sf = ts.createSourceFile(
    "hook.tsx",
    src,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  let hasHookCall = false;
  let hasConditionalHook = false;
  let hasLoopHook = false;

  const isHookCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    /^use[A-Z]/.test(node.expression.text);

  const walk = (node: ts.Node, inBranch: boolean, inLoop: boolean): void => {
    if (isHookCall(node)) {
      hasHookCall = true;
      if (inBranch) hasConditionalHook = true;
      if (inLoop) hasLoopHook = true;
    }

    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isSwitchStatement(node)
    ) {
      ts.forEachChild(node, (child) => walk(child, true, inLoop));
      return;
    }

    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      ts.forEachChild(node, (child) => walk(child, inBranch, true));
      return;
    }

    ts.forEachChild(node, (child) => walk(child, inBranch, inLoop));
  };

  walk(sf, false, false);

  if (hasConditionalHook) {
    smells.push({
      name: "Hook Called Inside Condition",
      severity: "critical",
      description: "Hook call detected inside a conditional branch",
      recommendation: "Move hook calls to the top level of the component/hook",
      autoFixable: false,
    });
  }

  if (hasLoopHook) {
    smells.push({
      name: "Hook Called Inside Loop",
      severity: "critical",
      description: "Hook call detected inside a loop",
      recommendation: "Move hook calls to the top level of the component/hook",
      autoFixable: false,
    });
  }

  const allowedKinds = new Set<RegionKind>([
    "hook",
    "react-component",
    "context-provider",
    "hoc",
  ]);
  if (hasHookCall && !allowedKinds.has(region.kind)) {
    smells.push({
      name: "Hook Called Outside Component/Hook",
      severity: "critical",
      description: "Hook call detected in a non-component, non-hook region",
      recommendation: "Move hook usage into a React component or a custom hook",
      autoFixable: false,
    });
  }

  return smells;
}

export interface RegionSmell {
  name: string;
  severity: CodeSmell["severity"];
  description: string;
  recommendation: string;
  autoFixable: boolean;
}

export function detectRegionSmells(
  region: ASTRegion,
  lineCount: number,
  cc: number,
  nesting: number,
  symbolTable?: SymbolTable,
  filePath: string = "",
): RegionSmell[] {
  const smells: RegionSmell[] = [];
  const src = region.lines.join("\n");
  const kind: RegionKind = region.kind;

  const isTestFile = /test|spec|__tests__/i.test(filePath);
  const hasLoggerImport = symbolTable
    ? [...symbolTable.imports.values()].some((rec) =>
        ["pino", "winston"].includes(rec.specifier),
      )
    : false;

  // ── React-specific smells ────────────────────────────────────────────────

  if (kind === "react-component" || kind === "context-provider") {
    let concerns = 0;
    if (/useState|useReducer/.test(src)) concerns++;
    if (/useEffect/.test(src)) concerns++;
    if (/fetch|axios|useSWR|useQuery/.test(src)) concerns++;
    if (/\.(map|filter|reduce)\(/.test(src)) concerns++;
    if (/styled\.|css`|className/.test(src)) concerns++;
    if (/dispatch|createSlice|useSelector/.test(src)) concerns++;

    if (concerns >= 4) {
      smells.push({
        name: "God Component",
        severity: "critical",
        description: `Component handles ${concerns} distinct concerns (state, effects, data-fetching, transforms, styles, store)`,
        recommendation:
          "Extract each concern into dedicated hooks and sub-components",
        autoFixable: true,
      });
    }

    // Prop drilling detection (props.x.y.z)
    if (count(src, /props\.\w+\.\w+\.\w+/g) >= 2) {
      smells.push({
        name: "Prop Drilling",
        severity: "high",
        description: "Props passed through multiple levels (>2 depth)",
        recommendation:
          "Introduce React Context or a custom hook to pass shared state",
        autoFixable: false,
      });
    }

    // Mixed API + render
    if (/fetch\(|axios\.|\.then\(/.test(src) && /<[A-Z][\w]*/.test(src)) {
      smells.push({
        name: "Mixed Concerns — API + Render",
        severity: "high",
        description: "Data-fetching logic co-located with JSX render",
        recommendation: "Extract API calls into a dedicated custom hook",
        autoFixable: true,
      });
    }

    // Excessive inline styles
    if (count(src, /style\s*=\s*\{\{/g) > 3) {
      smells.push({
        name: "Excessive Inline Styles",
        severity: "low",
        description: "More than 3 inline style objects in component",
        recommendation:
          "Move inline styles to CSS modules or styled-components",
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
        name: "Missing Memoisation on Mapped JSX",
        severity: "medium",
        description:
          "JSX map() without useMemo may cause unnecessary re-renders",
        recommendation:
          "Wrap the mapped array in useMemo(() => ..., [dep]) or extract to a sub-component",
        autoFixable: false,
      });
    }

    // Direct DOM manipulation in React
    if (/document\.(getElementById|querySelector|createElement)/.test(src)) {
      smells.push({
        name: "Direct DOM Manipulation",
        severity: "high",
        description: "Direct DOM access bypasses React reconciliation",
        recommendation:
          "Use useRef for element references and React portals for out-of-tree renders",
        autoFixable: false,
      });
    }

    // setState in render body (outside useEffect)
    if (/setState\(|useState/.test(src) && !/<\w/.test(src) === false) {
      if (
        /setState\([^)]*\)(?!\s*,\s*\(\))/.test(src) &&
        !/useEffect/.test(src)
      ) {
        smells.push({
          name: "SetState Outside Effect",
          severity: "critical",
          description:
            "Calling setState directly in render body causes infinite re-render",
          recommendation:
            "Move state updates inside useEffect or event handlers",
          autoFixable: false,
        });
      }
    }
  }

  // ── Hook-specific smells ─────────────────────────────────────────────────

  if (kind === "hook") {
    // Missing dependency array in useEffect
    if (
      /useEffect\s*\(\s*(?:async\s*)?\(\s*\)\s*=>/.test(src) &&
      !/,\s*\[/.test(src)
    ) {
      smells.push({
        name: "Missing useEffect Dependency Array",
        severity: "high",
        description: "useEffect without dependency array runs on every render",
        recommendation:
          "Add a dependency array: useEffect(() => {...}, [dep1, dep2])",
        autoFixable: false,
      });
    }

    // Async directly in useEffect (should use IIFE)
    if (/useEffect\s*\(\s*async/.test(src)) {
      smells.push({
        name: "Async useEffect",
        severity: "medium",
        description: "useEffect callback should not be async directly",
        recommendation:
          "Use an inner async IIFE: useEffect(() => { const run = async () => {...}; run(); }, [])",
        autoFixable: false,
      });
    }
  }

  if (region.hasHooks || /^use[A-Z]/.test(region.name)) {
    smells.push(...detectHookRuleViolations(region, src, filePath));
  }

  // ── General smells ───────────────────────────────────────────────────────

  if (lineCount > 200) {
    smells.push({
      name: "Oversized Module (>200 lines)",
      severity: "critical",
      description: `Region is ${lineCount} lines — well beyond single-responsibility threshold`,
      recommendation:
        "Split into smaller, focused modules (target: <80 lines each)",
      autoFixable: true,
    });
  } else if (lineCount > 100) {
    smells.push({
      name: "Large Module (>100 lines)",
      severity: "high",
      description: `Region is ${lineCount} lines`,
      recommendation: "Consider splitting into smaller, focused modules",
      autoFixable: true,
    });
  }

  if (nesting > 8) {
    smells.push({
      name: "Extreme Nesting (>8 levels)",
      severity: "critical",
      description: `Maximum bracket depth is ${nesting}`,
      recommendation:
        "Flatten nesting with early returns, guard clauses, or extracted helper functions",
      autoFixable: false,
    });
  } else if (nesting > 5) {
    smells.push({
      name: "Deep Nesting (>5 levels)",
      severity: "medium",
      description: `Maximum bracket depth is ${nesting}`,
      recommendation:
        "Refactor using early returns or helper functions to reduce nesting",
      autoFixable: false,
    });
  }

  if (cc > 20) {
    smells.push({
      name: "Extreme Cyclomatic Complexity (>20)",
      severity: "critical",
      description: `Cyclomatic complexity is ${cc} — extremely hard to test`,
      recommendation:
        "Break into smaller functions; aim for CC ≤ 10 per function",
      autoFixable: true,
    });
  } else if (cc > 10) {
    smells.push({
      name: "High Cyclomatic Complexity (>10)",
      severity: "high",
      description: `Cyclomatic complexity is ${cc}`,
      recommendation:
        "Reduce branching by extracting conditional logic into named predicates",
      autoFixable: true,
    });
  }

  // Magic numbers
  if (count(src, /\b(?<!['"./])(?!0\.)\d{2,}\b(?!['"./])/g) > 4) {
    smells.push({
      name: "Magic Numbers",
      severity: "low",
      description: "Hard-coded numeric literals scattered through code",
      recommendation: "Extract to named constants (e.g. const MAX_RETRIES = 3)",
      autoFixable: false,
    });
  }

  // Long switch statement
  if (count(src, /\bcase\b/g) > 8) {
    smells.push({
      name: "Long Switch Statement",
      severity: "medium",
      description: `Switch has ${count(src, /\bcase\b/g)} cases`,
      recommendation: "Replace with a lookup map/object or strategy pattern",
      autoFixable: false,
    });
  }

  // TODO / FIXME debt
  if (count(src, /\/\/.*(?:TODO|FIXME|HACK|XXX)/g) > 2) {
    smells.push({
      name: "TODO/FIXME Debt",
      severity: "low",
      description: `${count(src, /\/\/.*(?:TODO|FIXME|HACK|XXX)/g)} unresolved TODO/FIXME comments`,
      recommendation:
        "Resolve or track in issue tracker; remove inline debt comments",
      autoFixable: false,
    });
  }

  // Console logs in production code
  if (
    count(src, /\bconsole\.(log|warn|error|debug|info)\b/g) > 0 &&
    !isTestFile &&
    !/api|middleware|server|route/i.test(region.name) &&
    !hasLoggerImport
  ) {
    smells.push({
      name: "Console Logging",
      severity: "low",
      description: "console.* calls found in non-test code",
      recommendation:
        "Replace with a proper logger (e.g. pino, winston) or remove before production",
      autoFixable: false,
    });
  }

  // Any type usage (TypeScript anti-pattern)
  if (
    count(src, /:\s*any\b/g) > 2 &&
    !/isRecord|assertIs|typeGuard|isType/i.test(region.name)
  ) {
    smells.push({
      name: "Excessive `any` Usage",
      severity: "medium",
      description: `${count(src, /:\s*any\b/g)} uses of \`any\` type — bypasses type safety`,
      recommendation:
        "Replace with specific types, generics, or unknown + type guards",
      autoFixable: false,
    });
  }

  // Non-null assertion abuse
  if (count(src, /[^!]!\s*[.[(]/g) > 3) {
    smells.push({
      name: "Non-null Assertion Abuse",
      severity: "medium",
      description: "Multiple non-null assertion operators (!) found",
      recommendation:
        "Use optional chaining (?.) or proper null checks instead",
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
  regionSmellMap: Map<string, RegionSmell[]>,
): CodeSmell[] {
  const fileSmells: CodeSmell[] = [];

  // Duplicate logic fingerprinting — normalized AST fingerprints
  const astFingerprints = new Map<string, string[]>();

  for (const region of regions) {
    const scriptKind = region.hasJSX ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const fingerprints = collectAstFingerprints(
      region.lines.join("\n"),
      scriptKind,
    );
    for (const fp of fingerprints) {
      const existing = astFingerprints.get(fp) ?? [];
      existing.push(region.id);
      astFingerprints.set(fp, existing);
    }
  }

  const duplicates = [...astFingerprints.entries()]
    .filter(([, ids]) => new Set(ids).size > 1)
    .map(([, ids]) => [...new Set(ids)]);

  if (duplicates.length > 0) {
    const affectedIds = [...new Set(duplicates.flat())];
    fileSmells.push({
      name: "Duplicate Logic Detected",
      severity: "high",
      description: `${duplicates.length} groups of repeated code blocks (≥3 lines) across regions`,
      affectedRegionIds: affectedIds,
      recommendation: "Extract shared logic into a utility function in utils/",
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
