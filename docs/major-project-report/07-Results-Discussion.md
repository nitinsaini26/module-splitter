# Result and Discussion

This section presents the main results of the project and discusses their meaning, strengths, and limitations.

## 1. Results

### 1.1 Functional outcomes

The ASTra v3 Module Splitter delivers the following functional results:

- It detects logical regions such as components, hooks, utilities, classes, and types.
- It computes metrics for each region and for the overall file.
- It detects a wide set of code smells and presents them with severity and recommendations.
- It builds a dependency graph and identifies cycles and extraction order.
- It decides which regions should be extracted using a multi factor score.
- It generates new files, updates the original file, and creates a barrel index.
- It generates test stubs aligned to the region kind.
- It provides a webview panel that presents all results in an understandable way.

### 1.2 Example style results

A common example is a large dashboard file that contains a component, a hook, a utility, and some types. The expected outcome after analysis is:

- The component and the hook are recommended for extraction.
- The utility is retained if it is small and pure.
- The types are routed to a types file instead of a new file.
- The updated source file becomes shorter and more focused.

These results match the intended behavior described in the design and documentation.

### 1.3 Visual output

The webview panel presents the analysis results in eight tabs. This provides a clear visual understanding of the refactor before any change is applied.

<!-- Screenshot: Webview Overview with metrics and cache card -->
<!-- Screenshot: Webview Linkage tab showing file relationships -->

### 1.4 Generated files

When a split plan is applied, new files are created with complete imports and preserved code. The tool also creates an index file for easy exports. This is a tangible result that developers can use immediately.

<!-- Screenshot: Generated files in the file explorer -->

### 1.5 Test outputs

The project includes a Jest based test suite that validates the analysis pipeline. Running the tests produces a clear pass or fail report, which can be included as evidence of correctness.

<!-- Screenshot: Jest test run output showing passing tests -->

## 2. Discussion

### 2.1 Impact on maintainability

The primary impact is on maintainability. Large files are split into smaller files that each represent a single responsibility. This improves readability and makes testing easier. The maintainability index and cognitive complexity metrics provide numerical support for this improvement.

### 2.2 Decision transparency

The Extraction Oracle provides a confidence level and a score for each extraction candidate. This makes the tool trustworthy because the user can understand why a suggestion is made. The system avoids black box decisions and makes refactoring a guided process.

### 2.3 Safety of changes

The atomic apply using WorkspaceEdit is important for safety. Without this, a partial refactor could leave the project in a broken state. The single undo action gives the user confidence to try the split without fear of permanent damage.

### 2.4 Performance and usability

The incremental cache reduces repeated work and makes the tool responsive. This is important because developers often iterate on a file and run analysis multiple times. The status bar grade and inline diagnostics provide lightweight feedback without forcing the user to open the full panel every time.

### 2.5 Limitations

The tool still has practical limitations:

- It does not run tsc --noEmit automatically after apply, so the user must validate compilation manually.
- Type only import resolution is heuristic, not full semantic type checking.
- Framework plugin line numbers are approximate.
- Non TypeScript languages use a fallback parser and should be treated as suggestions.

These limitations are acceptable in the current scope, but they are important for future work.

### 2.6 Overall discussion

ASTra v3 demonstrates that static analysis and metrics can be integrated into daily developer work without becoming heavy or academic. The tool is useful for students and professional teams. It improves code structure, reduces maintenance cost, and encourages best practices in modular design.
