/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — File Content Generator                                          ║
 * ║                                                                              ║
 * ║  Generates complete, ready-to-write file content for each proposed file.    ║
 * ║  Handles:                                                                    ║
 * ║    ▸ File header (auto-generated notice, original source attribution)       ║
 * ║    ▸ Import section (resolved, deduplicated, type-only imports first)       ║
 * ║    ▸ Type/interface extraction for component props                          ║
 * ║    ▸ Region body (with export prefix adjusted as needed)                    ║
 * ║    ▸ Barrel export entries for index.ts                                     ║
 * ║    ▸ Test file scaffolding (Jest/Vitest, @testing-library)                  ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as path from "path";
import type {
  EnrichedRegion,
  ProposedFile,
  WorkspaceContext,
  TypeRouting,
  TsConfigInfo,
} from "../types";
import type { ResolvedImports } from "../resolver/importResolver";

export interface FileDirectives {
  useClient: boolean;
  useServer: boolean;
  directiveText?: string;
  directiveLine?: number;
  isNextAppRouter?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// File header
// ─────────────────────────────────────────────────────────────────────────────

function buildFileHeader(region: EnrichedRegion, sourceFile: string): string {
  const lines = [
    "/**",
    ` * @generated ASTra v3 — Module Splitter`,
    ` * @source    ${sourceFile}`,
    ` * @region    ${region.name} (${region.kind})`,
    ` * @lines     ${region.startLine}–${region.endLine}`,
  ];
  if (region.leadingComment) {
    lines.push(` * @note      ${region.leadingComment.slice(0, 120)}`);
  }
  lines.push(" */");
  return lines.join("\n");
}

function buildRegionDoc(region: EnrichedRegion): string | undefined {
  const raw = region.leadingComment?.trim();
  if (!raw) return undefined;
  const lines = raw.split("\n").map((line) => ` * ${line.trim()}`);
  return ["/**", ...lines, " */"].join("\n");
}

function shouldAddUseClient(
  directives: FileDirectives | undefined,
  region: EnrichedRegion,
): boolean {
  if (!directives?.useClient) return false;
  if (region.hasHooks || region.hasJSX) return true;
  return ["react-component", "hook", "context-provider", "hoc"].includes(
    region.kind,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prop interface generator
// ─────────────────────────────────────────────────────────────────────────────

function buildPropInterface(region: EnrichedRegion): string | undefined {
  if (
    !["react-component", "context-provider", "hoc"].includes(region.kind) ||
    region.importedSymbols.length === 0
  )
    return undefined;

  const props = region.importedSymbols
    .slice(0, 10)
    .map((dep) => `  ${dep}: unknown; // TODO: add proper type`)
    .join("\n");

  return `export interface ${region.name}Props {\n${props}\n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Region body (with export prefix adjustment)
// ─────────────────────────────────────────────────────────────────────────────

function adjustRegionBody(region: EnrichedRegion): string {
  const lines = [...region.lines];

  // Ensure the declaration line has `export` prefix
  if (!lines[0].trimStart().startsWith("export")) {
    lines[0] = "export " + lines[0].trimStart();
  }

  return lines.join("\n");
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

      if (target !== baseAbs && !target.startsWith(baseAbs + path.sep)) {
        continue;
      }

      let suffix = target.slice(baseAbs.length);
      if (suffix.startsWith(path.sep)) suffix = suffix.slice(1);
      const suffixPosix = suffix.replace(/\\/g, "/");

      const mapped = aliasHasStar
        ? alias.replace("*", suffixPosix)
        : aliasBase + (suffixPosix ? `/${suffixPosix}` : "");

      return mapped.replace(/\.[jt]sx?$/, "");
    }
  }

  return null;
}

function resolveImportFromSource(
  sourceFilePath: string,
  targetRel: string,
  ctx: WorkspaceContext,
): string {
  const sourceDir =
    ctx.sourceDir && ctx.sourceDir.length > 0
      ? ctx.sourceDir
      : path.dirname(sourceFilePath);
  const targetAbs = path.resolve(sourceDir, targetRel);
  const alias = resolveAliasPath(targetAbs, ctx.tsConfig);
  if (alias) return alias;

  const fromDir = path.dirname(sourceFilePath);
  let rel = path.relative(fromDir, targetAbs).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel.replace(/\.[jt]sx?$/, "");
}

function buildReImports(
  proposedFiles: ProposedFile[],
  ctx: WorkspaceContext,
  sourceFile: string,
  sourceFilePath?: string,
): string[] {
  const srcPath = sourceFilePath || path.join(ctx.sourceDir || ".", sourceFile);
  return proposedFiles
    .filter((pf) => !pf.routedToExisting)
    .map((pf) => {
      const rel = resolveImportFromSource(srcPath, pf.fileName, ctx);
      return `import { ${pf.regionName} } from '${rel}';`;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test file generator
// ─────────────────────────────────────────────────────────────────────────────

export function buildTestFile(
  pf: ProposedFile,
  region: EnrichedRegion,
  framework: "jest" | "vitest",
): string {
  const importLine = region.isDefaultExport
    ? `import ${region.name} from './${region.name}';`
    : `import { ${region.name} } from './${region.name}';`;

  const setupLine =
    framework === "vitest"
      ? "import { describe, it, expect, vi } from 'vitest';"
      : "";

  const renderLine = region.hasJSX
    ? "import { render, screen } from '@testing-library/react';"
    : "";
  const hookLine =
    region.kind === "hook"
      ? "import { renderHook, act } from '@testing-library/react';"
      : "";

  const tests = (
    (pf as ProposedFile & { testFileSuggestions?: string[] })
      .testFileSuggestions ?? []
  )
    .map(
      (t: string) =>
        `  it('${t}', () => {\n    // TODO: implement test\n    expect(true).toBe(true);\n  });`,
    )
    .concat(
      ((pf as ProposedFile & { testFileSuggestions?: string[] })
        .testFileSuggestions?.length ?? 0) === 0
        ? [
            `  it('works correctly', () => {\n    expect(${region.name}).toBeDefined();\n  });`,
          ]
        : [],
    );

  const describe = `describe('${region.name}', () => {\n${tests.join("\n\n")}\n});`;

  const imports = [setupLine, renderLine, hookLine, importLine]
    .filter(Boolean)
    .join("\n");

  return `${imports}\n\n${describe}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Barrel export entry
// ─────────────────────────────────────────────────────────────────────────────

function buildBarrelEntry(pf: ProposedFile, region: EnrichedRegion): string {
  const path = "./" + pf.fileName.replace(/\.[jt]sx?$/, "");
  if (region.isDefaultExport) {
    return `export { default as ${region.name} } from '${path}';`;
  }
  return `export { ${region.name} } from '${path}';`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test file path
// ─────────────────────────────────────────────────────────────────────────────

function buildTestFilePath(fileName: string, ctx: WorkspaceContext): string {
  const withoutExt = fileName.replace(/\.[jt]sx?$/, "");
  const ext = fileName.match(/\.[jt]sx?$/)?.[0] ?? ".ts";
  const testExt = ext.includes("x") ? ".test.tsx" : ".test.ts";
  return withoutExt + testExt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main generator
// ─────────────────────────────────────────────────────────────────────────────

export function generateFileContent(
  region: EnrichedRegion,
  fileName: string,
  resolved: ResolvedImports,
  sourceFile: string,
  ctx: WorkspaceContext,
  typeRouting: TypeRouting[],
  allRegions: EnrichedRegion[],
  proposedFileMap: Map<string, string>,
  fileDirectives?: FileDirectives,
): ProposedFile {
  const header = buildFileHeader(region, sourceFile);
  const regionDoc = buildRegionDoc(region);
  const fileDirective = shouldAddUseClient(fileDirectives, region)
    ? "'use client';"
    : undefined;
  const propInterface = buildPropInterface(region);
  const body = adjustRegionBody(region);
  const testFilePath = buildTestFilePath(fileName, ctx);

  // Build test suggestions
  const testSuggestions: string[] = [];
  if (region.kind === "react-component" || region.kind === "context-provider") {
    testSuggestions.push("renders without crashing");
    testSuggestions.push("matches snapshot");
    if (region.importedSymbols.length > 0) {
      testSuggestions.push(`accepts ${region.importedSymbols[0]} prop`);
    }
  } else if (region.kind === "hook") {
    testSuggestions.push("initialises with correct default state");
    testSuggestions.push("updates state on action");
    if (region.hasAsyncOps)
      testSuggestions.push("handles loading and error states");
  } else if (region.kind === "utility-function") {
    testSuggestions.push("returns correct output for valid input");
    testSuggestions.push("handles null/undefined/empty inputs");
    if (region.hasAsyncOps) testSuggestions.push("resolves promise correctly");
  } else if (region.kind === "class") {
    testSuggestions.push("instantiates successfully");
    testSuggestions.push("public methods return expected values");
  }
  if (region.smells.length > 0) {
    testSuggestions.push(
      `no regression: ${region.smells[0].name.toLowerCase()}`,
    );
  }

  // Sort imports: type-only first, then external, then local
  const typeImports = resolved.statements.filter((s) =>
    s.includes("import type"),
  );
  const reactImports = resolved.statements.filter((s) =>
    s.includes("from 'react'"),
  );
  const extImports = resolved.statements.filter(
    (s) =>
      !s.includes("import type") &&
      !s.includes("from 'react'") &&
      !s.includes("from '."),
  );
  const relImports = resolved.statements.filter(
    (s) => !s.includes("import type") && s.includes("from '."),
  );

  const importBlock = [
    ...reactImports,
    ...extImports,
    ...relImports,
    ...typeImports,
  ].join("\n");

  // Assemble content
  const parts: string[] = [header];
  if (fileDirective) parts.push("", fileDirective);
  if (importBlock.trim()) parts.push("", importBlock);
  if (regionDoc) parts.push("", regionDoc);
  else if (fileDirective || importBlock.trim()) parts.push("");

  if (propInterface) {
    parts.push(propInterface, "");
  }

  parts.push(body, "");

  if (
    resolved.exportStatements.length > 0 &&
    !body.trimStart().startsWith("export")
  ) {
    parts.push(...resolved.exportStatements, "");
  }

  const generatedContent = parts
    .filter((p, i) => {
      // Collapse multiple consecutive blank lines
      return !(p === "" && parts[i - 1] === "");
    })
    .join("\n");

  const barrelEntry = buildBarrelEntry({ fileName } as ProposedFile, region);

  return {
    fileName,
    sourceRegionId: region.id,
    regionName: region.name,
    estimatedLines: region.metrics.lineCount,
    resolvedImports: resolved.statements,
    exportStatements: resolved.exportStatements,
    generatedContent,
    propInterface,
    linkedTo: [],
    linkedFrom: [],
    testFilePath,
    barrelEntry,
    hasExistingTest: false,
    testFileSuggestions: testSuggestions,
  } as ProposedFile & { testFileSuggestions: string[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Barrel index.ts generator
// ─────────────────────────────────────────────────────────────────────────────

export function buildBarrelFile(proposed: ProposedFile[]): string {
  const lines = [
    "/**",
    " * @generated ASTra v3 — Barrel Export",
    " * Place this file as `index.ts` in the extracted files directory.",
    " * Update the path as needed for your project structure.",
    " */",
    "",
  ];

  // Group by directory
  const groups = new Map<string, string[]>();
  for (const pf of proposed) {
    if (pf.routedToExisting) continue;
    const dir = pf.fileName.split("/")[0] ?? "";
    const bucket = groups.get(dir) ?? [];
    bucket.push(pf.barrelEntry);
    groups.set(dir, bucket);
  }

  for (const [dir, entries] of groups) {
    lines.push(`// ${dir}/`);
    lines.push(...entries);
    lines.push("");
  }

  return lines.join("\n");
}

export interface BarrelMergeResult {
  mergedContent: string;
  addedExports: string[];
}

export function mergeBarrelContent(
  existingContent: string,
  barrelExport: string,
): BarrelMergeResult {
  const existingLines = existingContent.split("\n");
  const existingExports = new Set(
    existingLines
      .map((line) => line.trim())
      .filter((line) => line.startsWith("export ")),
  );
  const existingGroups = new Set(
    existingLines
      .map((line) => line.trim())
      .filter((line) => line.startsWith("// ")),
  );

  const addedExports: string[] = [];
  const additions: string[] = [];
  const exportLines = barrelExport.split("\n");
  let currentGroup: string | undefined;

  for (const raw of exportLines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("// ")) {
      currentGroup = line;
      continue;
    }
    if (!line.startsWith("export ")) continue;

    if (!existingExports.has(line)) {
      if (currentGroup && !existingGroups.has(currentGroup)) {
        additions.push(currentGroup);
        existingGroups.add(currentGroup);
      }
      additions.push(line);
      addedExports.push(line);
    }
  }

  if (additions.length === 0) {
    return { mergedContent: existingContent, addedExports };
  }

  const spacer = existingContent.endsWith("\n") ? "" : "\n";
  const mergedContent = existingContent + spacer + additions.join("\n") + "\n";
  return { mergedContent, addedExports };
}

// ─────────────────────────────────────────────────────────────────────────────
// Updated source file generator (removes extracted regions, fixes imports)
// ─────────────────────────────────────────────────────────────────────────────

export function generateUpdatedSource(
  originalLines: string[],
  extractedRegions: EnrichedRegion[],
  proposedFiles: ProposedFile[],
  sourceFile: string,
  ctx: WorkspaceContext,
  sourceFilePath?: string,
  fileDirectives?: FileDirectives,
): string {
  const extractedLineRanges = new Set<number>();
  for (const r of extractedRegions) {
    for (let ln = r.startLine; ln <= r.endLine; ln++) {
      extractedLineRanges.add(ln);
    }
  }

  const retained = originalLines.filter(
    (_, idx) => !extractedLineRanges.has(idx + 1),
  );

  const reImports = buildReImports(
    proposedFiles,
    ctx,
    sourceFile,
    sourceFilePath,
  );
  const ext = (sourceFile.split(".").pop() ?? "").toLowerCase();

  if (ext === "svelte") {
    return buildSvelteUpdatedSource(retained, reImports);
  }

  const header = [
    `/**`,
    ` * @modified-by ASTra v3 Module Splitter`,
    ` * @source      ${sourceFile}`,
    ` * @note        The following regions have been extracted into separate files.`,
    ` *              Update this file's imports accordingly.`,
    ` */`,
  ];

  const directiveText = fileDirectives?.directiveText;
  const cleaned = directiveText
    ? retained.filter((line) => line.trim() !== directiveText.trim())
    : retained;

  const parts: string[] = [];
  if (directiveText) parts.push(directiveText);
  parts.push(...header, "", ...reImports, "", ...cleaned);

  return parts.join("\n");
}

function buildSvelteUpdatedSource(
  retainedLines: string[],
  reImports: string[],
): string {
  const lines = [...retainedLines];
  let scriptStart = -1;
  let scriptEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (scriptStart === -1 && /<script\b/i.test(line)) {
      scriptStart = i;
      continue;
    }
    if (scriptStart !== -1 && /<\/script>/i.test(line)) {
      scriptEnd = i;
      break;
    }
  }

  if (scriptStart === -1 || scriptEnd === -1) {
    const block = ["<script>", ...reImports, "</script>", ""];
    return [...block, ...lines].join("\n");
  }

  const scriptLines = lines.slice(scriptStart + 1, scriptEnd);
  const existing = new Set(scriptLines.map((l) => l.trim()));
  const uniqueImports = reImports.filter((l) => !existing.has(l.trim()));
  if (uniqueImports.length === 0) return lines.join("\n");

  const updated = [
    ...lines.slice(0, scriptStart + 1),
    ...uniqueImports,
    "",
    ...lines.slice(scriptStart + 1),
  ];
  return updated.join("\n");
}
