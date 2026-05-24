import {
  generateFileContent,
  buildBarrelFile,
  buildTestFile,
} from '../src/splitter/generator/fileGenerator';
import type { EnrichedRegion, WorkspaceContext, ProposedFile } from '../src/splitter/types';

describe('S-grade features', () => {
  const ctx: WorkspaceContext = {
    existingTypeFiles: [],
    existingHookFiles: [],
    existingUtilFiles: [],
    existingIndexFiles: [],
    existingTestFiles: [],
    sourceDir: '.',
    testFramework: 'jest',
    packageManager: 'npm',
    isMonorepo: false,
  };

  test('generateFileContent adds use client directive for hook region when directives indicate', () => {
    const region = {
      id: 'r1',
      kind: 'hook',
      name: 'useFoo',
      startLine: 1,
      endLine: 3,
      lines: ['function useFoo() {', '  return null;', '}'],
      isExported: true,
      isDefaultExport: false,
      hasJSX: false,
      hasHooks: true,
      hasAsyncOps: false,
      localBindings: new Set(),
      usedSymbols: new Set(),
      maxBracketDepth: 0,
      metrics: { lineCount: 3, codeLines: 3, commentLines: 0, blankLines: 0, cyclomaticComplexity: 1, cognitiveComplexity: 1, nestingDepth: 0, maintainabilityIndex: 100, halsteadVolume: 0, halsteadEffort: 0, bundleWeight: 0, testabilityScore: 0 },
      smells: [],
      exportedSymbols: [],
      importedSymbols: [],
      externalPackages: [],
      inlineTypeNames: [],
      isDeadExport: false,
      extractionDecision: { shouldExtract: true, reasons: [], confidence: 'high', miDelta: 1, suggestedFileName: 'hooks/useFoo.ts', suggestedDir: 'hooks' },
    } as unknown as EnrichedRegion;

    const pf = generateFileContent(
      region,
      'hooks/useFoo.ts',
      { statements: [], exportStatements: [] } as any,
      'src/orig.ts',
      ctx,
      [],
      [],
      new Map(),
      { useClient: true, useServer: false },
    );

    expect(pf.generatedContent).toMatch("'use client';");
    expect(pf.barrelEntry).toContain('useFoo');
  });

  test('buildBarrelFile groups entries and skips routedToExisting', () => {
    const a: ProposedFile = {
      fileName: 'components/Foo.ts',
      sourceRegionId: 'r',
      regionName: 'Foo',
      estimatedLines: 10,
      resolvedImports: [],
      exportStatements: [],
      generatedContent: '',
      testFilePath: 'components/Foo.test.ts',
      barrelEntry: "export { Foo } from './components/Foo';",
      hasExistingTest: false,
      linkedTo: [],
      linkedFrom: [],
    } as ProposedFile;

    const b: ProposedFile = {
      fileName: 'hooks/useBar.ts',
      sourceRegionId: 'r2',
      regionName: 'useBar',
      estimatedLines: 5,
      resolvedImports: [],
      exportStatements: [],
      generatedContent: '',
      testFilePath: 'hooks/useBar.test.ts',
      barrelEntry: "export { useBar } from './hooks/useBar';",
      hasExistingTest: false,
      linkedTo: [],
      linkedFrom: [],
      routedToExisting: 'src/hooks/useBar.ts',
    } as unknown as ProposedFile;

    const out = buildBarrelFile([a, b]);
    expect(out).toMatch('// components/');
    expect(out).toMatch("export { Foo } from './components/Foo';");
    expect(out).not.toMatch("useBar");
  });

  test('buildTestFile includes render import for JSX components', () => {
    const region = {
      name: 'MyComp',
      isDefaultExport: false,
      hasJSX: true,
      kind: 'react-component',
    } as unknown as EnrichedRegion;

    const pf = { fileName: 'components/MyComp.tsx' } as any;
    const txt = buildTestFile(pf, region, 'jest');
    expect(txt).toMatch("@testing-library/react");
    expect(txt).toMatch("describe('MyComp'");
  });
});
