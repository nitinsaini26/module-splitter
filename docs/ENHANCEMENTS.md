# ASTra v3 — Enhancement Roadmap

> Everything that can be added to make ASTra v3 more powerful, more accurate, and more useful. Grouped by category, each item has an effort estimate, impact rating, and a one-line description of what it would do.

**Effort:** S = days · M = weeks · L = months  
**Impact:** ⭐⭐⭐ high · ⭐⭐ medium · ⭐ low

---

## 2. Refactoring Intelligence

| #    | Enhancement                                      | Effort | Impact | Description                                                                                                                                                   |
| ---- | ------------------------------------------------ | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | **Circular dependency auto-breaker**             | L      | ⭐⭐⭐ | When SCC detects `A → B → A`, automatically introduce a shared abstraction `C` that both A and B can depend on, breaking the cycle without creating new ones. |
| 2.2  | **Test suite pre-apply verification**            | M      | ⭐⭐⭐ | Run Jest/Vitest against the generated files before committing the edit. If any test fails, show the diff and offer a partial apply.                           |
| 2.3  | **Rename symbol across workspace on extract**    | M      | ⭐⭐⭐ | When extracting `useAuth` to `hooks/use-auth.ts`, update every other file in the workspace that imports it to point to the new location.                      |
| 2.4  | **Barrel file merging**                          | S      | ⭐⭐   | Instead of always creating a new `index.ts`, detect and append to an existing barrel file in the target directory.                                            |
| 2.5  | **Incremental apply — patch instead of replace** | M      | ⭐⭐⭐ | Instead of replacing the entire source file content, generate a minimal diff patch and apply only the changed lines. Reduces undo stack footprint.            |
| 2.6  | **Undo-aware re-analysis**                       | S      | ⭐⭐   | Listen to `vscode.workspace.onDidChangeTextDocument` to detect when the user undoes an apply, and automatically invalidate the cache for that file.           |
| 2.7  | **Multi-file batch split**                       | L      | ⭐⭐⭐ | Analyse multiple selected files in one run and produce a combined SplitPlan that avoids naming collisions and deduplicates shared types across all files.     |
| 2.8  | **Extract to existing class / service**          | M      | ⭐⭐   | Suggest injecting a method into an existing class rather than creating a new function file — especially useful for Angular service extraction.                |
| 2.9  | **Auto-import path aliasing**                    | S      | ⭐⭐   | Respect `tsconfig.json` path aliases (`@/hooks`, `~utils`) when generating import statements instead of always using relative paths.                          |
| 2.10 | **Preserve JSDoc on extraction**                 | S      | ⭐     | Copy JSDoc comments from the original source into the generated file header, preserving `@param`, `@returns`, and `@example` annotations.                     |

---

## 3. AI / ML Features

| #   | Enhancement                              | Effort | Impact | Description                                                                                                                                                                        |
| --- | ---------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | **AI-assisted file naming (Claude API)** | S      | ⭐⭐   | Call `claude-sonnet-4-6` with the first 20 lines of a region and ask for the most idiomatic file name for the detected framework. Replace `kebab-case(name)` heuristic.            |
| 3.2 | **AI extraction reasoning**              | S      | ⭐⭐   | For each extraction candidate, call Claude to produce a one-paragraph plain-English explanation of _why_ this region should be extracted — beyond the mechanical oracle reasons.   |
| 3.3 | **ML-augmented ExtractionOracle**        | L      | ⭐⭐⭐ | Replace the 8-weight hand-tuned vector with a gradient-boosted classifier trained on a labelled corpus of developer extraction decisions. Export as ONNX for in-process inference. |
| 3.4 | **AI test stub generation**              | M      | ⭐⭐⭐ | Instead of generic `it('works correctly')` stubs, call Claude with the region source to generate meaningful, context-aware test descriptions and input/output examples.            |
| 3.5 | **AI smell fix suggestions**             | M      | ⭐⭐   | For each detected smell, call Claude to generate a concrete code fix (not just a recommendation string), which can be shown as a VS Code Code Action.                              |
| 3.6 | **AI architecture review**               | L      | ⭐⭐   | After building the workspace graph, send the overall dependency structure to Claude and ask for architectural observations — circular dependency patterns, layer violations, etc.  |
| 3.7 | **Natural language query mode**          | L      | ⭐⭐   | Let users type queries like "show me all hooks that depend on the auth service" or "which files have the highest debt?" and answer via Claude + the workspace graph.               |
| 3.8 | **AI-generated prop interfaces**         | S      | ⭐⭐   | When extracting a React component, call Claude to infer the correct TypeScript prop interface from the component's usage patterns rather than the current `unknown` placeholder.   |

