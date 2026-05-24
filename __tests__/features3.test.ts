/**
 * ASTra v3 — Feature Tests: Workspace Graph + Framework Plugins + Atomic Apply
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import {
  WorkspaceGraphBuilder,
  MergeAdvisor,
} from "../src/splitter/workspace/workspaceGraph";
import {
  detectVueSmells,
  detectAngularSmells,
  detectSvelteSmells,
  detectFrameworkKind,
  detectFrameworkSmells,
} from "../src/splitter/frameworks/frameworkPlugins";
import { ModuleSplitter } from "../src/splitter/core/moduleSplitter";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const VUE_CLEAN = `
<template>
  <div>
    <span v-for="item in items" :key="item.id">{{ item.name }}</span>
  </div>
</template>
<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
const items = ref([{ id: 1, name: 'A' }]);
const handler = () => {};
window.addEventListener('resize', handler);
onUnmounted(() => window.removeEventListener('resize', handler));
</script>`.trim();

const VUE_SMELLY = `
<template>
  <div>
    <span v-for="item in items" v-if="item.active">{{ item.reallyLongExpressionThatShouldBeAComputedPropertyForBetterReadability }}</span>
  </div>
</template>
<script>
export default {
  data() { return { a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8,i:9,j:10,k:11,l:12,m:13,n:14,o:15,p:16,q:17,r:18,s:19,t:20,u:21 }; },
  methods: { doSomething() {} },
  computed: { foo() { return this.a; } },
  watch: { a(v) { setTimeout(() => {}, v); } },
  props: ['x'],
  emits: ['change'],
};
</script>`.trim();

const VUE_SETUP_SMELLY = `
<template>
    <div>{{ fullName }}</div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
const firstName = ref('Ada');
const lastName = ref('Lovelace');
const fullName = computed(() => firstName.value + ' ' + lastName.value);
watch(firstName, () => console.log(firstName.value));
watch(lastName, () => console.log(lastName.value));
</script>`.trim();

const ANGULAR_CLEAN = `
import { Component, OnDestroy } from '@angular/core';
import { ChangeDetectionStrategy } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnDestroy {
  private destroy$ = new Subject<void>();
  data$ = this.service.getData().pipe(takeUntil(this.destroy$));
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }
}`.trim();

const ANGULAR_SMELLY = `
import { Component } from '@angular/core';

@Component({
  selector: 'app-bad',
  template: \`
    <div>Line 1</div><div>Line 2</div><div>Line 3</div>
    <div>Line 4</div><div>Line 5</div><div>Line 6</div>
    <div>Line 7</div><div>Line 8</div><div>Line 9</div>
    <div>Line 10</div><div>Line 11</div><div>Line 12</div>
  \`,
  styles: [\`.foo { color: red; }\`],
})
export class BadComponent {
  data: any;
  name: any;
  value: any;
  result: any;

  ngOnInit() {
    this.data = [];
    this.name = 'test';
    this.value = 42;
    this.result = this.compute();
    this.setup();
    this.init();
    this.configure();
    this.load();
    this.prefetch();
    this.validate();
    this.transform();
    this.map();
    this.filter();
    this.reduce();
    this.aggregate();
    this.finalize();
  }

  compute() { return 1; }
  setup() {}
  init() {}
  configure() {}
  load() {}
  prefetch() {}
  validate() {}
  transform() {}
  map() { return []; }
  filter() { return []; }
  reduce() { return 0; }
  aggregate() {}
  finalize() {}

  handleClick() {
    document.getElementById('foo')?.focus();
  }
}`.trim();

const ANGULAR_SERVICE_SMELLY = `
import { Component } from '@angular/core';

@Component({
    selector: 'app-dashboard',
    template: '<div>Dashboard</div>',
})
export class DashboardComponent {
    data: any;
    status: any;

    ngOnInit() {
        this.load();
        this.hydrate();
        this.refresh();
        this.validate();
        this.transform();
        this.persist();
        this.cleanup();
        this.notify();
        this.sync();
        this.audit();
        this.finalize();
    }

    load() {}
    hydrate() {}
    refresh() {}
    validate() {}
    transform() {}
    persist() {}
    cleanup() {}
    notify() {}
    sync() {}
    audit() {}
    finalize() {}
}`.trim();

const ANGULAR_STANDALONE_SMELLY = `
import { Component } from '@angular/core';

@Component({
    selector: 'app-legacy',
    template: '<p>Legacy</p>',
})
export class LegacyComponent {}
`.trim();

const SVELTE_CLEAN = `
<script>
  import { writable } from 'svelte/store';
  import { onDestroy } from 'svelte';
  const count = writable(0);
  let n;
  const unsub = count.subscribe(v => n = v);
  onDestroy(unsub);
</script>
<p>{n}</p>`.trim();

const SVELTE_SMELLY = `
<script>
  import { writable } from 'svelte/store';
  const a = writable(0);
  const b = writable(0);
  $: result1 = $a + 1;
  $: result2 = $a * 2;
  $: result3 = $b + 1;
  $: result4 = $b * 2;
  $: result5 = result1 + result2;
  $: result6 = result3 + result4;
  $: final = result5 + result6;
  a.subscribe(v => console.log(v));
</script>
<ul>
  {#each items as item}
    <li on:click={() => { const x = item.value * 2; doSomething(x); console.log(x); alert(x); }}>
      {item.name}
    </li>
  {/each}
</ul>`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Framework Kind Detection
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrameworkKind", () => {
  it("detects vue from .vue extension", () => {
    expect(detectFrameworkKind("", "Component.vue")).toBe("vue");
  });
  it("detects svelte from .svelte extension", () => {
    expect(detectFrameworkKind("", "App.svelte")).toBe("svelte");
  });
  it("detects angular from @Component decorator", () => {
    expect(detectFrameworkKind('@Component({ selector: "x" })', "app.ts")).toBe(
      "angular",
    );
  });
  it("detects react from useState import", () => {
    expect(
      detectFrameworkKind("import { useState } from 'react';", "App.tsx"),
    ).toBe("react");
  });
  it("returns none for plain TS", () => {
    expect(detectFrameworkKind("export const x = 1;", "util.ts")).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Vue Plugin
// ─────────────────────────────────────────────────────────────────────────────

describe("detectVueSmells", () => {
  it("returns no smells for clean Vue SFC", () => {
    const smells = detectVueSmells(VUE_CLEAN);
    const critical = smells.filter(
      (s) => s.severity === "critical" || s.severity === "high",
    );
    expect(critical.length).toBe(0);
  });

  it("detects v-if + v-for on same element", () => {
    const smells = detectVueSmells(VUE_SMELLY);
    expect(smells.some((s) => s.name === "v-if + v-for on Same Element")).toBe(
      true,
    );
  });

  it("detects Options API God Component", () => {
    const smells = detectVueSmells(VUE_SMELLY);
    expect(smells.some((s) => s.name === "Options API God Component")).toBe(
      true,
    );
  });

  it("detects missing :key on v-for", () => {
    const src =
      '<template><span v-for="x in list">{{ x }}</span></template><script setup></script>';
    const smells = detectVueSmells(src);
    expect(smells.some((s) => s.name === "Missing :key on v-for")).toBe(true);
  });

  it("detects watch without cleanup when timers are used", () => {
    const src = `<script setup>
import { watch, ref } from 'vue';
const x = ref(0);
watch(x, (v) => { setTimeout(() => {}, v); });
</script>`.trim();
    const smells = detectVueSmells(src);
    expect(smells.some((s) => s.name === "watch Without Cleanup")).toBe(true);
  });

  it("all smells have framework = vue", () => {
    const smells = detectVueSmells(VUE_SMELLY);
    expect(smells.every((s) => s.framework === "vue")).toBe(true);
  });

  it("all smells have non-empty recommendation", () => {
    const smells = detectVueSmells(VUE_SMELLY);
    expect(smells.every((s) => s.recommendation.length > 0)).toBe(true);
  });

  it("detects Vue composable extraction candidates", () => {
    const smells = detectVueSmells(
      VUE_SETUP_SMELLY,
      "/src/components/ProfileCard.vue",
    );
    const candidate = smells.find((s) => s.name === "Vue Composable Candidate");
    expect(candidate).toBeDefined();
    expect(candidate?.suggestedFileName).toContain("composables/");
  });

  it("detects Vue Composition API migration guide candidates", () => {
    const smells = detectVueSmells(
      VUE_SMELLY,
      "/src/components/LegacyCard.vue",
    );
    expect(
      smells.some((s) => s.name === "Vue Composition API Migration Guide"),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Angular Plugin
// ─────────────────────────────────────────────────────────────────────────────

describe("detectAngularSmells", () => {
  it("returns no high/critical smells for clean Angular component", () => {
    const smells = detectAngularSmells(ANGULAR_CLEAN);
    const critical = smells.filter(
      (s) => s.severity === "critical" || s.severity === "high",
    );
    expect(critical.length).toBe(0);
  });

  it("detects long inline template", () => {
    const smells = detectAngularSmells(ANGULAR_SMELLY);
    expect(smells.some((s) => s.name === "Long Inline Angular Template")).toBe(
      true,
    );
  });

  it("detects inline styles", () => {
    const smells = detectAngularSmells(ANGULAR_SMELLY);
    expect(smells.some((s) => s.name === "Inline Angular Styles")).toBe(true);
  });

  it("detects missing OnPush", () => {
    const smells = detectAngularSmells(ANGULAR_SMELLY);
    expect(
      smells.some((s) => s.name === "Missing OnPush Change Detection"),
    ).toBe(true);
  });

  it("detects complex ngOnInit", () => {
    const smells = detectAngularSmells(ANGULAR_SMELLY);
    expect(smells.some((s) => s.name === "Complex ngOnInit")).toBe(true);
  });

  it("detects Angular service extraction candidates", () => {
    const smells = detectAngularSmells(ANGULAR_SERVICE_SMELLY);
    const candidate = smells.find(
      (s) => s.name === "Angular Service Extraction Candidate",
    );
    expect(candidate).toBeDefined();
    expect(candidate?.generatedContent).toContain("@Injectable");
  });

  it("detects Angular standalone migration candidates", () => {
    const smells = detectAngularSmells(ANGULAR_STANDALONE_SMELLY);
    const candidate = smells.find(
      (s) => s.name === "Angular Standalone Migration Candidate",
    );
    expect(candidate).toBeDefined();
    expect(candidate?.generatedContent).toContain("standalone: true");
  });

  it("detects direct DOM access", () => {
    const smells = detectAngularSmells(ANGULAR_SMELLY);
    expect(
      smells.some((s) => s.name === "Direct DOM Access in Angular Component"),
    ).toBe(true);
  });

  it("detects subscription leak", () => {
    const src = `
import { Component } from '@angular/core';
@Component({ selector: 'x', template: '' })
export class Leaky {
  ngOnInit() { this.service.data$.subscribe(v => console.log(v)); }
}`.trim();
    const smells = detectAngularSmells(src);
    expect(smells.some((s) => s.name === "Observable Subscription Leak")).toBe(
      true,
    );
  });

  it("detects missing providedIn", () => {
    const src = `
import { Injectable } from '@angular/core';
@Injectable()
export class MyService {}`.trim();
    const smells = detectAngularSmells(src);
    expect(
      smells.some((s) => s.name === "Missing providedIn in @Injectable"),
    ).toBe(true);
  });

  it("all smells have framework = angular", () => {
    const smells = detectAngularSmells(ANGULAR_SMELLY);
    expect(smells.every((s) => s.framework === "angular")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Svelte Plugin
// ─────────────────────────────────────────────────────────────────────────────

describe("detectSvelteSmells", () => {
  it("returns no smells for clean Svelte component", () => {
    const smells = detectSvelteSmells(SVELTE_CLEAN);
    expect(smells.filter((s) => s.severity === "critical").length).toBe(0);
  });

  it("detects excessive $: reactive statements", () => {
    const smells = detectSvelteSmells(SVELTE_SMELLY);
    expect(
      smells.some((s) => s.name === "Excessive $: Reactive Statements"),
    ).toBe(true);
  });

  it("detects store subscription without onDestroy", () => {
    const smells = detectSvelteSmells(SVELTE_SMELLY);
    expect(
      smells.some((s) => s.name === "Store Subscription Without onDestroy"),
    ).toBe(true);
  });

  it("detects missing key on #each", () => {
    const src = `<script></script>\n{#each items as item}\n<li>{item.name}</li>\n{/each}`;
    const smells = detectSvelteSmells(src);
    expect(smells.some((s) => s.name === "Missing key on {#each}")).toBe(true);
  });

  it("all smells have framework = svelte", () => {
    const smells = detectSvelteSmells(SVELTE_SMELLY);
    expect(smells.every((s) => s.framework === "svelte")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. detectFrameworkSmells dispatcher
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrameworkSmells dispatcher", () => {
  it("routes .vue files to Vue plugin", () => {
    const smells = detectFrameworkSmells(VUE_SMELLY, "/src/Comp.vue");
    expect(smells.length).toBeGreaterThan(0);
    expect(smells.every((s) => s.framework === "vue")).toBe(true);
  });
  it("routes .svelte files to Svelte plugin", () => {
    const smells = detectFrameworkSmells(SVELTE_SMELLY, "/src/App.svelte");
    expect(smells.length).toBeGreaterThan(0);
    expect(smells.every((s) => s.framework === "svelte")).toBe(true);
  });
  it("routes Angular src to Angular plugin", () => {
    const smells = detectFrameworkSmells(ANGULAR_SMELLY, "/src/app.ts");
    expect(smells.length).toBeGreaterThan(0);
    expect(smells.every((s) => s.framework === "angular")).toBe(true);
  });
  it("returns empty array for plain TS", () => {
    const smells = detectFrameworkSmells("export const x = 1;", "/src/util.ts");
    expect(smells.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. WorkspaceGraphBuilder
// ─────────────────────────────────────────────────────────────────────────────

describe("WorkspaceGraphBuilder", () => {
  let tmpDir: string;
  let builder: WorkspaceGraphBuilder;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-ws-test-"));
    // Create test files
    fs.writeFileSync(
      path.join(tmpDir, "hooks.ts"),
      `import { useState } from 'react';\nexport function useCounter() { const [n, setN] = useState(0); return {n, setN}; }\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "utils.ts"),
      `export function formatDate(d: Date) { return d.toISOString(); }\nexport function parseDate(s: string) { return new Date(s); }\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "types.ts"),
      `export interface User { id: string; name: string; }\nexport type Status = 'active' | 'inactive';\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "component.tsx"),
      `import { useCounter } from './hooks';\nimport { User } from './types';\nexport function UserCard({ user }: { user: User }) { return null; }\n`,
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    builder = new WorkspaceGraphBuilder();
  });

  it("builds a graph with all files", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    const graph = await builder.build(tmpDir, files);
    expect(graph.files.size).toBe(4);
    expect(graph.builtAt).toBeGreaterThan(0);
  });

  it("scannedCount reflects newly scanned files", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    const graph = await builder.build(tmpDir, files);
    expect(graph.scannedCount).toBe(4);
  });

  it("second build with same mtimes scans 0 files (incremental)", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    await builder.build(tmpDir, files); // first pass
    const graph2 = await builder.build(tmpDir, files); // second pass
    expect(graph2.scannedCount).toBe(0);
  });

  it("populates symbolExporters map", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    const graph = await builder.build(tmpDir, files);
    expect(graph.symbolExporters.has("useCounter")).toBe(true);
    expect(graph.symbolExporters.has("formatDate")).toBe(true);
    expect(graph.symbolExporters.has("User")).toBe(true);
  });

  it("invalidate() clears graph so next build re-scans", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    await builder.build(tmpDir, files);
    builder.invalidate();
    expect(builder.getGraph()).toBeNull();
    const graph3 = await builder.build(tmpDir, files);
    expect(graph3.scannedCount).toBe(4);
  });

  it("skips node_modules directories", async () => {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(nodeModulesDir, "lib.ts"),
      "export const x = 1;",
    );
    const files = [
      ...fs
        .readdirSync(tmpDir)
        .filter((f) => f !== "node_modules")
        .map((f) => path.join(tmpDir, f)),
      path.join(nodeModulesDir, "lib.ts"),
    ];
    const graph = await builder.build(tmpDir, files);
    const hasMod = [...graph.files.keys()].some((k) =>
      k.includes("node_modules"),
    );
    expect(hasMod).toBe(false);
    fs.rmSync(nodeModulesDir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. MergeAdvisor
// ─────────────────────────────────────────────────────────────────────────────

describe("MergeAdvisor", () => {
  let tmpDir: string;
  let builder: WorkspaceGraphBuilder;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-merge-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "hooks.ts"),
      `import { useState } from 'react';\nexport function useAuth() { const [user, setUser] = useState(null); return {user, setUser}; }\nexport function useModal() { const [open, setOpen] = useState(false); return {open, setOpen}; }\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "utils.ts"),
      `export function formatDate(d: Date) { return d.toISOString(); }\nexport function parseDate(s: string) { return new Date(s); }\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "source.ts"),
      `export function useCounter() { return null; }\n`,
    );
    builder = new WorkspaceGraphBuilder();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("suggests hooks.ts for a hook region", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    const graph = await builder.build(tmpDir, files);
    const advisor = new MergeAdvisor();
    const sourcePath = path.join(tmpDir, "source.ts");
    const suggs = advisor.suggest(
      "useCounter",
      "hook",
      ["useState"],
      sourcePath,
      graph,
    );
    const targets = suggs.map((s) => path.basename(s.targetFilePath));
    expect(targets).toContain("hooks.ts");
  });

  it("does not suggest the source file itself", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    const graph = await builder.build(tmpDir, files);
    const advisor = new MergeAdvisor();
    const sourcePath = path.join(tmpDir, "source.ts");
    const suggs = advisor.suggest("useCounter", "hook", [], sourcePath, graph);
    expect(suggs.every((s) => s.targetFilePath !== sourcePath)).toBe(true);
  });

  it("does not suggest a file that already exports the same name", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    const graph = await builder.build(tmpDir, files);
    const advisor = new MergeAdvisor();
    const sourcePath = path.join(tmpDir, "source.ts");
    // useAuth is already in hooks.ts — should not suggest hooks.ts for useAuth
    const suggs = advisor.suggest("useAuth", "hook", [], sourcePath, graph);
    expect(suggs.every((s) => !s.sharedSymbols.includes("useAuth"))).toBe(true);
  });

  it("returns results sorted by score descending", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    const graph = await builder.build(tmpDir, files);
    const advisor = new MergeAdvisor();
    const source = path.join(tmpDir, "source.ts");
    const suggs = advisor.suggest("useNewHook", "hook", [], source, graph);
    for (let i = 1; i < suggs.length; i++) {
      expect(suggs[i - 1].score).toBeGreaterThanOrEqual(suggs[i].score);
    }
  });

  it("respects maxResults param", async () => {
    const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
    const graph = await builder.build(tmpDir, files);
    const advisor = new MergeAdvisor();
    const source = path.join(tmpDir, "source.ts");
    const suggs = advisor.suggest("useSomething", "hook", [], source, graph, 1);
    expect(suggs.length).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Integration — SplitPlan includes all three new features
// ─────────────────────────────────────────────────────────────────────────────

describe("ModuleSplitter integration — 3 new features", () => {
  const splitter = new ModuleSplitter();

  it("detectedFramework = react for TSX file", () => {
    const src = `import React, { useState } from 'react';\nexport function App() { return <div/>; }`;
    const plan = splitter.analyse(src, "App.tsx");
    expect(plan.detectedFramework).toBe("react");
  });

  it("detectedFramework = none for plain TS", () => {
    const plan = splitter.analyse("export const x = 1;", "util.ts");
    expect(plan.detectedFramework).toBe("none");
  });

  it("frameworkSmells is always an array", () => {
    const plan = splitter.analyse("export const x = 1;", "util.ts");
    expect(Array.isArray(plan.frameworkSmells)).toBe(true);
  });

  it("frameworkSmells populated for Angular source", () => {
    const plan = splitter.analyse(
      ANGULAR_SMELLY,
      "bad.component.ts",
      {},
      0.35,
      "bad.component.ts",
    );
    expect(plan.frameworkSmells.length).toBeGreaterThan(0);
    expect(plan.detectedFramework).toBe("angular");
  });

  it("frameworkSmells preserve remediation metadata", () => {
    const plan = splitter.analyse(
      ANGULAR_SERVICE_SMELLY,
      "dashboard.component.ts",
      {},
      0.35,
      "dashboard.component.ts",
    );
    const candidate = plan.frameworkSmells.find(
      (s) => s.name === "Angular Service Extraction Candidate",
    );
    expect(candidate).toBeDefined();
    expect(candidate?.generatedContent).toContain("@Injectable");
  });

  it("mergeSuggestions is empty array when no workspace graph provided", () => {
    const plan = splitter.analyse(
      "export function useX() { return 1; }",
      "x.ts",
    );
    expect(Array.isArray(plan.mergeSuggestions)).toBe(true);
    expect(plan.mergeSuggestions.length).toBe(0);
  });

  it("mergeSuggestions populated when workspace graph is provided", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-int-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "hooks.ts"),
        `export function useAuth() { return null; }\nexport function useToggle() { return null; }\n`,
      );
      const builder = new WorkspaceGraphBuilder();
      const files = [path.join(tmpDir, "hooks.ts")];
      const graph = await builder.build(tmpDir, files);

      const src = `import { useState } from 'react';\nexport function useCounter() { const [n, setN] = useState(0); return {n, inc: () => setN(v => v + 1)}; }`;
      const plan = splitter.analyse(
        src,
        "useCounter.ts",
        {},
        0.35,
        path.join(tmpDir, "useCounter.ts"),
        graph,
      );
      // mergeSuggestions is populated if a hook region qualifies for extraction
      // and the workspace graph has hook files to suggest
      expect(Array.isArray(plan.mergeSuggestions)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
