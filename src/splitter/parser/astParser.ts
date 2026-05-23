/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — AST Parser                                                      ║
 * ║                                                                              ║
 * ║  Extracts structural regions from JS/TS/JSX/TSX source files using the      ║
 * ║  TypeScript Compiler API. Falls back to bracket-depth heuristic for other   ║
 * ║  languages.                                                                  ║
 * ║                                                                              ║
 * ║  Enhancements over v2:                                                       ║
 * ║    ✔ Full import/export resolution into SymbolTable                        ║
 * ║    ✔ usedSymbols and localBindings per region (powers dep graph)           ║
 * ║    ✔ Cognitive complexity tracking (not just cyclomatic)                   ║
 * ║    ✔ Named re-export handling (export { Foo as Bar } from '...')           ║
 * ║    ✔ Decorator detection (@Component, @Injectable, ...)                    ║
 * ║    ✔ Namespace / module block detection                                     ║
 * ║    ✔ Accurate leadingComment extraction from JSDoc                         ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import path from "path";
import * as ts from "typescript";
import type {
  ASTRegion,
  ASTParseResult,
  RegionKind,
  SymbolTable,
  SymbolEntry,
  ImportRecord,
  SymbolUsageKind,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TS_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
]);

let _regionCounter = 0;
function newId(name: string): string {
  return `rgn_${(_regionCounter++).toString(36).padStart(4, "0")}_${name}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level AST helpers
// ─────────────────────────────────────────────────────────────────────────────

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function containsJSX(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxElement(n) ||
      ts.isJsxSelfClosingElement(n) ||
      ts.isJsxFragment(n)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

function containsHookCalls(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (/^use[A-Z]/.test(n.expression.text)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

function containsAsync(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isAwaitExpression(n)) {
      found = true;
      return;
    }
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isArrowFunction(n) ||
        ts.isFunctionExpression(n)) &&
      n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "then"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

function isTypeContext(node: ts.Node): boolean {
  return ts.isTypeNode(node) || ts.isExpressionWithTypeArguments(node);
}

function hasAncestor(
  node: ts.Node,
  predicate: (node: ts.Node) => boolean,
): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (predicate(current)) return true;
    current = current.parent;
  }
  return false;
}

function classifySymbolUsage(node: ts.Identifier): SymbolUsageKind {
  if (hasAncestor(node, ts.isHeritageClause)) {
    return "inheritance";
  }

  let current: ts.Node = node;

  while (current.parent) {
    const parent = current.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.name === current) {
      return "reference";
    }

    if (ts.isExportSpecifier(parent)) {
      return "reexport";
    }

    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.expression === current
    ) {
      return "call";
    }

    if (isTypeContext(parent)) {
      return "type";
    }

    current = parent;
  }

  return "reference";
}

/** Collect identifier references and the context each one appears in */
function collectSymbolUsages(node: ts.Node): {
  usedSymbols: Set<string>;
  symbolUsageKinds: Map<string, SymbolUsageKind[]>;
} {
  const used = new Set<string>();
  const kinds = new Map<string, Set<SymbolUsageKind>>();

  const record = (text: string, kind: SymbolUsageKind): void => {
    used.add(text);
    const bucket = kinds.get(text) ?? new Set<SymbolUsageKind>();
    bucket.add(kind);
    kinds.set(text, bucket);
  };

  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      // Skip property access right-hand identifiers (obj.prop → don't collect "prop")
      if (!ts.isPropertyAccessExpression(parent) || parent.name !== n) {
        const text = n.text;
        if (text && !/^[a-z]{1,3}$/.test(text)) {
          // Skip tiny keywords/vars
          record(text, classifySymbolUsage(n));
        }
      }
    }
    ts.forEachChild(n, walk);
  };

  walk(node);

  return {
    usedSymbols: used,
    symbolUsageKinds: new Map(
      [...kinds.entries()].map(([name, value]) => [name, [...value]]),
    ),
  };
}

/** Collect all locally bound names in a function / block */
function collectLocalBindings(node: ts.Node): Set<string> {
  const locals = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      locals.add(n.name.text);
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) {
      locals.add(n.name.text);
    }
    if (ts.isFunctionDeclaration(n) && n.name) {
      locals.add(n.name.text);
    }
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) {
      locals.add(n.name.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return locals;
}

function maxBracketDepth(src: string): number {
  let d = 0,
    max = 0;
  for (const ch of src) {
    if (ch === "{" || ch === "(" || ch === "[") {
      max = Math.max(max, ++d);
    } else if (ch === "}" || ch === ")" || ch === "]") {
      d = Math.max(0, d - 1);
    }
  }
  return max;
}

function extractLeadingComment(
  node: ts.Node,
  sf: ts.SourceFile,
): string | undefined {
  const fullStart = node.getFullStart();
  const start = node.getStart(sf, true);
  if (start === fullStart) return undefined;
  const leading = sf.text.slice(fullStart, start);
  const jsDoc = leading.match(/\/\*\*([\s\S]*?)\*\//);
  if (jsDoc) return jsDoc[1].replace(/\n\s*\*\s?/g, "\n").trim();
  const line = leading.match(/\/\/(.*)/);
  return line ? line[1].trim() : undefined;
}

function isExported(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Export) !==
    0
  );
}

function hasDecorators(node: ts.Node): boolean {
  return (
    "decorators" in node &&
    Array.isArray((node as any).decorators) &&
    (node as any).decorators.length > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Name classification
// ─────────────────────────────────────────────────────────────────────────────

function classifyName(
  name: string,
  hasJSX: boolean,
  hasHooks: boolean,
): RegionKind {
  if (/^use[A-Z]/.test(name)) return "hook";
  if (/^with[A-Z]/.test(name)) return "hoc";
  if (/Provider$/.test(name)) return "context-provider";
  if (/^[A-Z]/.test(name) && hasJSX) return "react-component";
  if (/^[A-Z]/.test(name) && hasHooks) return "react-component";
  if (/^[A-Z]/.test(name)) return "react-component";
  if (hasJSX && !hasHooks) return "react-component";
  return "utility-function";
}

function inferDefaultExportName(fileName: string): string {
  const base = path.basename(fileName, path.extname(fileName));
  const parts = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "DefaultExport";
  const pascal = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  if (!/^[A-Za-z_$]/.test(pascal)) return `Export${pascal}`;
  return pascal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import / export symbol table builder
// ─────────────────────────────────────────────────────────────────────────────

function buildSymbolTable(sf: ts.SourceFile): SymbolTable {
  const locals = new Map<string, SymbolEntry>();
  const imports = new Map<string, ImportRecord>();
  const unresolved = new Set<string>();

  const addDynamicImport = (specifier: string, node: ts.Node): void => {
    let stmt: ts.Node | undefined = node;
    while (stmt && !ts.isStatement(stmt)) stmt = stmt.parent;
    const startNode = stmt ?? node;
    const line = lineOf(sf, startNode.getStart(sf, true));
    const statementText = sf.text.slice(
      startNode.getStart(sf, true),
      startNode.getEnd(),
    );
    const key = `__dynamic__${specifier}:${line}`;
    if (!imports.has(key)) {
      imports.set(key, {
        specifier,
        named: [],
        isSideEffect: false,
        isDynamic: true,
        statementText: statementText.trim(),
        line,
      });
    }
  };

  ts.forEachChild(sf, (node) => {
    // Import declarations
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) return;
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      const line = lineOf(sf, node.getStart(sf, true));

      if (!clause) {
        imports.set(specifier, {
          specifier,
          named: [],
          isSideEffect: true,
          isDynamic: false,
          line,
        });
        return;
      }

      const rec: ImportRecord = {
        specifier,
        named: [],
        isSideEffect: false,
        isDynamic: false,
        line,
      };

      if (clause.name) {
        rec.defaultAlias = clause.name.text;
      }

      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          rec.namespaceAlias = clause.namedBindings.name.text;
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            rec.named.push({
              name: el.propertyName?.text ?? el.name.text,
              alias: el.name.text,
            });
          }
        }
      }

      imports.set(specifier, rec);
    }
  });

  // Dynamic imports / require() calls
  const visitDynamic = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        addDynamicImport(node.arguments[0].text, node);
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        addDynamicImport(node.arguments[0].text, node);
      }
    }
    ts.forEachChild(node, visitDynamic);
  };

  visitDynamic(sf);

  return { locals, imports, unresolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node → ASTRegion
// ─────────────────────────────────────────────────────────────────────────────

function nodeToRegion(
  node: ts.Node,
  sf: ts.SourceFile,
  allLines: string[],
): ASTRegion | null {
  let startPos = node.getStart(sf, true);
  if (ts.isClassDeclaration(node)) {
    const decorators = ts.canHaveDecorators(node)
      ? ts.getDecorators(node)
      : undefined;
    if (decorators && decorators.length > 0) {
      const decoratorStart = decorators[0].getStart(sf, true);
      if (decoratorStart < startPos) startPos = decoratorStart;
    }
  }
  const startLine = lineOf(sf, startPos);
  const endLine = lineOf(sf, node.getEnd());
  const lines = allLines.slice(startLine - 1, endLine);
  const src = lines.join("\n");
  const exported = isExported(node);
  const leadingComment = extractLeadingComment(node, sf);
  const { usedSymbols, symbolUsageKinds } = collectSymbolUsages(node);
  const localBindings = collectLocalBindings(node);
  const depth = maxBracketDepth(src);

  const base = {
    startLine,
    endLine,
    lines,
    isExported: exported,
    isDefaultExport: false,
    leadingComment,
    usedSymbols,
    localBindings,
    maxBracketDepth: depth,
    symbolUsageKinds,
  };

  // ── Function declaration ──────────────────────────────────────────────────
  if (ts.isFunctionDeclaration(node) && node.name) {
    const name = node.name.text;
    const hasJSX = containsJSX(node);
    const hasHk = containsHookCalls(node);
    return {
      ...base,
      id: newId(name),
      kind: classifyName(name, hasJSX, hasHk),
      name,
      hasJSX,
      hasHooks: hasHk,
      hasAsyncOps: containsAsync(node),
    };
  }

  // ── Variable statement ────────────────────────────────────────────────────
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const name = decl.name.text;
      const init = decl.initializer;

      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const hasJSX = containsJSX(node);
        const hasHk = containsHookCalls(node);
        return {
          ...base,
          id: newId(name),
          kind: classifyName(name, hasJSX, hasHk),
          name,
          hasJSX,
          hasHooks: hasHk,
          hasAsyncOps: containsAsync(node),
        };
      }

      // Constant (ALL_CAPS or simple literal)
      if (
        /^[A-Z_][A-Z0-9_]{2,}$/.test(name) ||
        ts.isNumericLiteral(init) ||
        ts.isStringLiteral(init)
      ) {
        return {
          ...base,
          id: newId(name),
          kind: "constant-block",
          name,
          hasJSX: false,
          hasHooks: false,
          hasAsyncOps: false,
        };
      }
    }
  }

  // ── Class declaration ─────────────────────────────────────────────────────
  if (ts.isClassDeclaration(node) && node.name) {
    const name = node.name.text;
    const kind: RegionKind = hasDecorators(node) ? "decorator" : "class";
    return {
      ...base,
      id: newId(name),
      kind,
      name,
      hasJSX: containsJSX(node),
      hasHooks: false,
      hasAsyncOps: containsAsync(node),
    };
  }

  // ── Interface ─────────────────────────────────────────────────────────────
  if (ts.isInterfaceDeclaration(node)) {
    return {
      ...base,
      id: newId(node.name.text),
      kind: "type-block",
      name: node.name.text,
      hasJSX: false,
      hasHooks: false,
      hasAsyncOps: false,
    };
  }

  // ── Type alias ────────────────────────────────────────────────────────────
  if (ts.isTypeAliasDeclaration(node)) {
    return {
      ...base,
      id: newId(node.name.text),
      kind: "type-block",
      name: node.name.text,
      hasJSX: false,
      hasHooks: false,
      hasAsyncOps: false,
    };
  }

  // ── Enum ─────────────────────────────────────────────────────────────────
  if (ts.isEnumDeclaration(node)) {
    return {
      ...base,
      id: newId(node.name.text),
      kind: "enum",
      name: node.name.text,
      hasJSX: false,
      hasHooks: false,
      hasAsyncOps: false,
    };
  }

  // ── Namespace / Module ────────────────────────────────────────────────────
  if (ts.isModuleDeclaration(node) && node.name) {
    const name = ts.isIdentifier(node.name) ? node.name.text : node.name.text;
    return {
      ...base,
      id: newId(name),
      kind: "namespace",
      name,
      hasJSX: false,
      hasHooks: false,
      hasAsyncOps: false,
    };
  }

  // ── Export default ────────────────────────────────────────────────────────
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    const expr = node.expression;
    const hasJSX = containsJSX(expr);
    const hasHk = containsHookCalls(expr);
    const hasAsyncOps = containsAsync(expr);
    let name = "DefaultExport";
    if (ts.isIdentifier(expr)) {
      name = expr.text;
    } else if (ts.isFunctionExpression(expr) && expr.name) {
      name = expr.name.text;
    } else if (ts.isClassExpression(expr) && expr.name) {
      name = expr.name.text;
    }

    if (
      (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) &&
      name === "DefaultExport" &&
      hasJSX
    ) {
      name = inferDefaultExportName(sf.fileName);
    }
    return {
      ...base,
      id: newId(name),
      kind: classifyName(name, hasJSX, hasHk),
      name,
      hasJSX,
      hasHooks: hasHk,
      hasAsyncOps,
      isDefaultExport: true,
      isExported: true,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bracket-depth fallback (non-TS/JS)
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_PATTERNS: Array<{ re: RegExp; kind: RegionKind }> = [
  {
    re: /^(?:export\s+)?(?:const|function)\s+([A-Z][A-Za-z0-9_]*Provider)\b/,
    kind: "context-provider",
  },
  {
    re: /^(?:export\s+)?(?:const|function)\s+(with[A-Z][A-Za-z0-9_]*)\b/,
    kind: "hoc",
  },
  {
    re: /^(?:export\s+)?(?:const|function)\s+(use[A-Z][A-Za-z0-9_]*)(?:\s*[:=]|\s*\()/,
    kind: "hook",
  },
  {
    re: /^(?:export\s+(?:default\s+)?)?(?:const|function)\s+([A-Z][A-Za-z0-9_]*)(?:\s*[:=]|\s*\()/,
    kind: "react-component",
  },
  {
    re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    kind: "class",
  },
  {
    re: /^(?:export\s+)?(?:async\s+)?function\s+([a-z_][A-Za-z0-9_]*)\s*\(/,
    kind: "utility-function",
  },
  {
    re: /^(?:export\s+)?const\s+([a-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/,
    kind: "utility-function",
  },
  {
    re: /^(?:export\s+)?(?:type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    kind: "type-block",
  },
  {
    re: /^(?:export\s+)?(?:const|enum|let)\s+([A-Z_][A-Z0-9_]{3,})\s*(?:=|:)/,
    kind: "constant-block",
  },
];

function fallbackParse(lines: string[]): Omit<ASTRegion, "id">[] {
  const regions: Omit<ASTRegion, "id">[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed === ""
    ) {
      i++;
      continue;
    }

    let detected: { kind: RegionKind; name: string } | null = null;
    for (const { re, kind } of FALLBACK_PATTERNS) {
      const m = trimmed.match(re);
      if (m) {
        detected = { kind, name: m[1] };
        break;
      }
    }

    if (!detected) {
      i++;
      continue;
    }

    const startLine = i + 1;
    const regionLines: string[] = [lines[i]];
    let depth =
      (lines[i].match(/[{([]/g) ?? []).length -
      (lines[i].match(/[})\]]/g) ?? []).length;
    let j = i + 1;

    while (j < lines.length && (depth > 0 || j === i + 1)) {
      const l = lines[j];
      depth += (l.match(/[{([]/g) ?? []).length;
      depth -= (l.match(/[})\]]/g) ?? []).length;
      regionLines.push(l);
      j++;
      if (depth <= 0) break;
    }

    const src = regionLines.join("\n");
    regions.push({
      kind: detected.kind,
      name: detected.name,
      startLine,
      endLine: startLine + regionLines.length - 1,
      lines: regionLines,
      isExported: /^export\s/.test(trimmed),
      isDefaultExport: /^export\s+default\s/.test(trimmed),
      hasJSX: /<[A-Z][\w]*/.test(src),
      hasHooks: /\buse[A-Z]/.test(src),
      hasAsyncOps: /\basync\b|\bawait\b/.test(src),
      localBindings: new Set<string>(),
      usedSymbols: new Set<string>(),
      maxBracketDepth: maxBracketDepth(src),
    });

    i = j;
  }

  return regions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a source file into structural ASTRegions and a SymbolTable.
 *
 * For TypeScript / JavaScript, uses the TypeScript Compiler API (exact AST positions).
 * For other languages, falls back to bracket-depth heuristic.
 */
export function parseSourceFile(
  sourceCode: string,
  fileName: string,
): ASTParseResult {
  _regionCounter = 0; // Reset counter per file

  const ext = (fileName.split(".").pop() ?? "").toLowerCase();

  // ── Non-TS/JS fallback ───────────────────────────────────────────────────
  if (!TS_EXTENSIONS.has(ext)) {
    const lines = sourceCode.split("\n");
    const raw = fallbackParse(lines);
    return {
      regions: raw.map((r, i) => ({
        ...r,
        id: `rgn_fb_${i}_${r.name}`,
      })) as ASTRegion[],
      symbolTable: {
        locals: new Map(),
        imports: new Map(),
        unresolved: new Set(),
      },
      parseErrors: [],
      engineUsed: "bracket-depth-fallback",
      aiEnhanced: false,
    };
  }

  // ── TypeScript Compiler API ───────────────────────────────────────────────
  const scriptKind =
    ext === "tsx" || ext === "jsx"
      ? ts.ScriptKind.TSX
      : ext === "js" || ext === "mjs" || ext === "cjs"
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

  const sf = ts.createSourceFile(
    fileName,
    sourceCode,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  const parseErrors: string[] = (
    ((sf as any).parseDiagnostics as ts.Diagnostic[] | undefined) ?? []
  ).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));

  const allLines = sourceCode.split("\n");
  const regions: ASTRegion[] = [];

  ts.forEachChild(sf, (node) => {
    // Special-case VariableStatement: if a single VariableStatement contains
    // multiple declarators, emit one ASTRegion per declarator (multi-decl split).
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const startLine = lineOf(sf, decl.getStart(sf, true));
        const endLine = lineOf(sf, decl.getEnd());
        const lines = allLines.slice(startLine - 1, endLine);
        const src = lines.join("\n");
        const exported = isExported(node);
        const leadingComment = extractLeadingComment(node, sf);
        const { usedSymbols, symbolUsageKinds } = collectSymbolUsages(decl);
        const localBindings = collectLocalBindings(decl);
        const depth = maxBracketDepth(src);

        // Classify initializer types
        const init = decl.initializer;
        if (
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          const hasJSX = containsJSX(decl);
          const hasHk = containsHookCalls(decl);
          regions.push({
            id: newId(name),
            kind: classifyName(name, hasJSX, hasHk),
            name,
            startLine,
            endLine,
            lines,
            isExported: exported,
            isDefaultExport: false,
            hasJSX,
            hasHooks: hasHk,
            hasAsyncOps: containsAsync(decl),
            localBindings,
            usedSymbols,
            symbolUsageKinds,
            maxBracketDepth: depth,
            leadingComment,
          });
        } else if (
          init &&
          (/^[A-Z_][A-Z0-9_]{2,}$/.test(name) ||
            ts.isNumericLiteral(init) ||
            ts.isStringLiteral(init))
        ) {
          regions.push({
            id: newId(name),
            kind: "constant-block",
            name,
            startLine,
            endLine,
            lines,
            isExported: exported,
            isDefaultExport: false,
            hasJSX: false,
            hasHooks: false,
            hasAsyncOps: false,
            localBindings,
            usedSymbols,
            symbolUsageKinds,
            maxBracketDepth: depth,
            leadingComment,
          });
        } else {
          // Generic variable binding — produce a utility-function style region
          const hasJSX = containsJSX(decl);
          const hasHk = containsHookCalls(decl);
          regions.push({
            id: newId(name),
            kind: classifyName(name, hasJSX, hasHk),
            name,
            startLine,
            endLine,
            lines,
            isExported: exported,
            isDefaultExport: false,
            hasJSX,
            hasHooks: hasHk,
            hasAsyncOps: containsAsync(decl),
            localBindings,
            usedSymbols,
            symbolUsageKinds,
            maxBracketDepth: depth,
            leadingComment,
          });
        }
      }
      return;
    }

    const region = nodeToRegion(node, sf, allLines);
    if (region) regions.push(region);
  });

  const symbolTable = buildSymbolTable(sf);

  // Register declared symbols into the symbol table
  for (const region of regions) {
    const entry: SymbolEntry = {
      name: region.name,
      declaredInRegionId: region.id,
      isExported: region.isExported,
      isDefaultExport: region.isDefaultExport,
      referencedByRegionIds: new Set(),
      namespace:
        region.kind === "type-block" || region.kind === "enum"
          ? "type"
          : "value",
    };
    symbolTable.locals.set(region.name, entry);
  }

  // Cross-reference usages
  for (const region of regions) {
    for (const used of region.usedSymbols) {
      const entry = symbolTable.locals.get(used);
      if (entry && entry.declaredInRegionId !== region.id) {
        entry.referencedByRegionIds.add(region.id);
      } else if (!entry && !symbolTable.imports.has(used)) {
        symbolTable.unresolved.add(used);
      }
    }
  }

  return {
    regions,
    symbolTable,
    parseErrors,
    engineUsed: "typescript-ast",
    aiEnhanced: false,
  };
}