---

## 4. Framework Support

| #    | Enhancement                                   | Effort | Impact | Description                                                                                                                                                              |
| ---- | --------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1  | **Vue composable extractor**                  | M      | ⭐⭐⭐ | Parse `<script setup>` and identify groups of related refs/computed/watchers that form a logical composable. Suggest extraction into `useX.ts` files.                    |
| 4.2  | **Vue SFC → Composition API migration guide** | M      | ⭐⭐   | Detect Options API components and generate a step-by-step migration plan to Composition API, highlighting which `data()` properties map to which `ref()` declarations.   |
| 4.3  | **Angular service extractor**                 | M      | ⭐⭐⭐ | Detect business logic inside `ngOnInit` and component methods that belongs in a service. Generate the `@Injectable` service class and update the component to inject it. |
| 4.4  | **Angular standalone component migration**    | M      | ⭐⭐   | Detect components still using NgModule and suggest migration to standalone components (Angular 14+), generating the updated `imports[]` array.                           |
| 4.5  | **Svelte store extractor**                    | S      | ⭐⭐   | Detect inline `writable`/`readable` store declarations inside components and suggest extracting them to a `stores/` directory.                                           |
| 4.6  | **Next.js App Router detection**              | S      | ⭐⭐   | Detect `'use client'` / `'use server'` directives and treat them as extraction boundaries. Never merge a client component into a server component file.                  |
| 4.7  | **React Server Components smell**             | S      | ⭐⭐   | Detect `useState`, `useEffect`, or event handlers in server component files (missing `'use client'` directive) and flag as a critical smell.                             |
| 4.8  | **Remix / TanStack Router route detection**   | S      | ⭐     | Recognise `loader`, `action`, `meta` exports as framework-specific boundary markers and exclude them from extraction decisions.                                          |
| 4.9  | **Solid.js support**                          | M      | ⭐⭐   | Add smell rules and kind classification for SolidJS primitives: `createSignal`, `createEffect`, `createMemo`, `createStore`.                                             |
| 4.10 | **Qwik component detection**                  | S      | ⭐     | Recognise `component$`, `useSignal`, `useStore`, `$` suffix functions as Qwik-specific constructs for correct kind classification.                                       |

---

## 5. VS Code UX

