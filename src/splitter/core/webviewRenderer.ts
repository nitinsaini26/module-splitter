/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Webview Renderer                                                 ║
 * ║                                                                              ║
 * ║  Generates the 8-tab VS Code webview HTML panel for a SplitPlan.            ║
 * ║                                                                              ║
 * ║  Tabs:                                                                        ║
 * ║    1. Overview     — file health, metrics dashboard                          ║
 * ║    2. Regions      — all detected regions with metrics                      ║
 * ║    3. Extract      — extraction candidates + reasons                        ║
 * ║    4. Linkage      — dependency graph visualization                         ║
 * ║    5. Smells       — code smell cards with severity                         ║
 * ║    6. Tests        — suggested test scaffolds                               ║
 * ║    7. Files        — generated file content preview                         ║
 * ║    8. Dry Run      — before/after preview                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type { SplitPlan, CodeSmell, HealthGrade } from "../types";
import {
  esc,
  formatMinutes,
  healthColor,
  confidencePercent,
} from "../utils/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Codicons (VS Code icon font)
// ─────────────────────────────────────────────────────────────────────────────

const I = {
  split: svg("M3 3h5v5H3zm0 9h5v5H3zM9 3h5v5H9zM9 12h5v5H9z", 16),
  region: svg("M2 2h4v4H2zm6 0h4v4H8zM2 8h4v4H2zm6 0h4v4H8z", 16),
  extract: svg("M8 2l4 4H9v8H7V6H4z", 16),
  link: svg(
    "M10.59 4.59A2 2 0 0012 4h2a2 2 0 010 4h-2a2 2 0 01-1.41-.59L9.17 8.83A2 2 0 019 10v2a2 2 0 11-4 0v-2a2 2 0 01.59-1.41L7 7.17A2 2 0 018 6V4a2 2 0 01.59-1.41z",
    16,
  ),
  smell: svg("M8 1L1 14h14zM8 5v5M8 12v1", 16),
  test: svg("M4 3h8v2L8 9l4 4H4V3z", 16),
  files: svg("M5 3h6l2 2v10H5V3zM9 3v3h3", 16),
  dryrun: svg("M2 2h12v4l-6 6V18l-2-1v-5L2 6V2z", 16),
  check: svg("M2 7l4 4L14 3", 16),
  warn: svg("M8 2l6 10H2z", 16),
  metric: svg("M2 12h2V8h2v4h2V6h2v6h2V4h2v8h2v2H2z", 16),
  arrow: svg("M4 8h8M9 5l3 3-3 3", 16),
  cycle: svg("M8 3a5 5 0 100 10A5 5 0 008 3zM8 6v4M6 8h4", 16),
  critical: svg("M8 2a6 6 0 100 12A6 6 0 008 2zM8 5v4M8 11v1", 16),
  dead: svg("M4 4l8 8M12 4l-8 8", 16),
};

