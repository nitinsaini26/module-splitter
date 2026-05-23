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

import type {
  EnrichedRegion,
  ProposedFile,
  WorkspaceContext,
  TypeRouting,
} from "../types";
import type { ResolvedImports } from "../resolver/importResolver";

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
): ProposedFile {
  const header = buildFileHeader(region, sourceFile);
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
  const parts = [header, "", importBlock, ""];

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

// ─────────────────────────────────────────────────────────────────────────────
// Updated source file generator (removes extracted regions, fixes imports)
// ─────────────────────────────────────────────────────────────────────────────

export function generateUpdatedSource(
  originalLines: string[],
  extractedRegions: EnrichedRegion[],
  proposedFiles: ProposedFile[],
  sourceFile: string,
): string {
  const extractedLineRanges = new Set<number>();
  for (const r of extractedRegions) {
    for (let ln = r.startLine; ln <= r.endLine; ln++) {
      extractedLineRanges.add(ln);
    }
  }

  const header = [
    `/**`,
    ` * @modified-by ASTra v3 Module Splitter`,
    ` * @source      ${sourceFile}`,
    ` * @note        The following regions have been extracted into separate files.`,
    ` *              Update this file's imports accordingly.`,
    ` */`,
    "",
  ];

  // Add re-import lines for extracted symbols
  const reImports = proposedFiles
    .filter((pf) => !pf.routedToExisting)
    .map((pf) => {
      const path = "./" + pf.fileName.replace(/\.[jt]sx?$/, "");
      return `import { ${pf.regionName} } from '${path}';`;
    });

  const retained = originalLines.filter(
    (_, idx) => !extractedLineRanges.has(idx + 1),
  );

  return [...header, ...reImports, "", ...retained].join("\n");
}