| #    | Enhancement                               | Effort | Impact | Description                                                                                                                                                         |
| ---- | ----------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1  | **Real-time on-type diagnostics**         | M      | ⭐⭐⭐ | Debounced (500ms) analysis triggered on every keystroke. Updates the status bar and inline diagnostics without requiring a command invocation.                      |
| 5.2  | **Code Actions (lightbulb quick-fixes)**  | M      | ⭐⭐⭐ | Register a `vscode.CodeActionProvider` so that hovering over a smell squiggle shows a lightbulb with "Extract to hooks/" or "Extract to utils/" as a one-click fix. |
| 5.3  | **TreeView panel (Explorer sidebar)**     | M      | ⭐⭐   | Add a dedicated Activity Bar view showing all workspace files with their health grade, click to analyse, grouped by grade.                                          |
| 5.4  | **Progress in status bar**                | S      | ⭐⭐   | Show a spinning indicator in the status bar while analysis is running instead of the notification toast — less intrusive for on-save analysis.                      |
| 5.5  | **Diff editor for updated source**        | S      | ⭐⭐⭐ | Before applying, show the source file change in VS Code's built-in diff editor (`vscode.diff`) so the user can see exactly what will be removed line by line.       |
| 5.6  | **Webview: interactive dependency graph** | M      | ⭐⭐   | Replace the static SVG mini-map in the Overview tab with a click-to-explore force-directed graph using the VS Code webview canvas API.                              |
| 5.7  | **Webview: file content editing**         | M      | ⭐⭐   | Allow editing the generated file content directly inside the Files tab before applying, so users can tweak exports/imports without touching the apply flow.         |
| 5.8  | **Webview: copy individual file content** | S      | ⭐⭐   | Add a "Copy" button on each file card in the Files tab so users can copy the generated content to the clipboard without applying.                                   |
| 5.9  | **Notification action: "Show in panel"**  | S      | ⭐     | After on-save analysis, the toast notification should have a "Show Report" button that opens the 8-tab panel directly.                                              |
| 5.10 | **Keyboard navigation in webview**        | S      | ⭐     | Allow Tab / arrow keys to navigate between the 8 webview tabs without needing mouse clicks.                                                                         |
| 5.11 | **Per-file smell history**                | M      | ⭐⭐   | Track smell counts over time (stored in VS Code's global state) and show a trend graph in the Overview tab — "this file had 12 smells last week, 8 today".          |
| 5.12 | **Workspace-level health dashboard**      | L      | ⭐⭐⭐ | A summary webview showing health grades for every file in the workspace, total technical debt, and trending metrics — accessible from the Activity Bar.             |

---

## 6. Performance

| #   | Enhancement                                | Effort | Impact | Description                                                                                                                                                                   |
| --- | ------------------------------------------ | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | **Worker thread analysis**                 | M      | ⭐⭐⭐ | Move the 8-stage pipeline to a VS Code worker thread so large files (1000+ lines) don't block the extension host and the UI remains responsive.                               |
| 6.2 | **Persistent cache (disk)**                | M      | ⭐⭐   | Serialise the `RegionCache` to VS Code's `globalStorageUri` on deactivation and restore it on activation, so the cache survives VS Code restarts.                             |
| 6.3 | **Lazy workspace graph build**             | S      | ⭐⭐   | Build the workspace graph only for the directories relevant to the file being analysed (same depth ±2 levels) instead of scanning the whole workspace every time.             |
| 6.4 | **Streaming analysis results**             | L      | ⭐⭐   | Stream partial results to the webview as each pipeline stage completes, so the panel opens immediately with metrics while smells/oracle results load progressively.           |
| 6.5 | **TypeScript language server integration** | L      | ⭐⭐⭐ | Use the existing VS Code TypeScript language server (already running) for symbol resolution instead of spawning a separate `ts.createProgram` — eliminates duplicate parsing. |

---

## 7. CI / CD & Team Features

| #   | Enhancement                                | Effort | Impact | Description                                                                                                                                                                  |
| --- | ------------------------------------------ | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | **GitHub Actions integration**             | M      | ⭐⭐⭐ | `astra-check` GitHub Action that runs on PRs, posts a comment with health grades for all changed files, and optionally fails CI below a grade threshold.                     |
| 7.2 | **Pre-commit hook generator**              | S      | ⭐⭐   | Generate a `.husky/pre-commit` or `.lefthook.yml` config that runs ASTra on staged files and blocks commits if health grade drops below A.                                   |
| 7.3 | **Team threshold configuration**           | S      | ⭐⭐   | Support reading extraction thresholds, smell severity overrides, and ignore patterns from a `.astra.json` or `astra` key in `package.json` — shared across the team via git. |
| 7.4 | **Slack / Teams notifications**            | M      | ⭐     | Post a daily workspace health summary to a configured Slack webhook — total debt minutes, new smells introduced, files below threshold.                                      |
| 7.5 | **VS Code Live Share integration**         | L      | ⭐⭐   | Share the ASTra analysis panel with Live Share participants so a team can review extraction decisions together in real time.                                                 |
| 7.6 | **Split plan export (JSON / HTML report)** | S      | ⭐⭐   | Export the full `SplitPlan` as a JSON file or a standalone HTML report that can be shared with teammates who don't have the extension installed.                             |
| 7.7 | **Git blame integration**                  | M      | ⭐⭐   | Show which developer introduced each code smell (via `git blame`) in the Smells tab, for more targeted code review conversations.                                            |
| 7.8 | **Jira / Linear issue creation**           | M      | ⭐     | For each critical smell, offer a "Create Issue" button that opens a pre-filled Jira or Linear issue with the smell description and file reference.                           |

---

## 8. LSP & Multi-Editor

| #   | Enhancement                           | Effort | Impact | Description                                                                                                                                                                               |
| --- | ------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | **LSP server (multi-editor support)** | L      | ⭐⭐⭐ | Package the ASTra analysis engine as a Language Server Protocol server. Exposes `textDocument/publishDiagnostics` and `textDocument/codeAction` — works in Neovim, Emacs, JetBrains, Zed. |
| 8.2 | **JetBrains plugin**                  | L      | ⭐⭐   | Port the analysis engine to a JetBrains IntelliJ plugin (Kotlin) using the same algorithm, for WebStorm and IDEA users.                                                                   |
| 8.3 | **Neovim plugin**                     | M      | ⭐⭐   | Wrap the LSP server as a Neovim Lua plugin with a floating window UI equivalent to the 8-tab webview.                                                                                     |
| 8.4 | **CLI tool (standalone)**             | S      | ⭐⭐⭐ | Publish `npx astra-split <file>` as a standalone npm package usable without VS Code — for CI pipelines, scripts, and editors without plugin support.                                      |
| 8.5 | **Web-based playground**              | L      | ⭐⭐   | A browser-based editor at `astra.nitish.world/playground` where users can paste code and see the split plan without installing anything.                                                  |

---

## 9. Testing & Reliability

| #   | Enhancement                             | Effort | Impact | Description                                                                                                                                                                              |
| --- | --------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 | **VS Code Extension Test Runner**       | S      | ⭐⭐⭐ | Add `@vscode/test-electron` integration tests that actually launch the Extension Development Host, open a file, trigger the command, and assert that files were created on disk.         |
| 9.2 | **Snapshot testing for webview HTML**   | S      | ⭐⭐   | Jest snapshot tests for `renderSplitPlanHtml` output — catch regressions in the webview layout when the renderer is modified.                                                            |
| 9.3 | **Property-based testing (fast-check)** | M      | ⭐⭐   | Use `fast-check` to generate random TypeScript source snippets and verify that the pipeline never throws, always returns a valid `SplitPlan`, and never produces invalid import paths.   |
| 9.4 | **Benchmark suite**                     | S      | ⭐⭐   | `vitest bench` suite measuring analysis latency for files of 50, 200, 500, 1000, 2000 lines — with CI regression detection if any benchmark degrades > 20%.                              |
| 9.5 | **Fuzz testing for parser**             | M      | ⭐⭐   | Feed malformed TypeScript (syntax errors, partial files, binary content) to the parser and assert it never throws unhandled exceptions — always returns a valid (possibly empty) result. |
| 9.6 | **Coverage gates in CI**                | S      | ⭐     | Enforce the existing 80%/85% coverage thresholds in the GitHub Actions workflow — fail the PR if any new code is added without corresponding tests.                                      |

---

## 10. Documentation & DX

| #    | Enhancement                              | Effort | Impact | Description                                                                                                                                                         |
| ---- | ---------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.1 | **Interactive tutorial / walkthrough**   | M      | ⭐⭐⭐ | VS Code `vscode.window.showWalkthrough` built-in tutorial with 5 steps: install → open a file → run analysis → review panel → apply split.                          |
| 10.2 | **Inline code examples in settings**     | S      | ⭐     | Add `markdownDescription` with code examples to every `astra.*` setting so users understand the impact without reading the docs.                                    |
| 10.3 | **CHANGELOG auto-generation**            | S      | ⭐     | Integrate `conventional-changelog` to auto-generate `CHANGELOG.md` from commit messages on every release.                                                           |
| 10.4 | **API documentation (TypeDoc)**          | S      | ⭐⭐   | Run TypeDoc on `src/splitter/` to generate a browsable HTML API reference, published to GitHub Pages.                                                               |
| 10.5 | **Video demo**                           | S      | ⭐⭐   | A 3-minute screen-recording showing the extension in action on a real 300-line God Component — from right-click to files created.                                   |
| 10.6 | **VS Code Marketplace listing**          | S      | ⭐⭐⭐ | Complete the Marketplace listing with gallery banner, feature screenshots, demo GIF, and tags. Publish to the Open VSX Registry too (for VS Codium / Gitpod users). |
| 10.7 | **Contributing guide**                   | S      | ⭐     | `CONTRIBUTING.md` with setup instructions, coding conventions, how to add a new smell rule, and how to add a new framework plugin.                                  |
| 10.8 | **Architecture decision records (ADRs)** | S      | ⭐     | `docs/adr/` directory with one ADR per major design decision: why djb2 over SHA-256, why sigmoid threshold, why Kahn not Tarjan for sort, etc.                      |

---

## Priority Quick-Wins (implement in one session)

These have high impact and low effort — good candidates for the next development sprint:

| Priority | Item                                             | Why                                                                 |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| 🔥 1     | **`tsc --noEmit` post-apply verification** (1.1) | Makes Apply trustworthy — users will actually use it                |
| 🔥 2     | **Code Actions lightbulb** (5.2)                 | Makes smells actionable without opening the panel                   |
| 🔥 3     | **Diff editor before apply** (5.5)               | Removes last hesitation before clicking Apply                       |
| 🔥 4     | **AI-assisted file naming** (3.1)                | Small API call, visible quality improvement                         |
| 🔥 5     | **Rename across workspace on extract** (2.3)     | Without this, applying a split still requires manual import updates |
| 🔥 6     | **Persistent cache (disk)** (6.2)                | Cache currently resets on every VS Code restart                     |
| 🔥 7     | **Team config file (`.astra.json`)** (7.3)       | Enables team-wide threshold standardisation                         |
| 🔥 8     | **CLI tool** (8.4)                               | Immediately useful for CI without VS Code                           |
| 🔥 9     | **VS Code extension test** (9.1)                 | Catches bugs that unit tests miss                                   |
| 🔥 10    | **Interactive tutorial** (10.1)                  | Reduces time-to-first-value for new users                           |