function svg(path: string, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab definitions
// ─────────────────────────────────────────────────────────────────────────────

interface TabDef {
  id: string;
  label: string;
  icon: string;
  count?: number;
}

function makeTabs(plan: SplitPlan): TabDef[] {
  return [
    { id: "overview", label: "Overview", icon: I.metric },
    {
      id: "regions",
      label: "Regions",
      icon: I.region,
      count: plan.regions.length,
    },
    {
      id: "extract",
      label: "Extract",
      icon: I.extract,
      count: plan.extractionCandidates.length,
    },
    {
      id: "linkage",
      label: "Linkage",
      icon: I.link,
      count: plan.linkageMap.length,
    },
    {
      id: "smells",
      label: "Smells",
      icon: I.smell,
      count: plan.codeSmells.length + (plan.frameworkSmells?.length ?? 0),
    },
    {
      id: "tests",
      label: "Tests",
      icon: I.test,
      count: plan.testFileSuggestions.length,
    },
    {
      id: "files",
      label: "Files",
      icon: I.files,
      count: plan.proposedFiles.length,
    },
    { id: "dryrun", label: "Dry Run", icon: I.dryrun },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric bar (0–100 fill)
// ─────────────────────────────────────────────────────────────────────────────

function metricBar(
  value: number,
  max: number,
  color = "var(--vscode-focusBorder,#007acc)",
): string {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return `<div style="height:4px;border-radius:2px;background:rgba(127,127,127,.15);margin-top:3px">
      <div style="height:100%;width:${pct}%;border-radius:2px;background:${color};transition:width .3s"></div>
    </div>`;
}

function badge(text: string, cls: "ok" | "warn" | "err" | "info"): string {
  return `<span class="s-badge ${cls}">${text}</span>`;
}

function severityBadge(severity: CodeSmell["severity"]): string {
  const map: Record<string, "ok" | "warn" | "err" | "info"> = {
    critical: "err",
    high: "err",
    medium: "warn",
    low: "info",
    info: "info",
  };
  return badge(severity.toUpperCase(), map[severity] ?? "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 1: Overview
// ─────────────────────────────────────────────────────────────────────────────

function renderOverview(plan: SplitPlan): string {
  const m = plan.metrics;
  const s = plan.summary;
  const tc = plan.thresholdCalibration;
  const cs = plan.cacheStats;

  const healthGrade = m.overallHealth;
  const healthClr = healthColor(healthGrade as HealthGrade);

  const metricCards = [
    { label: "Lines of Code", value: m.codeLines, max: 2000, unit: "" },
    { label: "Avg CC", value: m.avgCyclomaticComplexity, max: 25, unit: "" },
    {
      label: "Avg Cognitive CC",
      value: m.avgCognitiveComplexity,
      max: 40,
      unit: "",
    },
    {
      label: "Maintainability",
      value: m.maintainabilityIndex,
      max: 100,
      unit: "/100",
    },
    {
      label: "Halstead Volume",
      value: Math.round(m.halsteadVolume),
      max: 5000,
      unit: "",
    },
    {
      label: "Tech Debt",
      value: m.technicalDebtMinutes,
      max: 480,
      unit: " min",
    },
    {
      label: "Bundle Weight",
      value: Math.round(m.bundleImpactScore),
      max: 1000,
      unit: "",
    },
    {
      label: "Dup Logic Risk",
      value: Math.round(m.duplicateLogicRisk * 100),
      max: 100,
      unit: "%",
    },
  ]
    .map(
      (c) => `
      <div class="metric-card">
        <div class="metric-label">${esc(c.label)}</div>
        <div class="metric-value">${c.value}${c.unit}</div>
        ${metricBar(c.value, c.max)}
      </div>`,
    )
    .join("");

  const depGraph = buildMiniGraphSVG(plan);

  // ── Threshold calibration panel ──────────────────────────────────────────
  const threshPct = Math.round((tc?.threshold ?? 0.35) * 100);
  const threshColor =
    threshPct < 28
      ? "var(--vscode-terminal-ansiGreen,#4caf50)"
      : threshPct < 42
        ? "var(--vscode-editorInfo-foreground,#3794ff)"
        : "var(--vscode-editorWarning-foreground,#cca700)";
  const interpLabel = tc ? esc(tc.interpretation.replace(/-/g, " ")) : "—";
  const threshPanel = tc
    ? `
      <div class="section-label">${I.metric} Halstead-Calibrated Threshold</div>
      <div class="rc-block" style="margin:0 12px 8px">
        <div class="rc-block-title" style="justify-content:space-between">
          <span>σ_threshold</span>
          <span style="font-size:20px;font-weight:900;color:${threshColor}">${threshPct}%</span>
        </div>
        <div class="rc-row">
          <div class="rc-key">File Profile</div>
          <div class="rc-val" style="text-transform:capitalize">${interpLabel}</div>
        </div>
        <div class="rc-row">
          <div class="rc-key">Halstead P75 Effort</div>
          <div class="rc-val">${esc(String(tc.effortP75))}</div>
        </div>
        <div class="rc-row">
          <div class="rc-key">User Bias</div>
          <div class="rc-val">${tc.userBias >= 0 ? "+" : ""}${Math.round(tc.userBias * 100)}%</div>
        </div>
        <div class="rc-row">
          <div class="rc-key">Explanation</div>
          <div class="rc-val" style="font-size:10px;line-height:1.5">${esc(tc.explanation)}</div>
        </div>
        ${metricBar(threshPct, 75, threshColor)}
      </div>`
    : "";

  // ── Cache stats panel ────────────────────────────────────────────────────
  const hitPct = cs ? Math.round(cs.hitRate * 100) : 0;
  const hitColor =
    hitPct > 70
      ? "var(--vscode-terminal-ansiGreen,#4caf50)"
      : hitPct > 30
        ? "var(--vscode-editorInfo-foreground,#3794ff)"
        : "var(--vscode-descriptionForeground,#888)";
  const cachePanel = cs
    ? `
      <div class="section-label">${I.metric} Incremental Cache</div>
      <div class="rc-block" style="margin:0 12px 8px">
        <div class="rc-block-title" style="justify-content:space-between">
          <span>Cache Performance</span>
          <span style="font-size:16px;font-weight:900;color:${hitColor}">${hitPct}% hits</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0">
          <div class="rc-row" style="border-right:1px solid var(--vscode-panel-border,rgba(127,127,127,.1))">
            <div class="rc-key">Cached</div>
            <div class="rc-val" style="color:var(--vscode-terminal-ansiGreen,#4caf50);font-weight:700">${cs.cachedCount}</div>
          </div>
          <div class="rc-row" style="border-right:1px solid var(--vscode-panel-border,rgba(127,127,127,.1));padding-left:12px">
            <div class="rc-key">Re-analysed</div>
            <div class="rc-val" style="font-weight:700">${cs.dirtyCount}</div>
          </div>
          <div class="rc-row" style="padding-left:12px">
            <div class="rc-key">Latency</div>
            <div class="rc-val" style="font-weight:700">${cs.latencyMs}ms</div>
          </div>
        </div>
        <div class="rc-row">
          <div class="rc-key">Graph Rebuilt</div>
          <div class="rc-val">${cs.graphDirty ? "Yes (file changed)" : "No (reused from cache)"}</div>
        </div>
        ${metricBar(hitPct, 100, hitColor)}
      </div>`
    : "";

  return `
    <div class="panel-inner">
      <div class="section-label">${I.metric} Health Grade</div>
      <div class="health-grade" style="color:${healthClr}">${healthGrade}</div>
      <div class="section-label">${I.metric} Metrics</div>
      <div class="metric-grid">${metricCards}</div>
      ${threshPanel}
      ${cachePanel}
      <div class="section-label">${I.link} Dependency Mini-Map</div>
      <div style="padding:8px 12px;">${depGraph}</div>
      <div class="section-label">${I.check} Recommendation</div>
      <div class="rc-block" style="margin:0 12px 8px;">
        <div class="rc-row"><div class="rc-val">${esc(s.recommendation)}</div></div>
        <div class="rc-row">
          <div class="rc-key">Complexity</div>
          <div class="rc-val">${esc(s.overallComplexity)}</div>
        </div>
        <div class="rc-row">
          <div class="rc-key">Estimated Refactor Time</div>
          <div class="rc-val">${formatMinutes(s.estimatedRefactorMinutes)}</div>
        </div>
        <div class="rc-row">
          <div class="rc-key">Parse Engine</div>
          <div class="rc-val">${esc(plan.parseEngine)}</div>
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mini dependency graph (SVG)
// ─────────────────────────────────────────────────────────────────────────────

function buildMiniGraphSVG(plan: SplitPlan): string {
  const nodes = plan.regions.slice(0, 12); // max 12 nodes for readability
  if (nodes.length === 0)
    return '<p style="color:var(--vscode-descriptionForeground)">No regions detected.</p>';

  const W = 300,
    H = 160;
  const edgePalette: Record<string, string> = {
    call: "var(--vscode-editorInfo-foreground,#3794ff)",
    type: "var(--vscode-editorHint-foreground,#c586c0)",
    inheritance: "var(--vscode-terminal-ansiGreen,#4caf50)",
    reexport: "var(--vscode-editorWarning-foreground,#cca700)",
    reference: "var(--vscode-editor-foreground,#d4d4d4)",
    cochange: "var(--vscode-terminal-ansiYellow,#ffd866)",
  };
  const nodePalette = {
    extractFill: "var(--vscode-editorWarning-foreground,#cca700)",
    retainFill: "var(--vscode-focusBorder,#007acc)",
    stroke: "var(--vscode-editor-background,#1e1e1e)",
    label: "var(--vscode-editor-foreground,#ffffff)",
  };
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const rows = Math.ceil(nodes.length / cols);
  const cellW = W / cols;
  const cellH = H / rows;

  const positions = nodes.map((r, i) => ({
    id: r.id,
    x: (i % cols) * cellW + cellW / 2,
    y: Math.floor(i / cols) * cellH + cellH / 2,
  }));

  const posMap = new Map(positions.map((p) => [p.id, p]));

  const edgeLines = plan.dependencyGraph.edges
    .filter((e) => {
      const f = posMap.get(e.from);
      const t = posMap.get(e.to);
      return f && t;
    })
    .map((e) => {
      const f = posMap.get(e.from)!;
      const t = posMap.get(e.to)!;
      const color = e.isCyclic
        ? "var(--vscode-editorError-foreground,#f14c4c)"
        : e.isIndirectCycle
          ? "var(--vscode-editorWarning-foreground,#cca700)"
          : (edgePalette[e.edgeType] ??
            "var(--vscode-editor-foreground,#ffffff)");
      return `<line x1="${f.x}" y1="${f.y}" x2="${t.x}" y2="${t.y}" stroke="${color}" stroke-width="${Math.max(1.8, e.strength * 2.4)}" stroke-opacity="0.95" marker-end="url(#arr)"/>`;
    })
    .join("");

  const nodeCircles = positions
    .map((p, i) => {
      const r = nodes[i];
      const short = r.name.slice(0, 8);
      const extract = r.extractionDecision.shouldExtract;
      const fill = extract ? nodePalette.extractFill : nodePalette.retainFill;
      return `
        <g>
          <circle cx="${p.x}" cy="${p.y}" r="14" fill="${fill}" fill-opacity="0.9" stroke="${nodePalette.stroke}" stroke-width="1.8"/>
          <text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="7" font-weight="700" fill="${nodePalette.label}">${esc(short)}</text>
        </g>`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:160px;border-radius:6px;background:linear-gradient(180deg,rgba(8,16,32,0.98),rgba(4,10,20,0.98));border:1px solid rgba(255,255,255,0.12)">
      <defs>
        <marker id="arr" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L0,8 L8,4 z" fill="var(--vscode-editor-foreground,#ffffff)" opacity="0.98"/>
        </marker>
      </defs>
      ${edgeLines}
      ${nodeCircles}
    </svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 2: Regions
// ─────────────────────────────────────────────────────────────────────────────

function renderRegions(plan: SplitPlan): string {
  if (plan.regions.length === 0) {
    return emptyState("No regions detected in this file.");
  }

  const rows = plan.regions
    .map((r) => {
      const m = r.metrics;
      const color = r.extractionDecision.shouldExtract
        ? "var(--vscode-editorWarning-foreground,#cca700)"
        : "var(--vscode-terminal-ansiGreen,#4caf50)";
      const kindBadge = `<span class="err-source">${esc(r.kind)}</span>`;
      const confPct = confidencePercent(r.extractionDecision.confidence);

      return `
        <div class="err-row ${r.extractionDecision.shouldExtract ? "sev-warn" : "sev-info"}">
          <div class="err-top">
            <span style="color:${color};flex-shrink:0">${I.region}</span>
            <span class="err-type">${esc(r.name)}</span>
            ${kindBadge}
            ${r.isDeadExport ? badge("DEAD EXPORT", "err") : ""}
            ${r.hasJSX ? badge("JSX", "info") : ""}
            ${r.hasHooks ? badge("HOOKS", "info") : ""}
            ${r.hasAsyncOps ? badge("ASYNC", "info") : ""}
          </div>
          <div class="err-loc">
            Lines ${r.startLine}–${r.endLine} &nbsp;·&nbsp;
            CC=${m.cyclomaticComplexity} &nbsp;·&nbsp;
            CogCC=${m.cognitiveComplexity} &nbsp;·&nbsp;
            MI=${m.maintainabilityIndex} &nbsp;·&nbsp;
            Depth=${m.nestingDepth} &nbsp;·&nbsp;
            Testability=${m.testabilityScore}
          </div>
          ${metricBar(m.maintainabilityIndex, 100, "var(--vscode-terminal-ansiGreen,#4caf50)")}
          ${
            r.extractionDecision.shouldExtract
              ? `<div class="err-fix">${I.extract} Extract → <code>${esc(r.extractionDecision.suggestedFileName)}</code> (${confPct}% confidence, ΔMI +${r.extractionDecision.miDelta})<br>${esc(r.extractionDecision.reasons.join(" · "))}</div>`
              : `<div style="font-size:10px;color:var(--vscode-descriptionForeground,#888);margin-top:3px">Retain in source file</div>`
          }
        </div>`;
    })
    .join("");

  return `<div class="panel-inner">${rows}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 3: Extraction candidates
// ─────────────────────────────────────────────────────────────────────────────

function renderExtract(plan: SplitPlan): string {
  if (plan.extractionCandidates.length === 0) {
    return emptyState("No extraction candidates — file is well-structured.");
  }

  const cards = plan.extractionCandidates
    .map((r, i) => {
      const pf = plan.proposedFiles[i];
      if (!pf) return "";
      const importLines = pf.resolvedImports
        .map(
          (l) =>
            `<div style="color:var(--vscode-terminal-ansiCyan,#4ec9b0);font-size:10px">${esc(l)}</div>`,
        )
        .join("");

      return `
        <div class="rc-block" style="margin:6px 12px">
          <div class="rc-block-title">
            ${I.extract}
            <span>${esc(r.name)}</span>
            <span class="err-source">${esc(r.kind)}</span>
            <span style="margin-left:auto">${badge(r.extractionDecision.confidence, "ok")}</span>
          </div>
          <div class="rc-row">
            <div class="rc-key">Target File</div>
            <div class="rc-val"><code>${esc(pf.fileName)}</code></div>
          </div>
          <div class="rc-row">
            <div class="rc-key">Reasons</div>
            <div class="rc-val">${esc(r.extractionDecision.reasons.join(" · "))}</div>
          </div>
          <div class="rc-row">
            <div class="rc-key">Metrics</div>
            <div class="rc-val">
              ${r.metrics.lineCount} lines · CC ${r.metrics.cyclomaticComplexity} · MI ${r.metrics.maintainabilityIndex} · ΔMI +${r.extractionDecision.miDelta}
            </div>
          </div>
          ${
            pf.resolvedImports.length > 0
              ? `
          <div class="rc-row">
            <div class="rc-key">Resolved Imports</div>
            <div style="padding:4px 8px">${importLines}</div>
          </div>`
              : ""
          }
          ${
            r.importedSymbols.length > 0
              ? `
          <div class="rc-row">
            <div class="rc-key">Depends On</div>
            <div class="rc-val">${esc(r.importedSymbols.join(", "))}</div>
          </div>`
              : ""
          }
          ${
            r.exportedSymbols.length > 0
              ? `
          <div class="rc-row">
            <div class="rc-key">Used By</div>
            <div class="rc-val">${esc(r.exportedSymbols.join(", "))}</div>
          </div>`
              : ""
          }
        </div>`;
    })
    .join("");

  return `<div class="panel-inner">${cards}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 4: Linkage
// ─────────────────────────────────────────────────────────────────────────────

function renderLinkage(plan: SplitPlan): string {
  if (plan.linkageMap.length === 0) {
    return emptyState("No cross-file linkages — regions are independent.");
  }

  const rows = plan.linkageMap
    .map((link) => {
      const circular = link.isCircular;
      const critical = link.isCriticalPath;

      return `
        <div class="err-row ${circular ? "sev-error" : critical ? "sev-warn" : "sev-info"}">
          <div class="err-top">
            ${circular ? I.cycle : I.arrow}
            <span class="err-type">${esc(link.from)}</span>
            <span style="opacity:.5">${I.arrow}</span>
            <span class="err-type">${esc(link.to)}</span>
            ${circular ? badge("CIRCULAR", "err") : ""}
            ${critical ? badge("CRITICAL PATH", "warn") : ""}
          </div>
          <div class="err-loc">
            Symbols: ${esc(link.symbols.join(", "))} &nbsp;·&nbsp; Weight: ${link.edgeWeight}
          </div>
          ${
            circular
              ? `<div class="err-fix" style="border-left-color:var(--vscode-editorError-foreground,#f14c4c)">
            ⚠ Circular dependency — split or introduce a shared abstraction to break the cycle
          </div>`
              : ""
          }
        </div>`;
    })
    .join("");

  const circularSummary =
    plan.circularRisks.length > 0
      ? `<div class="section-label">${I.cycle} Circular Risk Files (${plan.circularRisks.length})</div>
           <div style="padding:6px 12px;font-size:11px;color:var(--vscode-editorError-foreground,#f14c4c)">
             ${plan.circularRisks.map((r) => `<code>${esc(r)}</code>`).join("  ·  ")}
           </div>`
      : "";

  const criticalPath =
    plan.criticalPathFiles.length > 1
      ? `<div class="section-label">${I.warn} Critical Dependency Path</div>
           <div style="padding:6px 12px;font-size:11px">
             ${plan.criticalPathFiles.map((f) => `<code>${esc(f)}</code>`).join(" → ")}
           </div>`
      : "";

  return `<div class="panel-inner">${circularSummary}${criticalPath}<div class="section-label">${I.link} All Linkages</div>${rows}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 5: Smells (TS/JS + Framework)
// ─────────────────────────────────────────────────────────────────────────────

function renderSmells(plan: SplitPlan): string {
  const allSmellCount =
    plan.codeSmells.length + (plan.frameworkSmells?.length ?? 0);
  if (allSmellCount === 0) {
    return emptyState("No code smells detected — excellent code quality!");
  }

  const sorted = [...plan.codeSmells].sort((a, b) => {
    const rank: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      info: 0,
    };
    return (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0);
  });

  const tsRows = sorted
    .map(
      (smell) => `
      <div class="err-row sev-${smell.severity === "critical" || smell.severity === "high" ? "error" : smell.severity === "medium" ? "warn" : "info"}">
        <div class="err-top">
          ${smell.severity === "critical" ? I.critical : I.smell}
          <span class="err-type">${esc(smell.name)}</span>
          ${severityBadge(smell.severity)}
          ${smell.autoFixable ? badge("AUTO-FIX", "ok") : ""}
        </div>
        <div class="err-loc">${esc(smell.description)}</div>
        <div class="err-fix">${I.check} ${esc(smell.recommendation)}</div>
      </div>`,
    )
    .join("");

  // Framework smells section
  const fwSmells = plan.frameworkSmells ?? [];
  const fwRows =
    fwSmells.length > 0
      ? `
      <div class="section-label">${I.smell} ${esc((plan.detectedFramework ?? "framework").toUpperCase())} Smells (${fwSmells.length})</div>
      ${fwSmells
        .map((smell) => {
          const fwColor =
            smell.framework === "vue"
              ? "#41b883"
              : smell.framework === "angular"
                ? "#dd1b16"
                : "#ff3e00";
          return `
      <div class="err-row sev-${smell.severity === "critical" || smell.severity === "high" ? "error" : smell.severity === "medium" ? "warn" : "info"}">
        <div class="err-top">
          ${smell.severity === "critical" ? I.critical : I.smell}
          <span class="err-type">${esc(smell.name)}</span>
          ${severityBadge(smell.severity)}
          <span class="s-badge" style="background:${fwColor}20;color:${fwColor};border-color:${fwColor}40">${esc(smell.framework.toUpperCase())}</span>
          ${smell.autoFixable ? badge("AUTO-FIX", "ok") : ""}
        </div>
        <div class="err-loc">${esc(smell.description)}</div>
        <div class="err-fix">${I.check} ${esc(smell.recommendation)}</div>
      </div>`;
        })
        .join("")}`
      : "";

  const tsSection = tsRows
    ? `<div class="section-label">${I.smell} Code Smells (${plan.codeSmells.length})</div>${tsRows}`
    : "";

  // Merge suggestions section
  const merges = plan.mergeSuggestions ?? [];
  const mergeSection =
    merges.length > 0
      ? `
      <div class="section-label">${I.link} Workspace Merge Suggestions</div>
      ${merges
        .map(
          (ms) => `
        <div class="rc-block" style="margin:4px 12px">
          <div class="rc-block-title">${I.arrow} <span>${esc(ms.regionName)}</span> <span class="err-source">merge candidate</span></div>
          ${ms.suggestions
            .map(
              (s, i) => `
            <div class="rc-row" style="${i < ms.suggestions.length - 1 ? "border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.1))" : ""}">
              <div class="rc-key">Option ${i + 1} — ${Math.round(s.score * 100)}% match</div>
              <div class="rc-val">
                <code>${esc(s.targetRelPath)}</code><br>
                <span style="font-size:10px;opacity:.7">${esc(s.reasons.join(" · "))}</span>
                ${s.wouldExceedLimit ? `<br><span style="color:var(--vscode-editorWarning-foreground,#cca700);font-size:10px">⚠ Would push target over 200 lines</span>` : ""}
                ${s.sharedSymbols.length > 0 ? `<br><span style="font-size:10px;color:var(--vscode-terminal-ansiCyan,#4ec9b0)">Shared: ${esc(s.sharedSymbols.join(", "))}</span>` : ""}
              </div>
            </div>`,
            )
            .join("")}
        </div>`,
        )
        .join("")}`
      : "";

  return `<div class="panel-inner">${tsSection}${fwRows}${mergeSection}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 6: Tests
// ─────────────────────────────────────────────────────────────────────────────

function renderTests(plan: SplitPlan): string {
  if (plan.testFileSuggestions.length === 0) {
    return emptyState("No test suggestions — extract regions first.");
  }

  const cards = plan.testFileSuggestions
    .map((t) => {
      const testLines = t.suggestedTests
        .map(
          (s) =>
            `<div style="font-size:10px;padding:2px 0;color:var(--vscode-terminal-ansiGreen,#4caf50)">${I.check} ${esc(s)}</div>`,
        )
        .join("");

      const mockLines = t.mockImports
        .map(
          (m) =>
            `<div style="font-size:10px;color:var(--vscode-terminal-ansiCyan,#4ec9b0)">${esc(m)}</div>`,
        )
        .join("");

      return `
        <div class="rc-block" style="margin:6px 12px">
          <div class="rc-block-title">${I.test} <span>${esc(t.testFile)}</span> ${badge(t.framework.toUpperCase(), "info")}</div>
          <div class="rc-row">
            <div class="rc-key">Source</div>
            <div class="rc-val"><code>${esc(t.sourceFile)}</code></div>
          </div>
          <div class="rc-row">
            <div class="rc-key">Suggested Tests</div>
            <div style="padding:4px 8px">${testLines || '<span style="opacity:.5">No suggestions</span>'}</div>
          </div>
          ${
            mockLines
              ? `<div class="rc-row">
            <div class="rc-key">Mock Imports</div>
            <div style="padding:4px 8px">${mockLines}</div>
          </div>`
              : ""
          }
        </div>`;
    })
    .join("");

  const barrelBlock = `
      <div class="section-label">${I.files} Barrel Export (index.ts)</div>
      <div class="rc-block" style="margin:6px 12px">
        <div class="rc-row">
          <pre class="rc-code">${esc(plan.barrelExport)}</pre>
        </div>
      </div>`;

  return `<div class="panel-inner">${cards}${barrelBlock}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 7: Generated Files Preview
// ─────────────────────────────────────────────────────────────────────────────

function renderFiles(plan: SplitPlan): string {
  if (plan.proposedFiles.length === 0) {
    return emptyState("No files proposed — nothing to extract.");
  }

  const cards = plan.proposedFiles
    .map((pf) => {
      const preview = pf.generatedContent.split("\n").slice(0, 30).join("\n");
      return `
        <div class="rc-block" style="margin:6px 12px">
          <div class="rc-block-title">
            ${I.files} <span>${esc(pf.fileName)}</span>
            <span style="margin-left:auto;font-size:10px;opacity:.6">${pf.estimatedLines} lines</span>
          </div>
          ${
            pf.linkedTo.length > 0
              ? `<div class="rc-row">
            <div class="rc-key">Imports From</div>
            <div class="rc-val">${pf.linkedTo.map((t) => `<code>${esc(t)}</code>`).join(", ")}</div>
          </div>`
              : ""
          }
          ${
            pf.linkedFrom.length > 0
              ? `<div class="rc-row">
            <div class="rc-key">Imported By</div>
            <div class="rc-val">${pf.linkedFrom.map((t) => `<code>${esc(t)}</code>`).join(", ")}</div>
          </div>`
              : ""
          }
          <div class="rc-row">
            <div class="rc-key">Preview</div>
            <pre class="rc-code" style="max-height:200px;overflow:auto">${esc(preview)}</pre>
          </div>
          <div class="rc-row">
            <div class="rc-key">Test File</div>
            <div class="rc-val"><code>${esc(pf.testFilePath)}</code></div>
          </div>
        </div>`;
    })
    .join("");

  return `<div class="panel-inner">${cards}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 8: Dry Run — with Apply button
// ─────────────────────────────────────────────────────────────────────────────

function renderDryRun(plan: SplitPlan): string {
  const updatedPreview = plan.updatedSourceContent
    .split("\n")
    .slice(0, 40)
    .join("\n");
  const hasFiles = plan.proposedFiles.length > 0;

  const applyBtn = hasFiles
    ? `
      <div style="padding:10px 12px 4px;display:flex;gap:8px;align-items:center">
        <button class="apply-btn" onclick="applyPlan()">
          ${I.check} Apply Split — Create ${plan.proposedFiles.length} File${plan.proposedFiles.length !== 1 ? "s" : ""}
        </button>
        <span style="font-size:10px;color:var(--vscode-descriptionForeground,#777)">
          Single Ctrl+Z to undo everything
        </span>
      </div>`
    : "";

  const fileList = plan.proposedFiles
    .map(
      (pf) => `
      <div class="rc-row" style="font-family:var(--vscode-editor-font-family,monospace);font-size:11px">
        <span style="color:var(--vscode-terminal-ansiGreen,#4caf50)">+ </span>
        <code>${esc(pf.fileName)}</code>
        <span style="opacity:.5;margin-left:8px">${pf.estimatedLines} lines</span>
      </div>`,
    )
    .join("");

  return `
    <div class="panel-inner">
      ${applyBtn}
      <div class="section-label">${I.dryrun} Files That Will Be Created (${plan.proposedFiles.length})</div>
      ${
        hasFiles
          ? `<div class="rc-block" style="margin:0 12px 8px">${fileList}</div>`
          : `<div style="padding:8px 12px;font-size:11px;color:var(--vscode-descriptionForeground,#777)">No extractions — file is already well-structured.</div>`
      }
      <div class="section-label">${I.files} Updated Source File Preview (first 40 lines)</div>
      <div class="rc-block" style="margin:0 12px 8px">
        <div class="rc-row">
          <pre class="rc-code" style="max-height:300px;overflow:auto">${esc(updatedPreview)}</pre>
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────────────────────

function emptyState(msg: string): string {
  return `<div class="state-placeholder">${I.check}<p>${esc(msg)}</p></div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);font-size:var(--vscode-font-size,13px);background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-sideBar-foreground,var(--vscode-foreground,#cccccc));line-height:1.4;overflow-x:hidden;height:100vh;display:flex;flex-direction:column}
a{color:var(--vscode-textLink-foreground,#3794ff);text-decoration:none}
pre,code{font-family:var(--vscode-editor-font-family,'Consolas','Courier New',monospace);font-size:calc(var(--vscode-font-size,13px) - 1px)}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(100,100,100,.4));border-radius:3px}

/* Accent bar */
.accent-bar{height:2px;flex-shrink:0;background:linear-gradient(90deg,var(--vscode-focusBorder,#007acc) 0%,var(--vscode-terminal-ansiCyan,#29b8db) 60%,transparent 100%);opacity:.75}

/* Header */
.header{display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 12px;height:38px;flex-shrink:0;background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,.04));border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.18));position:sticky;top:0;z-index:20}
.header-left{display:flex;align-items:center;gap:7px;overflow:hidden}
.header-icon{color:var(--vscode-focusBorder,#007acc);flex-shrink:0;display:flex;align-items:center}
.header-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--vscode-sideBarTitle-foreground,var(--vscode-foreground,#d0d0d0));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-right{display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap}

/* Summary strip */
.summary-strip{display:flex;align-items:center;gap:5px;padding:5px 12px;background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,.03));border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.1));flex-shrink:0;flex-wrap:wrap}
.s-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;border:1px solid transparent}
.s-badge.err {background:rgba(241,76,76,.12);color:var(--vscode-editorError-foreground,#f88070);border-color:rgba(241,76,76,.2)}
.s-badge.warn{background:rgba(204,167,0,.12);color:var(--vscode-editorWarning-foreground,#cca700);border-color:rgba(204,167,0,.2)}
.s-badge.ok  {background:rgba(76,175,80,.1);color:var(--vscode-terminal-ansiGreen,#4caf50);border-color:rgba(76,175,80,.2)}
.s-badge.info{background:rgba(55,148,255,.1);color:var(--vscode-editorInfo-foreground,#3794ff);border-color:rgba(55,148,255,.2)}

/* Tab radio */
.tab-radio{display:none}
.tabs{display:grid;grid-template-columns:repeat(8);grid-auto-rows:minmax(34px,auto);background:var(--vscode-sideBar-background,#1e1e1e);border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.18));flex-shrink:0;padding:0 2px 2px;gap:1px}
.tab{width:100%;display:flex;align-items:center;justify-content:center;gap:3px;padding:7px 4px 6px;font-size:10px;font-weight:500;color:var(--vscode-tab-inactiveForeground,#888);background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;min-width:0;letter-spacing:.01em}
.tab svg{flex-shrink:0;opacity:.7}.tab span{overflow:hidden;text-overflow:ellipsis}
.tab:hover{color:var(--vscode-foreground,#ccc)}

@media (max-width: 900px){
  .tabs{grid-template-columns:repeat(4,minmax(0,1fr))}
}

@media (max-width: 560px){
  .tabs{grid-template-columns:3fr}
}

/* Panels */
.panels{flex:1;overflow:hidden;position:relative}
.panel{display:none;flex-direction:column;height:100%;overflow-y:auto}
.panel-inner{display:flex;flex-direction:column;gap:0;padding:4px 0 16px}

/* Section label */
.section-label{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--vscode-descriptionForeground,#777);padding:10px 12px 5px;display:flex;align-items:center;gap:7px}
.section-label::after{content:'';flex:1;height:1px;background:var(--vscode-panel-border,rgba(127,127,127,.1));border-radius:1px}

/* Row cards */
.err-row{display:flex;flex-direction:column;padding:8px 12px 8px 14px;cursor:default;border-left:2px solid transparent;border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.07));transition:background .1s;position:relative}
.err-row:last-child{border-bottom:none}
.err-row:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.04))}
.err-row.sev-error{border-left-color:var(--vscode-editorError-foreground,#f14c4c)}
.err-row.sev-warn {border-left-color:var(--vscode-editorWarning-foreground,#cca700)}
.err-row.sev-info {border-left-color:var(--vscode-editorInfo-foreground,#3794ff)}
.err-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.err-type{font-size:11px;font-weight:600;color:var(--vscode-foreground,#d4d4d4);flex-shrink:0}
.err-source{font-size:10px;padding:0 6px;border-radius:10px;background:var(--vscode-badge-background,rgba(127,127,127,.2));color:var(--vscode-badge-foreground,#aaa);flex-shrink:0;font-weight:500}
.err-loc{display:flex;align-items:center;flex-wrap:wrap;gap:3px;font-size:10px;color:var(--vscode-descriptionForeground,#777);margin:3px 0 2px}
.err-fix{font-size:11px;color:var(--vscode-terminal-ansiGreen,#4ec9b0);background:rgba(78,201,176,.06);border:1px solid rgba(78,201,176,.2);border-left:2px solid var(--vscode-terminal-ansiGreen,#4ec9b0);border-radius:3px;padding:5px 8px;margin:5px 0 3px;line-height:1.45}

/* Detail blocks */
.rc-block{margin:0 12px 8px;background:var(--vscode-sideBar-background,#1e1e1e);border:1px solid var(--vscode-panel-border,rgba(127,127,127,.18));border-radius:6px;overflow:hidden}
.rc-block-title{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.03em;color:var(--vscode-foreground,#d4d4d4);background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,.05));border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.18));padding:9px 12px}
.rc-row{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.08));font-size:11px}
.rc-row:last-child{border-bottom:none}
.rc-key{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground,#777);margin-bottom:4px}
.rc-val{color:var(--vscode-foreground,#ccc);line-height:1.4}
.rc-code{font-family:var(--vscode-editor-font-family,'Consolas','Courier New',monospace);font-size:10px;background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.08));color:var(--vscode-editor-foreground,#d4d4d4);border:1px solid var(--vscode-panel-border,rgba(127,127,127,.15));padding:8px 10px;border-radius:4px;overflow:auto;line-height:1.55;white-space:pre}

/* Metric grid */
.metric-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px;padding:4px 12px 8px}
.metric-card{background:rgba(127,127,127,.05);border:1px solid var(--vscode-panel-border,rgba(127,127,127,.15));border-radius:6px;padding:8px 10px}
.metric-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--vscode-descriptionForeground,#777)}
.metric-value{font-size:17px;font-weight:700;color:var(--vscode-foreground,#d4d4d4);margin-top:2px}

/* Health grade */
.health-grade{font-size:64px;font-weight:900;text-align:center;letter-spacing:-2px;padding:8px 0 4px;line-height:1}

/* Apply button */
.apply-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;font-size:12px;font-weight:700;font-family:inherit;letter-spacing:.03em;color:#fff;background:var(--vscode-focusBorder,#007acc);border:none;border-radius:5px;cursor:pointer;transition:opacity .15s,transform .1s}
.apply-btn:hover{opacity:.88}
.apply-btn:active{transform:scale(.97)}
.apply-btn svg{flex-shrink:0}

/* State placeholder */
.state-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:44px 20px;color:var(--vscode-descriptionForeground,#6e6e6e);text-align:center}
.state-placeholder p{font-size:12px;font-weight:500;line-height:1.5;color:var(--vscode-foreground,#ccc);opacity:.7}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Main render function
// ─────────────────────────────────────────────────────────────────────────────

export function renderSplitPlanHtml(plan: SplitPlan): string {
  const shortName = plan.sourceFile.split(/[\\/]/).pop() ?? plan.sourceFile;
  const tabs = makeTabs(plan);
  const m = plan.metrics;

  const tabContents: Record<string, string> = {
    overview: renderOverview(plan),
    regions: renderRegions(plan),
    extract: renderExtract(plan),
    linkage: renderLinkage(plan),
    smells: renderSmells(plan),
    tests: renderTests(plan),
    files: renderFiles(plan),
    dryrun: renderDryRun(plan),
  };

  const dynCSS = tabs
    .map(
      (t) =>
        `#tab-${t.id}:checked~.tabs label[for="tab-${t.id}"]{color:var(--vscode-tab-activeForeground,#fff);border-bottom-color:var(--vscode-focusBorder,#007acc)}` +
        `#tab-${t.id}:checked~.tabs label[for="tab-${t.id}"] svg{opacity:1}` +
        `#tab-${t.id}:checked~.panels #panel-${t.id}{display:flex}`,
    )
    .join("\n");

  const radioInputs = tabs
    .map(
      (t, i) =>
        `<input type="radio" name="tabs" id="tab-${t.id}" class="tab-radio"${i === 0 ? " checked" : ""}>`,
    )
    .join("");

  const tabLabels = tabs
    .map(
      (t) =>
        `<label for="tab-${t.id}" class="tab">
           ${t.icon}
           <span>${esc(t.label)}${
             t.count !== undefined
               ? ` <span class="s-badge info" style="font-size:8px;padding:0 4px">${t.count}</span>`
               : ""
           }</span>
         </label>`,
    )
    .join("");

  const panels = tabs
    .map(
      (t) =>
        `<div id="panel-${t.id}" class="panel">${tabContents[t.id] ?? ""}</div>`,
    )
    .join("");

  const healthClr = healthColor(m.overallHealth as HealthGrade);

  const astBadge =
    plan.parseEngine === "typescript-ast"
      ? badge("AST", "ok")
      : badge("FALLBACK", "warn");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none';">
<title>ASTra v3 — ${esc(shortName)}</title>
<style>${CSS}\n${dynCSS}</style>
</head>
<body>
${radioInputs}
<div class="accent-bar"></div>
<div class="header">
  <div class="header-left">
    <span class="header-icon">${I.split}</span>
    <span class="header-title">${esc(shortName)}</span>
    <span class="err-source">${esc(plan.language)}</span>
  </div>
  <div class="header-right">
    <span class="s-badge" style="color:${healthClr};border-color:${healthClr}20;background:${healthClr}12">
      ${m.overallHealth}
    </span>
    <span class="s-badge ${m.avgCyclomaticComplexity > 10 ? "err" : m.avgCyclomaticComplexity > 7 ? "warn" : "ok"}">
      CC ${m.avgCyclomaticComplexity}
    </span>
    ${plan.circularRisks.length > 0 ? badge(`${I.cycle} Circular`, "err") : ""}
    ${astBadge}
    ${
      plan.proposedFiles.length > 0
        ? `<button class="apply-btn" onclick="applyPlan()" style="padding:4px 12px;font-size:11px">${I.check} Apply (${plan.proposedFiles.length})</button>`
        : ""
    }
  </div>
</div>
<div class="summary-strip">
  <span class="s-badge ok">${I.metric} MI ${m.maintainabilityIndex}/100</span>
  <span class="s-badge ${plan.summary.extractionCount > 0 ? "warn" : "ok"}">${I.split} ${plan.summary.extractionCount} to extract</span>
  <span class="s-badge ok">${I.check} ${plan.summary.retainedCount} retained</span>
  ${
    plan.codeSmells.length + (plan.frameworkSmells?.length ?? 0) > 0
      ? badge(
          `${I.smell} ${plan.codeSmells.length + (plan.frameworkSmells?.length ?? 0)} smell${plan.codeSmells.length + (plan.frameworkSmells?.length ?? 0) !== 1 ? "s" : ""}`,
          plan.codeSmells.some((s) => s.severity === "critical")
            ? "err"
            : "warn",
        )
      : ""
  }
  <span class="s-badge info">${I.metric} ${formatMinutes(m.technicalDebtMinutes)} debt</span>
</div>
<div class="tabs">${tabLabels}</div>
<div class="panels">${panels}</div>
<script>
const vscode = acquireVsCodeApi();
function applyPlan() {
    vscode.postMessage({ command: 'apply' });
}
</script>
</body>
</html>`;
}
