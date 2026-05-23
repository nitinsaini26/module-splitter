# Introduction

## Background

Modern front end and full stack projects commonly use TypeScript, React, and other component based frameworks. Over time, a single file tends to grow with new features. Developers add new hooks, more UI states, and new helper functions in the same file for speed. This is normal in early development, but it creates a long term cost. When a file becomes too large, it is difficult to understand, difficult to test, and risky to change. Import statements grow, reuse becomes low, and one change can break several unrelated parts.

There are many general refactoring tools, but most of them still require manual effort and deep knowledge of the file. A developer must scan for logical regions, guess dependencies, and carefully move code while updating imports. This is a slow and error prone activity, especially for large React or TypeScript modules. The ASTra v3 Module Splitter project addresses this exact pain point. It is a VS Code extension that reads a file, finds its logical regions, scores them with code metrics, detects smells, and produces a safe split plan. It is not just a formatter or a linter. It is a guided refactoring assistant that works inside the developer workflow.

## Problem Statement

The main problem is the lack of a reliable, automated, and developer friendly way to split large TypeScript or React modules into smaller modules. A manual split usually fails for one of these reasons:

- The developer misses a dependency and the new file does not compile.
- A region is extracted even though it should stay, which fragments related logic.
- A region that should be extracted stays, which keeps the file large and complex.
- The refactor is hard to undo and requires multiple revert steps.

The project solves these issues with a metrics driven pipeline and a review based UI before any changes are applied.

## Objectives

The objectives of the project are:

- Detect all top level code regions in a file without guessing from raw text.
- Build a dependency graph so that extraction order and coupling are correct.
- Measure complexity and maintainability to support better decisions.
- Detect code smells and surface them as actionable findings.
- Decide what to extract using a multi factor scoring model rather than a single rule.
- Generate correct imports, new files, and updated source content automatically.
- Provide a safe apply step with a single undo action.
- Integrate the system into VS Code with a clear, review focused UI.

## Scope

The scope of this project includes:

- Source files written in TypeScript, JavaScript, and framework variants such as TSX, JSX, Vue, and Svelte.
- Static analysis of a single file with optional workspace context for merge suggestions.
- Generation of new files, a barrel index, and test stubs for Jest or Vitest.
- Inline diagnostics and a status bar grade for quick feedback.

The project does not aim to be a full compiler or runtime checker. It uses structural analysis and heuristics rather than a full type checker. It also does not execute the code. The goal is to provide a safe, high quality split plan based on code structure and established metrics.

## Significance of the Project

This project is significant for three main reasons:

1. It brings academic quality metrics and refactoring principles into a practical developer tool.
2. It reduces time and risk in large file refactoring, a common pain point in real projects.
3. It offers an extensible framework, with plugin based smell detection for different front end ecosystems.

By combining static analysis, graph algorithms, and a strong VS Code integration, ASTra v3 provides value not only for students but also for working developers.

## Organization of the Report

This report is organized in multiple files. After this introduction, the literature review explains the tools, libraries, and algorithms used by the system. The methodology section documents how the project was planned and built. Observations and results discuss what is seen in practice when the tool is used. The report concludes with future scope and references.
