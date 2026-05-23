/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Import Resolver                                                  ║
 * ║                                                                              ║
 * ║  For each proposed extracted file, resolves the complete set of import      ║
 * ║  statements needed, accounting for:                                          ║
 * ║    ▸ External package imports (react, lodash, etc.)                         ║
 * ║    ▸ Cross-module imports (symbols from other proposed files)                ║
 * ║    ▸ Type-only imports (import type { ... })                                 ║
 * ║    ▸ Relative path calculation between proposed files                        ║
 * ║    ▸ Existing workspace file routing                                         ║
 * ║    ▸ Barrel (index) compatibility                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as path from "path";
import type {
  EnrichedRegion,
  SymbolTable,
  ImportRecord,
  WorkspaceContext,
  TsConfigInfo,
  TypeRouting,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Path utilities
// ─────────────────────────────────────────────────────────────────────────────

function relPath(from: string, to: string): string {
  // Both are relative paths like "hooks/useAuth.ts", "components/UserCard.tsx"
  const fromParts = from.split("/");
  const toParts = to.split("/");

  // Strip file name to get directory
  fromParts.pop();

  // Find common prefix
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const up = fromParts.length - common;
  const down = toParts.slice(common);

  const prefix = up === 0 ? "./" : "../".repeat(up);
  const rel = prefix + down.join("/");

  // Strip extension
  return rel.replace(/\.[jt]sx?$/, "");
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function stripExt(p: string): string {
  return p.replace(/\.[jt]sx?$/, "");
}

function resolveAliasPath(
  absolutePath: string,
  tsConfig?: TsConfigInfo,
): string | null {
  if (!tsConfig?.paths || !tsConfig.baseUrl) return null;

  const target = path.normalize(absolutePath);
  for (const [alias, patterns] of Object.entries(tsConfig.paths)) {
    for (const pattern of patterns) {
      const aliasHasStar = alias.includes("*");
      const aliasBase = alias.replace(/\*.*$/, "");
      const patternBase = pattern.replace(/\*.*$/, "");
      const baseAbs = path.resolve(tsConfig.baseUrl, patternBase);

      if (target !== baseAbs && !target.startsWith(baseAbs + path.sep))
        continue;

      let suffix = target.slice(baseAbs.length);
      if (suffix.startsWith(path.sep)) suffix = suffix.slice(1);
      const suffixPosix = suffix.replace(/\\/g, "/");

      const mapped = aliasHasStar
        ? alias.replace("*", suffixPosix)
        : aliasBase + (suffixPosix ? `/${suffixPosix}` : "");

      return stripExt(mapped);
    }
  }
  return null;
}

function resolveImportPath(
  fromRel: string,
  toRel: string,
  ctx: WorkspaceContext,
): string {
  const fromClean = normalizeRelPath(fromRel);
  const toClean = normalizeRelPath(toRel);
  const sourceDir =
    ctx.sourceDir && ctx.sourceDir.length > 0 ? ctx.sourceDir : ".";

  const toAbs = path.resolve(sourceDir, toClean);
  const aliasPath = resolveAliasPath(toAbs, ctx.tsConfig);
  if (aliasPath) return aliasPath;

  return relPath(fromClean, toClean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol → source package resolver
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the import record that brought this symbol into scope, or null */
function findImportSource(
  symbol: string,
  symbolTable: SymbolTable,
): ImportRecord | null {
  for (const [, rec] of symbolTable.imports) {
    if (rec.isDynamic) continue;
    if (rec.defaultAlias === symbol) return rec;
    if (rec.namespaceAlias === symbol) return rec;
    if (rec.named.some((n) => n.alias === symbol)) return rec;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build resolved import statements for a single region
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedImports {
  /** Final import statements to prepend to the extracted file */
  statements: string[];
  /** Export statements to append */
  exportStatements: string[];
  /** External package names used (node_modules) */
  externalPackages: string[];
}

export function resolveImports(
  region: EnrichedRegion,
  allRegions: EnrichedRegion[],
  symbolTable: SymbolTable,
  proposedFileMap: Map<string, string>, // regionId → proposed file name
  typeRouting: TypeRouting[],
  ctx: WorkspaceContext,
): ResolvedImports {
  const statements: string[] = [];
  const externalPackages: string[] = [];
  const seen = new Set<string>();

  const addImport = (stmt: string): void => {
    if (!seen.has(stmt)) {
      seen.add(stmt);
      statements.push(stmt);
    }
  };

  // React import (only if JSX used)
  if (region.hasJSX) {
    addImport("import React from 'react';");
  }

  // Side-effect imports adjacent to this region in the source file
  const sideEffectImports = [...symbolTable.imports.values()].filter(
    (rec) =>
      rec.isSideEffect &&
      !rec.isDynamic &&
      Math.abs(rec.line - region.startLine) <= 3,
  );
  for (const rec of sideEffectImports) {
    addImport(`import '${rec.specifier}';`);
    if (
      !rec.specifier.startsWith(".") &&
      !externalPackages.includes(rec.specifier)
    ) {
      externalPackages.push(rec.specifier);
    }
  }

  // Dynamic import statements adjacent to this region in the source file
  const dynamicImports = [...symbolTable.imports.values()].filter(
    (rec) =>
      rec.isDynamic &&
      rec.statementText &&
      rec.line < region.startLine &&
      Math.abs(rec.line - region.startLine) <= 3,
  );
  for (const rec of dynamicImports) {
    addImport(
      rec.statementText!.trim().endsWith(";")
        ? rec.statementText!.trim()
        : `${rec.statementText!.trim()};`,
    );
    if (
      !rec.specifier.startsWith(".") &&
      !externalPackages.includes(rec.specifier)
    ) {
      externalPackages.push(rec.specifier);
    }
  }

  // Collect all symbols used by this region, minus locals
  const neededSymbols = new Set<string>();
  for (const sym of region.usedSymbols) {
    if (!region.localBindings.has(sym)) {
      neededSymbols.add(sym);
    }
  }

  // Group needed symbols by their source
  const fromExternal = new Map<
    string,
    { named: string[]; default?: string; ns?: string }
  >();
  const fromRegions = new Map<string, string[]>(); // other region id → symbols
  const fromTypeRoute = new Map<string, string[]>(); // type file → type names

  for (const sym of neededSymbols) {
    // 1. Is it declared in another region?
    const declRegion = allRegions.find(
      (r) => r.id !== region.id && r.name === sym,
    );
    if (declRegion) {
      const targetFile = proposedFileMap.get(declRegion.id);
      if (targetFile) {
        const bucket = fromRegions.get(declRegion.id) ?? [];
        bucket.push(sym);
        fromRegions.set(declRegion.id, bucket);
      }
      continue;
    }

    // 2. Is it a type that's been routed?
    const isRoutedType =
      region.inlineTypeNames.includes(sym) ||
      symbolTable.locals.get(sym)?.namespace === "type";
    if (isRoutedType && typeRouting.length > 0) {
      const tgt = typeRouting[0].targetFile;
      const bucket = fromTypeRoute.get(tgt) ?? [];
      bucket.push(sym);
      fromTypeRoute.set(tgt, bucket);
      continue;
    }

    // 3. Is it an import from an external package?
    const importSrc = findImportSource(sym, symbolTable);
    if (importSrc) {
      const bucket = fromExternal.get(importSrc.specifier) ?? { named: [] };
      if (importSrc.defaultAlias === sym) {
        bucket.default = sym;
      } else if (importSrc.namespaceAlias === sym) {
        bucket.ns = sym;
      } else {
        // Find original name
        const namedEntry = importSrc.named.find((n) => n.alias === sym);
        if (namedEntry) {
          const entry =
            namedEntry.name === namedEntry.alias
              ? namedEntry.name
              : `${namedEntry.name} as ${namedEntry.alias}`;
          bucket.named.push(entry);
        }
      }
      fromExternal.set(importSrc.specifier, bucket);
      if (!importSrc.specifier.startsWith(".")) {
        externalPackages.push(importSrc.specifier);
      }
      continue;
    }
  }

  // ── Emit: external imports ────────────────────────────────────────────────
  for (const [specifier, parts] of fromExternal) {
    const segments: string[] = [];
    if (parts.default) segments.push(parts.default);
    if (parts.ns) segments.push(`* as ${parts.ns}`);
    if (parts.named.length > 0) segments.push(`{ ${parts.named.join(", ")} }`);
    if (segments.length > 0) {
      addImport(`import ${segments.join(", ")} from '${specifier}';`);
    }
  }

  // ── Emit: cross-module imports (from other proposed files) ────────────────
  for (const [declRegionId, syms] of fromRegions) {
    const targetFile = proposedFileMap.get(declRegionId)!;
    const declRegion = allRegions.find((r) => r.id === declRegionId)!;
    const rel = resolveImportPath(
      proposedFileMap.get(region.id) ?? "",
      targetFile,
      ctx,
    );
    const isTypeOnly =
      symbolTable.locals.get(declRegion.name)?.namespace === "type";
    const typePrefix = isTypeOnly ? "type " : "";
    const importClause = declRegion.isDefaultExport
      ? syms[0]
      : `{ ${syms.join(", ")} }`;
    addImport(`import ${typePrefix}${importClause} from '${rel}';`);
  }

  // ── Emit: type-routed imports ─────────────────────────────────────────────
  for (const [targetFile, typeNames] of fromTypeRoute) {
    const rel = resolveImportPath(
      proposedFileMap.get(region.id) ?? "",
      targetFile.replace("./", ""),
      ctx,
    );
    addImport(`import type { ${typeNames.join(", ")} } from '${rel}';`);
  }

  // ── Emit: export statements ───────────────────────────────────────────────
  const exportStatements: string[] = [];
  if (region.isDefaultExport) {
    exportStatements.push(`export default ${region.name};`);
  } else if (region.isExported) {
    // The region body already has `export` prefix — nothing extra to add
  } else {
    // Not exported in original — add export for extraction
    exportStatements.push(`export { ${region.name} };`);
  }

  return { statements, exportStatements, externalPackages };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type routing resolver
// ─────────────────────────────────────────────────────────────────────────────

const PREFERRED_TYPE_FILES = [
  "types.ts",
  "types.tsx",
  "interfaces.ts",
  "global.d.ts",
  "index.d.ts",
  "types/index.ts",
];

export function resolveTypeRouting(
  typeRegions: EnrichedRegion[],
  ctx: WorkspaceContext,
): TypeRouting[] {
  if (typeRegions.length === 0) return [];

  const sameDir = ctx.existingTypeFiles.filter(
    (f) =>
      f.startsWith(ctx.sourceDir) &&
      PREFERRED_TYPE_FILES.some((n) => f.endsWith(n)),
  );
  const projTypes = ctx.existingTypeFiles.filter((f) =>
    PREFERRED_TYPE_FILES.some((n) => f.endsWith(n)),
  );

  const target = sameDir[0] ?? projTypes[0] ?? ctx.existingTypeFiles[0] ?? null;
  const rel = target
    ? target.replace(ctx.sourceDir, "./").replace(/\\/g, "/")
    : "./types.ts";
  const isNew = !target;

  const reason = target
    ? `Routing to existing ${rel}`
    : "No existing types file — create src/types.ts to centralise type definitions";

  return [
    {
      typeNames: typeRegions.map((r) => r.name),
      targetFile: rel,
      reason,
      isNewFile: isNew,
    },
  ];
}
