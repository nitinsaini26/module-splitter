# Literature Review

This section explains the background ideas that support the project, the tools and technologies used, the installation process, the main libraries, and the algorithms used. The focus is on practical, easy language while still being detailed.

## 1. Background and related concepts

### 1.1 Modularization and refactoring

Software modularization is the practice of splitting a large unit of code into smaller, clearer units. In a TypeScript or React project, a module can contain components, hooks, utilities, and types. When these are all placed in a single file, the file becomes a "god module" and is difficult to maintain. Refactoring is the process of changing the internal structure of code without changing its external behavior. A good refactor improves readability, reusability, and testability.

Traditional refactoring tools are often manual. The developer must identify what should be moved, create a new file, update imports, and check that nothing breaks. This is tedious and risky. A better approach is to use static analysis and code metrics to guide the decision.

### 1.2 Static analysis

Static analysis means analyzing code without executing it. It looks at syntax, structure, and symbols in the code. The TypeScript Compiler API provides a standard and reliable way to parse a TypeScript file into an Abstract Syntax Tree (AST). The AST gives the exact structure of the code, which is much more accurate than text based parsing.

AST based tools can reliably identify top level declarations, detect which identifiers are used in which region, and differentiate between values, types, and imports. ASTra v3 uses this method as its foundation.

### 1.3 Code metrics and smells

Code metrics provide a numerical view of complexity and maintainability. Some metrics have a long academic history and are widely used in industry. For example, cyclomatic complexity counts independent paths in a function. Halstead metrics estimate effort based on operators and operands. The maintainability index combines several signals into a single score.

Code smells are patterns that suggest a design problem. A code smell does not guarantee a bug, but it indicates that a refactor may improve the code. For example, a very large function is a smell, as is a React component that mixes data fetching and rendering logic in the same block. ASTra v3 uses a set of smell rules to highlight these problems and to strengthen extraction decisions.

### 1.4 Refactoring assistance in IDEs

Modern IDEs provide basic refactoring such as rename, extract method, and move file. However, they do not typically analyze a file and suggest a full split plan. ASTra v3 closes this gap by combining metrics, smells, and dependency analysis into a clear, reviewable plan inside VS Code.

## 2. Tools and technologies used

ASTra v3 is built as a VS Code extension with a TypeScript codebase. The main tools and technologies are listed below.

### 2.1 Visual Studio Code Extension API

The project is delivered as a VS Code extension. It integrates with VS Code through commands, menus, keybindings, status bar items, diagnostics, and webviews. Important features include:

- Command palette entries for analyzing and applying split plans.
- A webview panel that shows the eight stage analysis results in tabs.
- Diagnostic squiggles that highlight code smells in the editor.
- A status bar grade that summarizes file health.
- WorkspaceEdit based apply that ensures atomic refactoring.

### 2.2 TypeScript and the TypeScript Compiler API

The extension uses TypeScript 5.x for development. More importantly, it uses the TypeScript Compiler API to parse source files into AST nodes. This provides:

- Accurate identification of declarations and imports.
- Symbol extraction for dependency analysis.
- Support for TSX and JSX when analyzing React files.

### 2.3 Node.js and npm

Node.js is the runtime for the extension and for development tooling. npm is used to manage dependencies and run scripts for compile, test, and lint.

### 2.4 Jest and ts-jest

Jest is used as the test framework, and ts-jest allows TypeScript tests to run without separate compilation. The repository includes a large test suite for the pipeline, features, and framework plugins.

### 2.5 ESLint and TypeScript ESLint

ESLint is used to lint the TypeScript source to maintain consistent code style and catch problems early.

### 2.6 d3-force

The project includes a dependency mini graph in the webview. This graph uses d3-force to compute a force directed layout, which gives a clean visual representation of file or region relationships.

### 2.7 VSCE packaging

The extension is packaged using the VS Code Extension Manager (vsce). This allows local installation as a VSIX file and supports publishing if needed.

## 3. Installation and setup

The installation steps are straightforward and are based on the existing project documentation.

### 3.1 Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher
- VS Code 1.85 or higher
- TypeScript 5.x

### 3.2 Install dependencies

From the repository root:

1. Run npm install to install dependencies.
2. Run npm run compile to build TypeScript into the out directory.
3. Run npm test to execute the Jest suite.

### 3.3 Development and debugging

- Open the project in VS Code.
- Press F5 to launch an Extension Development Host.
- In the new window, open a TypeScript or JavaScript file and run the analysis command.

### 3.4 Packaging

To build a VSIX for local installation, run npm run package. The package can then be installed using the VS Code command line tool.

## 4. Libraries based

The project depends on a small set of runtime libraries and a wider set of development tools.

### 4.1 Runtime dependency

- typescript: used both as a compiler API for parsing and as a language service for AST traversal.

### 4.2 Development dependencies

- @types/vscode: TypeScript typings for the VS Code API.
- @types/node: Node.js typings.
- jest: unit testing framework.
- ts-jest: TypeScript support for Jest.
- eslint: linter for TypeScript source.
- @typescript-eslint/eslint-plugin and parser: TypeScript specific lint rules.
- @types/d3-force: typings for d3-force used in the webview.
- @vscode/vsce: packaging tool for VS Code extensions.
- rimraf: clean script for build output.

These libraries are standard and provide a stable, maintainable development environment.

## 5. Algorithms used (detailed)

ASTra v3 uses a pipeline of algorithms, each one focused on a specific decision. The design is deterministic and explainable. The system is not a black box; it tells the user why a region is extracted and what signals triggered the decision.

### 5.1 Stage 1 - Parsing and region detection

