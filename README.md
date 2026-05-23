# ASTra v3 — Module Splitter

> **Adaptive Semantic Tree Restructuring** — automated, metrics-driven TypeScript/React module decomposition for VS Code.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Repo](https://img.shields.io/badge/GitHub-astra--extension-teal)](https://github.com/NK2552003/astra-extension)

---

## What It Does

ASTra analyses your source files and tells you exactly how to split them — with correct import statements already resolved, test stubs scaffolded, and a barrel `index.ts` ready to drop in.

---

## Features

- **8-stage analysis pipeline** — AST parsing → dependency graph → metrics → smells → extraction oracle → import resolution → file generation → linkage map
- **ExtractionOracle** — 8-factor weighted scoring with Halstead-calibrated per-file threshold
- **Incremental cache** — unchanged regions served from LRU cache (~10× faster on re-analysis)
- **20+ code smell rules** — God Component, Prop Drilling, Async useEffect, Duplicate Logic, and more
- **Framework plugins** — Vue 3 SFC, Angular, and Svelte smell detection alongside React/TS rules
- **Cross-file workspace graph** — suggests merging into existing files rather than always creating new ones
- **Atomic apply** — all new files + source update in one `WorkspaceEdit` (single Ctrl+Z undo)
- **Inline diagnostics** — code smells appear as squiggles directly in your editor
- **Live status bar** — health grade (S/A/B/C/D/F) visible for every open file
- **8-tab review panel** — Overview, Regions, Extract, Linkage, Smells, Tests, Files, Dry Run

---

## Usage

1. Open any `.ts`, `.tsx`, `.js`, `.jsx`, `.vue`, or `.svelte` file
2. Press `Ctrl+Shift+Alt+S` (or `Cmd+Shift+Alt+S` on Mac)
3. Review the 8-tab analysis panel
4. Click **Apply** to write the split files atomically

Or use the Command Palette: **ASTra: Analyse & Split This Module**

---

## Settings

| Setting                     | Default | Description                                           |
| --------------------------- | ------- | ----------------------------------------------------- |
| `astra.extractionThreshold` | `0.35`  | User bias for Halstead-calibrated threshold (0.1–0.9) |
| `astra.testFramework`       | `auto`  | `jest` / `vitest` / `auto`                            |
| `astra.showInlineSmells`    | `true`  | Show smell squiggles in editor                        |
| `astra.statusBarEnabled`    | `true`  | Show health grade in status bar                       |
| `astra.showOnSave`          | `false` | Auto-analyse on save                                  |
| `astra.autoApply`           | `false` | Apply split without review                            |
| `astra.typesFile`           | `""`    | Path to existing types file                           |
| `astra.ignorePatterns`      | `[...]` | Glob patterns to exclude                              |

---

## Commands

| Command                            | Keybinding         |
| ---------------------------------- | ------------------ |
| ASTra: Analyse & Split This Module | `Ctrl+Shift+Alt+S` |
| ASTra: Apply Split Plan            | —                  |
| ASTra: Show File Metrics           | —                  |
| ASTra: Clear Diagnostics           | —                  |

---

## Development

```bash
# Clone
git clone https://github.com/NK2552003/astra-extension
cd astra-extension

# Install
npm install

# Build
npm run compile

# Test (144 tests)
npm test

# Debug: press F5 in VS Code to open Extension Development Host
```

See `.vscode/launch.json` for all debug configurations and `.vscode/tasks.json` for all available tasks.

---

## Docs

| Document                                             | Description                                  |
| ---------------------------------------------------- | -------------------------------------------- |
| [`docs/FEATURES.md`](docs/FEATURES.md)               | Complete feature reference — all 16 features |
| [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md)       | Deep-dive into the 8-stage pipeline          |
| [`docs/EXTENSION_SETUP.md`](docs/EXTENSION_SETUP.md) | Setup, limitations, roadmap                  |
| [`docs/PROJECT_SETUP.md`](docs/PROJECT_SETUP.md)     | Standalone project / CLI setup               |
| [`docs/ASTra-v3-paper.md`](docs/ASTra-v3-paper.md)   | Research paper (publishable)                 |

---

## License

MIT © Nitish Kumar — [github.com/NK2552003/astra-extension](https://github.com/NK2552003/astra-extension)
