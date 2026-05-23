# Observation

This section records what is observed while using the ASTra v3 Module Splitter in practice. The observations are based on the project design, documentation, and expected workflow in VS Code.

## 1. Observations during analysis

1. When the analyze command is executed, the extension shows a progress notification. This is helpful because large files may take a moment to analyze.
2. The tool identifies distinct regions such as components, hooks, utilities, types, and constants. This matches how developers think about code structure.
3. The dependency graph identifies which regions depend on others. This is important because it explains why certain regions should remain together.
4. The metrics view gives a quick sense of complexity and maintainability. Regions with high complexity and low maintainability are clearly visible.
5. The smell list provides a focused set of refactoring reasons. It avoids generic or vague suggestions.

<!-- Screenshot: Webview Overview tab with metrics and health grade -->

## 2. Observations on the user interface

1. The eight tab webview organizes information in a clear flow from overview to dry run.
2. The Regions tab helps users understand why a region is classified as a component, hook, or utility.
3. The Extract tab provides confidence labels and suggested file names, which lowers decision effort.
4. The Files tab gives a preview of generated files, which reduces fear of unexpected changes.

<!-- Screenshot: Webview Regions tab showing region cards -->
<!-- Screenshot: Webview Extract tab showing candidates and confidence -->
<!-- Screenshot: Webview Files tab with generated content preview -->

## 3. Observations in the editor

1. Inline diagnostics are useful because they bring smells directly into the editor view.
2. The status bar grade is a quick signal of file health without opening the full panel.
3. The diagnostics use severity levels, which helps distinguish between critical and low level issues.

<!-- Screenshot: Inline smell squiggles in editor -->
<!-- Screenshot: Status bar health grade -->

## 4. Observations on performance

1. The incremental cache reduces repeated analysis time for unchanged regions. This makes the tool usable in real projects where analysis may be run multiple times on the same file.
2. When only a small change is made, only the affected region is re analyzed, and the rest of the analysis uses cached data.
3. The dependency graph is rebuilt when the file hash changes, which ensures correctness even when the file structure changes.

## 5. Observations on extraction safety

1. The apply step is atomic, so all file creation and updates are done together.
2. The Undo All action is available immediately after apply, which reduces the risk of accidental refactor.
3. The generated file content preserves the original region body, so the behavior of code does not change.

## 6. Observations on testing

1. The test suite is based on Jest and covers pipeline, metrics, smells, and framework plugins.
2. Test stubs are generated for new files, which encourages writing proper tests after refactoring.

<!-- Screenshot: Jest test run output -->

## 7. Observations on limitations

1. The system does not run a TypeScript compiler check after apply. The documentation recommends running tsc --noEmit manually.
2. Full semantic type resolution is not used. In rare cases, a type only symbol may appear as a value import.
3. Framework plugin line numbers are approximate because they are based on regex scans rather than a full AST for those files.

## Summary

Overall, the tool provides a clear and practical workflow for splitting large modules. The UI is structured, the analysis is explainable, and the apply step is safe. The limitations are clearly documented, which helps users make informed decisions.