The parsing stage is built on the TypeScript Compiler API. The file is parsed into an AST. ASTra scans top level statements and converts each declaration into an AST region. A region is a unit such as a React component, a hook, a utility function, a class, a type block, or a constant block.

Region classification uses three main signals:

- Name based rules, such as "useX" for hooks and "Provider" for context providers.
- Structure based rules, such as JSX presence for components.
- AST node type based rules for class, enum, interface, or type alias.

The output of this stage is a list of regions, each with line range, kind, used symbols, local bindings, and flags such as hasJSX or hasAsyncOps.

### 5.2 Stage 2 - Dependency graph analysis

Once regions are identified, ASTra builds a dependency graph between regions. An edge is created when one region uses a symbol defined by another region. The graph is directed because the dependency has direction.

Two classic graph algorithms are applied:

- Tarjan SCC finds strongly connected components. Any component with more than one region indicates a cycle. Cycles are important because they limit how splitting can happen.
- Kahn topological sort produces a safe extraction order where dependencies are created before dependents.

The graph also computes coupling and cohesion scores. Coupling indicates how many other regions depend on a region. Cohesion indicates how self contained a region is. High coupling regions are good candidates for extraction because they are reused and central.

### 5.3 Stage 3 - Code metrics

ASTra calculates a rich set of metrics per region. These metrics are grounded in known research and also include project specific measures.

Key metrics include:

- Cyclomatic complexity: counts independent execution paths by counting branching keywords.
- Cognitive complexity: estimates how hard the logic is to understand by considering nesting depth.
- Halstead volume and effort: estimates the information content of the code by counting operators and operands.
- Maintainability index: a normalized score that combines complexity and size.
- Testability score: a custom measure that considers complexity, nesting, async use, JSX, and kind.
- Bundle weight: a weighted line count to estimate runtime impact.
- Technical debt minutes: an estimate based on complexity, smells, and size.
- Class cohesion metrics such as LCOM4, TCC, and LCC for class regions.

These metrics are shown in the webview and are used by the Extraction Oracle.

### 5.4 Stage 4 - Code smell detection

ASTra applies more than twenty code smell rules for React and TypeScript. Examples include:

- God Component and oversized module detection.
- Mixed concerns such as data fetching inside a render function.
- Prop drilling and excessive nesting.
- Magic numbers, long switch statements, and TODO or FIXME density.

In addition, framework plugins add smells for Vue 3, Angular, and Svelte. For example, Vue rules detect missing keys in v-for, and Angular rules detect subscription leaks without OnDestroy.

Smells are assigned a severity and a recommendation. This helps the user understand not only that a smell exists, but also why it matters.

### 5.5 Stage 5 - Extraction Oracle

This is the decision engine. Instead of a single rule like "extract if LOC > 100", the Oracle computes a weighted score using multiple factors:

- Size pressure: larger regions are more likely to be extracted.
- Complexity signal: higher complexity pushes toward extraction.
- Kind affinity: some kinds, like hooks and context providers, naturally fit separate files.
- Smell severity: severe smells increase extraction score.
- Coupling and cohesion: loosely coupled or highly reused regions are better candidates.
- Testability gain: extraction can improve testability.

The result is a score between 0 and 1. If the score meets a calibrated threshold, the region becomes an extraction candidate. The system also provides a confidence label and a predicted maintainability improvement.

### 5.6 Stage 5b - Halstead calibrated threshold

ASTra does not use a fixed threshold for every file. It calculates a threshold based on the distribution of Halstead effort values in the current file. If a file is already very complex, the threshold is lowered, allowing more extraction. If the file is simple, the threshold is raised, preventing over splitting. A user setting can bias this threshold within a safe range. This makes the decision adaptive and more realistic in practice.

### 5.7 Stage 6 - Import resolution

When a region is extracted, it needs correct imports to compile. ASTra resolves symbols in three ways:

1. Symbols from other extracted regions become relative imports.
2. Symbols that are types are imported using type only imports.
3. Symbols from external packages are preserved from the original import records.

Import ordering is kept consistent to reduce diff noise. This stage ensures that generated files are ready to compile.

### 5.8 Stage 7 - File generation

ASTra generates complete files for each extraction candidate. A generated file includes a header comment, imports, and the original region body. The source file is updated to remove extracted regions and add re imports. A barrel index file is created so that the module can be imported cleanly. Test stubs are generated based on region kind. For example, hooks use renderHook tests while utility functions use input output tests.

### 5.9 Stage 8 - Linkage map

After files are generated, ASTra builds a file level linkage map. This shows which proposed files import from which. It highlights circular risks and the critical dependency path. This helps the user judge the impact of the refactor before applying it.

### 5.10 Incremental caching

ASTra uses an LRU cache at the region level. When a file is re analyzed, unchanged regions reuse cached metrics and smells. This reduces repeated work and makes the tool feel fast in daily use. Region hashes are computed using a fast string hash, and stale cache entries are evicted by age and size.

### 5.11 Cross file workspace graph and merge suggestions

ASTra builds a workspace graph by scanning files in the project and indexing their exports. When a region is a candidate for extraction, the Merge Advisor can suggest an existing file that already contains similar kinds or symbols. This reduces unnecessary file creation and encourages more consistent project structure.

### 5.12 Atomic apply

The apply step uses a single WorkspaceEdit. That means creating new files and updating the source file is a single atomic change. Users can undo the entire split with one undo action, which is important for safety and adoption.

## Summary

The literature shows that combining static analysis, code metrics, and refactoring guidance can improve code maintainability. ASTra v3 uses these ideas in a practical pipeline that is integrated into VS Code. The next sections explain how this project was built and evaluated in practice.
