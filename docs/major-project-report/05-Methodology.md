# Project Methodology and Material Methodology

This section explains how the project was planned and executed, and what materials and resources were used.

## 1. Project methodology

The project followed a practical software engineering life cycle. It combines research ideas (metrics and smells) with real developer workflow needs (VS Code integration, undo safety). The process is described below.

### 1.1 Requirement analysis

The first phase identified the main user problems:

- Large TypeScript or React files are hard to maintain.
- Manual splitting is slow and error prone.
- Developers need a safe review before applying a refactor.
- The tool must be fast enough for repeated use.

Based on these requirements, the system needed to be:

- Accurate in detecting regions and dependencies.
- Transparent in how decisions are made.
- Safe to apply, with easy undo.
- Integrated into the developer IDE for convenience.

### 1.2 Design phase

The design focuses on a pipeline model. Each stage handles a narrow responsibility and produces clear output for the next stage. The stages are:

1. AST parsing and region detection
2. Dependency graph analysis
3. Metrics computation
4. Code smell detection
5. Extraction Oracle
6. Import resolution
7. File generation
8. Linkage map

This pipeline was chosen because it is explainable and testable. Each stage can be unit tested and improved independently.

A second design decision was the user interface. Instead of applying changes directly, the system shows an eight tab webview. This gives the user confidence and makes the tool acceptable for real projects.

### 1.3 Implementation phase

Implementation followed the pipeline design. Each stage was built as a TypeScript module. Key implementation choices:

- TypeScript Compiler API for parsing and symbol access.
- Tarjan SCC and Kahn topological sort for graph logic.
- Deterministic scoring in the Extraction Oracle.
- WorkspaceEdit for atomic apply.

The project uses strict TypeScript configuration to reduce runtime errors. Each module is separate and uses clearly typed interfaces to pass data between stages.

### 1.4 Incremental performance improvements

A pure pipeline can be slow if it runs from scratch on every edit. To avoid this, the project introduced a region cache. Each region is hashed and stored with its metrics and smells. When the file is analyzed again, unchanged regions are loaded from cache, while only the changed regions are recalculated. This improves performance and makes the tool feel immediate in normal workflows.

### 1.5 Testing methodology

The project includes an automated Jest test suite that covers the pipeline, features, and framework plugins. Tests validate:

- Region detection and classification.
- Dependency graph correctness and edge types.
- Metric calculations for known samples.
- Smell detection rules and severities.
- Threshold calibration logic.
- Import resolution logic and file generation.
- Workspace graph and merge suggestions.

Unit tests are preferred for deterministic behavior. Where appropriate, integration tests are used for pipeline end to end validation. The tests are executed before publishing or packaging.

### 1.6 Documentation and review

Documentation is important for a tool that changes code. The project includes README, feature reference, and how it works documents. These explain the pipeline, settings, and limitations. The report you are reading is part of this documentation effort and is aimed at academic evaluation.

## 2. Material methodology

Material methodology describes the resources, tools, and environment used to build and validate the project.

### 2.1 Hardware and operating system

- A standard developer laptop or desktop is sufficient.
- The tool is light weight and runs inside VS Code.
- The project was developed on macOS, but it is compatible with Windows and Linux because it is a VS Code extension.

### 2.2 Software environment

- Operating system: macOS, Windows, or Linux.
- Node.js: 18.x or higher.
- npm: 9.x or higher.
- VS Code: 1.85 or higher.
- TypeScript: 5.x.

### 2.3 Development tools

- VS Code for editing, debugging, and running the extension.
- Git for version control.
- Jest for tests and coverage.
- ESLint for linting and code quality checks.
- vsce for packaging.

### 2.4 Input data

The main input to the system is a source code file. It can be any of the supported file types: TS, TSX, JS, JSX, Vue, or Svelte. The input data is not user data or sensitive data. It is just code and metadata extracted from the file.

In addition, the tool can read the workspace to build a graph of existing files and exports. This improves merge suggestions and helps avoid unnecessary new files.

### 2.5 Output data

The outputs are:

- A split plan with metrics, smells, and extraction decisions.
- Generated files for extracted regions.
- An updated source file with re imports.
- A barrel index file.
- Optional test stubs for each extracted file.
- Diagnostics and a status bar grade for quick feedback.

### 2.6 Risk management and safety

Code refactoring is a high risk operation. The project uses several safety techniques:

- Atomic WorkspaceEdit so all changes are applied together.
- A review panel that shows all changes before apply.
- Clear warnings for cycles and risky dependencies.
- An undo option that reverts all changes in one step.

### 2.7 Ethical and quality considerations

The tool is intended to support developers, not replace judgment. It provides recommendations, but the user always makes the final decision. It does not collect user code or transmit data outside the local machine. This keeps the tool safe for private and enterprise codebases.

## 3. Summary

The methodology combines structured pipeline design with strong safety and usability. It uses academic metrics but keeps the experience practical for daily development. The material requirements are modest, making the tool accessible for most students and developers.
