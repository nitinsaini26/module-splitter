/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Shared Utilities                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

// ─────────────────────────────────────────────────────────────────────────────
// String helpers
// ─────────────────────────────────────────────────────────────────────────────

/** HTML-escape a string for safe webview injection */
export function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Convert PascalCase / camelCase to kebab-case */
export function toKebabCase(name: string): string {
  return name
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
}

/** Convert camelCase to Title Case */
export function toTitleCase(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/** Truncate a string to maxLen chars, appending '…' */
export function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

// ─────────────────────────────────────────────────────────────────────────────
// Array helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Remove duplicate values from an array */
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Group an array by a key function */
export function groupBy<T, K extends string>(
  arr: T[],
  key: (item: T) => K,
): Record<K, T[]> {
  return arr.reduce(
    (acc, item) => {
      const k = key(item);
      if (!acc[k]) acc[k] = [];
      acc[k].push(item);
      return acc;
    },
    {} as Record<K, T[]>,
  );
}

/** Clamp a number to [min, max] */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity / grade helpers
// ─────────────────────────────────────────────────────────────────────────────

import type { HealthGrade, Severity, Confidence } from "../types";

export function severityRank(s: Severity): number {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[s] ?? 0;
}

export function confidencePercent(c: Confidence): number {
  return (
    {
      definitive: 97,
      high: 85,
      medium: 65,
      low: 40,
      speculative: 20,
    }[c] ?? 0
  );
}

export function healthColor(grade: HealthGrade): string {
  return (
    {
      S: "var(--vscode-terminal-ansiGreen,#4caf50)",
      A: "var(--vscode-terminal-ansiGreen,#88c057)",
      B: "var(--vscode-terminal-ansiYellow,#c5c022)",
      C: "var(--vscode-editorWarning-foreground,#cca700)",
      D: "var(--vscode-terminal-ansiRed,#e06c75)",
      F: "var(--vscode-editorError-foreground,#f14c4c)",
    }[grade] ?? "#888"
  );
}

export function severityColor(s: Severity): string {
  return (
    {
      critical: "var(--vscode-editorError-foreground,#f14c4c)",
      high: "var(--vscode-editorWarning-foreground,#cca700)",
      medium: "var(--vscode-editorInfo-foreground,#3794ff)",
      low: "var(--vscode-descriptionForeground,#888)",
      info: "var(--vscode-descriptionForeground,#666)",
    }[s] ?? "#888"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Time formatting
// ─────────────────────────────────────────────────────────────────────────────

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

export function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

export function dirname(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

export function extname(filePath: string): string {
  const base = basename(filePath);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx) : "";
}

export function stripExtension(filePath: string): string {
  return filePath.replace(/\.[jt]sx?$/, "");
}

/** Detect if a source string contains chained method calls (e.g. a().b().c()) */
export function hasChainedCalls(src: string): boolean {
  // Simple heuristic: look for repeated ".identifier(" patterns with at least two in sequence
  const re = /(?:\.[A-Za-z_$][A-Za-z0-9_$]*\s*\()/g;
  const matches = src.match(re) ?? [];
  return matches.length >= 2;
}
