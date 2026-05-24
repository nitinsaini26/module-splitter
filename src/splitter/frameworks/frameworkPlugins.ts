/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Framework Plugins                                                ║
 * ║                                                                              ║
 * ║  Extends smell detection to three additional frameworks:                    ║
 * ║                                                                              ║
 * ║  ▸ Vue 3 SFCs   — parses <script setup>, <template>, <style> blocks        ║
 * ║                   detects composable smells, missing defineProps,            ║
 * ║                   watch without cleanup, v-if + v-for abuse, etc.           ║
 * ║                                                                              ║
 * ║  ▸ Angular      — detects decorator smells (@Component with 500+ line       ║
 * ║                   templates, @Injectable providedIn abuse, missing          ║
 * ║                   OnDestroy for subscriptions, ngOnInit complexity, etc.)   ║
 * ║                                                                              ║
 * ║  ▸ Svelte       — detects reactive statement ($:) abuse, missing            ║
 * ║                   onDestroy for subscriptions, store misuse, etc.           ║
 * ║                                                                              ║
 * ║  API: each plugin exports detectSmells(source, filePath) → FrameworkSmell[] ║
 * ║  These are merged into the main CodeSmell[] in the SplitPlan.               ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type { Severity } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface FrameworkSmell {
  name: string;
  severity: Severity;
  description: string;
  recommendation: string;
  autoFixable: boolean;
  framework: "vue" | "angular" | "svelte";
  /** 1-based line number where the smell originates */
  line: number;
  suggestedFileName?: string;
  generatedContent?: string;
  remediationSteps?: string[];
}

function count(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

function toPascalCase(value: string): string {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/(^|[-_\s]+)([a-zA-Z0-9])/g, (_match, _sep, chr: string) =>
      chr.toUpperCase(),
    )
    .replace(/[^a-zA-Z0-9]/g, "");
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function vueComponentBaseName(filePath?: string): string {
  if (!filePath) return "Component";
  const base = filePath.split(/[\\/]/).pop() ?? "Component.vue";
  return toPascalCase(base) || "Component";
}

function angularClassName(src: string): string {
  const match = src.match(/export\s+class\s+([A-Za-z0-9_]+)/);
  return match?.[1] ?? "Component";
}

function buildComposablePreview(
  componentName: string,
  bindings: string[],
): string {
  const uniqueBindings = [...new Set(bindings)].slice(0, 6);
  const returnBlock = uniqueBindings.length
    ? `  return { ${uniqueBindings.join(", ")} };`
    : "  return {};";
  return [
    `export function use${componentName}() {`,
    "  // ASTra extracted related state and watchers into a composable.",
    returnBlock,
    "}",
  ].join("\n");
}

function buildAngularServicePreview(className: string): string {
  const serviceName =
    className.replace(/Component$/, "Service") || "ComponentService";
  return [
    "import { Injectable } from '@angular/core';",
    "",
    "@Injectable({ providedIn: 'root' })",
    `export class ${serviceName} {`,
    "  // Move data loading, orchestration, and transformation logic here.",
    "}",
  ].join("\n");
}

function buildAngularStandaloneGuide(className: string): string {
  return [
    `# Standalone migration guide for ${className}`,
    "",
    "1. Add standalone: true to the @Component decorator.",
    "2. Move module dependencies into the component imports array.",
    "3. Delete the NgModule declaration after the component compiles.",
    "4. Keep services injectable via providedIn: 'root' or feature providers.",
  ].join("\n");
}

function buildVueMigrationGuide(componentName: string): string {
  return [
    `# Vue Composition API migration guide for ${componentName}`,
    "",
    "1. Move data() state into ref() / reactive().",
    "2. Convert computed options into computed() declarations.",
    "3. Move watchers into watch() or watchEffect() with cleanup.",
    "4. Split repeated state or logic into useX() composables.",
    "5. Keep the template focused on presentation only.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// ── VUE 3 SFC PLUGIN ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface VueBlocks {
  scriptSetup: string;
  scriptLegacy: string;
  template: string;
  style: string;
}

function extractVueBlocks(src: string): VueBlocks {
  const scriptSetupM = src.match(
    /<script\s[^>]*setup[^>]*>([\s\S]*?)<\/script>/i,
  );
  const scriptLegacyM = src.match(
    /<script(?!\s[^>]*setup)[^>]*>([\s\S]*?)<\/script>/i,
  );
  const templateM = src.match(/<template>([\s\S]*?)<\/template>/i);
  const styleM = src.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return {
    scriptSetup: scriptSetupM?.[1] ?? "",
    scriptLegacy: scriptLegacyM?.[1] ?? "",
    template: templateM?.[1] ?? "",
    style: styleM?.[1] ?? "",
  };
}

export function detectVueSmells(
  src: string,
  filePath?: string,
): FrameworkSmell[] {
  const smells: FrameworkSmell[] = [];
  const { scriptSetup, scriptLegacy, template } = extractVueBlocks(src);
  const script = scriptSetup || scriptLegacy;
  const componentName = vueComponentBaseName(filePath);

  const composableBindings = [
    ...scriptSetup.matchAll(
      /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|computed|reactive|shallowRef|readonly)\s*\(/g,
    ),
  ].map((match) => match[1]);
  const watcherCount = count(scriptSetup, /\bwatch(?:Effect)?\s*\(/g);
  const extractedBindings = [...new Set(composableBindings)];

  if (
    extractedBindings.length >= 3 ||
    (extractedBindings.length >= 2 && watcherCount > 0)
  ) {
    const fileSlug = toKebabCase(componentName);
    smells.push({
      name: "Vue Composable Candidate",
      severity: "medium",
      description:
        "Related refs/computed/watchers are clustered in <script setup> and can be moved into a composable",
      recommendation: `Extract the shared state into composables/use-${fileSlug}.ts and return the grouped bindings from use${componentName}().`,
      autoFixable: false,
      framework: "vue",
      line: 1,
      suggestedFileName: `composables/use-${fileSlug}.ts`,
      generatedContent: buildComposablePreview(
        componentName,
        extractedBindings,
      ),
      remediationSteps: [
        "Group related refs/computed/watchers by feature boundary.",
        "Move the group into a new useX() composable.",
        "Import the composable back into the SFC and keep only view logic there.",
      ],
    });
  }

  // ── V3 Composition API smells ─────────────────────────────────────────────

  // Missing defineProps type annotation
  if (/defineProps\s*\(\s*\[/.test(script)) {
    smells.push({
      name: "Untyped defineProps",
      severity: "medium",
      description: "defineProps uses array syntax — loses type safety",
      recommendation:
        "Use defineProps<{ prop: Type }>() with TypeScript generic for full type safety",
      autoFixable: false,
      framework: "vue",
      line: 1,
    });
  }

  // watch without cleanup
  if (
    /\bwatch\s*\(/.test(script) &&
    !/onWatcherCleanup|onCleanup/.test(script)
  ) {
    if (/setTimeout|setInterval|fetch\(|addEventListener/.test(script)) {
      smells.push({
        name: "watch Without Cleanup",
        severity: "high",
        description:
          "watch callback uses async operations or timers but has no cleanup",
        recommendation:
          "Return a cleanup function from the watcher, or use watchEffect with onCleanup()",
        autoFixable: false,
        framework: "vue",
        line: 1,
      });
    }
  }

  // Missing onUnmounted cleanup for event listeners
  if (/addEventListener/.test(script) && !/onUnmounted/.test(script)) {
    smells.push({
      name: "addEventListener Without onUnmounted Cleanup",
      severity: "high",
      description:
        "Event listener added but no onUnmounted cleanup found — memory leak",
      recommendation:
        "Call removeEventListener inside onUnmounted(() => { ... })",
      autoFixable: false,
      framework: "vue",
      line: 1,
    });
  }

  // Options API smells (legacy)
  if (scriptLegacy) {
    const apiSections = [
      /\bdata\s*\(/.test(scriptLegacy),
      /\bmethods\s*:/.test(scriptLegacy),
      /\bcomputed\s*:/.test(scriptLegacy),
      /\bwatch\s*:/.test(scriptLegacy),
      /\bprops\s*:/.test(scriptLegacy),
      /\bemits\s*:/.test(scriptLegacy),
    ].filter(Boolean).length;

    if (apiSections >= 3) {
      smells.push({
        name: "Vue Composition API Migration Guide",
        severity: "medium",
        description:
          "Options API sections are present and the component is a good candidate for a step-by-step Composition API migration",
        recommendation:
          "Move state from data() into ref()/reactive(), migrate computed/watch blocks, and split repeated logic into composables.",
        autoFixable: false,
        framework: "vue",
        line: 1,
        suggestedFileName: `docs/${toKebabCase(componentName)}-composition-api.md`,
        generatedContent: buildVueMigrationGuide(componentName),
        remediationSteps: [
          "Translate data() properties into explicit refs.",
          "Replace computed/watch sections with Composition API calls.",
          "Extract shared logic into composables before migrating the template.",
        ],
      });
    }

    // Fat data() function
    const dataMatch = scriptLegacy.match(/data\s*\(\s*\)\s*\{([\s\S]*?)\}/);
    if (dataMatch && dataMatch[1].split("\n").length > 20) {
      smells.push({
        name: "Fat data() Function",
        severity: "medium",
        description:
          "data() returns many properties — hard to track reactivity",
        recommendation:
          "Migrate to Composition API with individual ref() / reactive() declarations",
        autoFixable: false,
        framework: "vue",
        line: 1,
      });
    }

    // God component (Options API)
    const apiCount = [
      /\bdata\s*\(/.test(scriptLegacy),
      /\bmethods\s*:/.test(scriptLegacy),
      /\bcomputed\s*:/.test(scriptLegacy),
      /\bwatch\s*:/.test(scriptLegacy),
      /\bprops\s*:/.test(scriptLegacy),
      /\bemits\s*:/.test(scriptLegacy),
    ].filter(Boolean).length;
    if (apiCount >= 5) {
      smells.push({
        name: "Options API God Component",
        severity: "critical",
        description: `Component uses ${apiCount}/6 Options API sections — high complexity`,
        recommendation:
          "Migrate to Composition API and extract composables for each concern",
        autoFixable: false,
        framework: "vue",
        line: 1,
      });
    }
  }

  // ── Template smells ───────────────────────────────────────────────────────

  // v-if and v-for on the same element
  if (/v-for[^>]+v-if|v-if[^>]+v-for/.test(template)) {
    smells.push({
      name: "v-if + v-for on Same Element",
      severity: "high",
      description:
        "v-if and v-for on the same element causes unnecessary re-evaluation",
      recommendation:
        "Wrap with <template v-for> and put v-if on the inner element, or filter the array in computed",
      autoFixable: false,
      framework: "vue",
      line: 1,
    });
  }

  // Direct mutation of props in template
  if (
    /\$emit\s*\(/.test(template) === false &&
    /\bprops\.\w+\s*=/.test(template)
  ) {
    smells.push({
      name: "Direct Prop Mutation in Template",
      severity: "critical",
      description: "Props are being mutated directly in the template",
      recommendation:
        'Emit an event to the parent to update the prop: emit("update:propName", newValue)',
      autoFixable: false,
      framework: "vue",
      line: 1,
    });
  }

  // Missing key on v-for
  if (
    /v-for/.test(template) &&
    !/v-for[^>]+:key|:key[^>]+v-for/.test(template)
  ) {
    smells.push({
      name: "Missing :key on v-for",
      severity: "medium",
      description: "v-for without :key causes inefficient DOM diffing",
      recommendation:
        'Always add :key with a unique identifier: <div v-for="item in list" :key="item.id">',
      autoFixable: false,
      framework: "vue",
      line: 1,
    });
  }

  // Heavy inline expressions
  if (count(template, /\{\{[^}]{60,}\}\}/g) > 2) {
    smells.push({
      name: "Heavy Inline Template Expressions",
      severity: "low",
      description: "Multiple long expressions in template interpolation",
      recommendation:
        "Move complex expressions to computed properties for readability and caching",
      autoFixable: false,
      framework: "vue",
      line: 1,
    });
  }

  // Component over 300 lines
  if (src.split("\n").length > 300) {
    smells.push({
      name: "Oversized Vue SFC (>300 lines)",
      severity: "high",
      description: `SFC is ${src.split("\n").length} lines — consider splitting`,
      recommendation:
        "Extract sub-components and composables. Keep SFCs under 200 lines.",
      autoFixable: true,
      framework: "vue",
      line: 1,
    });
  }

  return smells;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ANGULAR PLUGIN ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export function detectAngularSmells(src: string): FrameworkSmell[] {
  const smells: FrameworkSmell[] = [];
  const lines = src.split("\n");
  const className = angularClassName(src);

  // ── @Component smells ─────────────────────────────────────────────────────

  const hasComponent = /@Component\s*\(/.test(src);

  if (hasComponent) {
    // Inline template — match backtick, escaped backtick, or single/double quoted
    const inlineTemplate =
      src.match(/template\s*:\s*`([\s\S]*?)`/) ??
      src.match(/template\s*:\s*'([\s\S]*?)'/) ??
      src.match(/template\s*:\s*"([\s\S]*?)"/);
    if (inlineTemplate && inlineTemplate[1].split("\n").length > 5) {
      smells.push({
        name: "Long Inline Angular Template",
        severity: "medium",
        description: `Inline template has ${inlineTemplate[1].split("\n").length} lines`,
        recommendation:
          "Move template to a separate .html file using templateUrl",
        autoFixable: false,
        framework: "angular",
        line: 1,
      });
    }

    // Inline styles
    if (/styles\s*:\s*\[`/.test(src)) {
      smells.push({
        name: "Inline Angular Styles",
        severity: "low",
        description: "Component uses inline styles array",
        recommendation:
          "Move styles to a separate .scss/.css file using styleUrls",
        autoFixable: false,
        framework: "angular",
        line: 1,
      });
    }

    // changeDetection not set to OnPush
    if (!/changeDetection\s*:\s*ChangeDetectionStrategy\.OnPush/.test(src)) {
      smells.push({
        name: "Missing OnPush Change Detection",
        severity: "medium",
        description: "Component does not use ChangeDetectionStrategy.OnPush",
        recommendation:
          "Add changeDetection: ChangeDetectionStrategy.OnPush for better performance",
        autoFixable: false,
        framework: "angular",
        line: 1,
      });
    }

    const ngOnInitMatch = src.match(
      /ngOnInit\s*\(\s*\)\s*\{([\s\S]*?)(?=\n\s{2}\w|\n\})/,
    );
    const helperMethodCount = (src.match(/\n\s{2}[A-Za-z_$][\w$]*\s*\(/g) ?? [])
      .length;
    const initBodyLines = ngOnInitMatch
      ? ngOnInitMatch[1].split("\n").filter((line) => line.trim()).length
      : 0;
    if (ngOnInitMatch && (initBodyLines > 10 || helperMethodCount >= 4)) {
      const serviceName =
        className.replace(/Component$/, "Service") || "ComponentService";
      smells.push({
        name: "Angular Service Extraction Candidate",
        severity: "medium",
        description:
          "Business logic is clustered in ngOnInit and component methods and is a good candidate for a dedicated service",
        recommendation: `Move the shared business logic into ${serviceName} and inject it back into the component.`,
        autoFixable: false,
        framework: "angular",
        line: 1,
        suggestedFileName: `${serviceName}.ts`,
        generatedContent: buildAngularServicePreview(className),
        remediationSteps: [
          "Extract orchestration and data-access logic from ngOnInit().",
          "Move reusable helpers into an injectable service.",
          "Inject the service into the component and keep the component lean.",
        ],
      });
    }

    if (/standalone\s*:\s*true/.test(src) === false) {
      smells.push({
        name: "Angular Standalone Migration Candidate",
        severity: "medium",
        description:
          "Component still uses the NgModule-era shape and can be migrated to a standalone component",
        recommendation:
          "Add standalone: true, move dependencies into the component imports array, and remove the NgModule declaration once the component is migrated.",
        autoFixable: false,
        framework: "angular",
        line: 1,
        suggestedFileName: `${className}.standalone.md`,
        generatedContent: buildAngularStandaloneGuide(className),
        remediationSteps: [
          "Mark the component standalone.",
          "Inline the needed module imports into the component decorator.",
          "Drop the old NgModule wrapper once the component is self-contained.",
        ],
      });
    }
  }

  // ── @Injectable smells ────────────────────────────────────────────────────

  if (/@Injectable\s*\(/.test(src)) {
    // providedIn not set
    if (!/providedIn\s*:/.test(src)) {
      smells.push({
        name: "Missing providedIn in @Injectable",
        severity: "high",
        description:
          "@Injectable without providedIn creates a non-tree-shakable service",
        recommendation: "Add providedIn: 'root' or a specific module",
        autoFixable: false,
        framework: "angular",
        line: 1,
      });
    }
  }

  // ── Subscription leaks ────────────────────────────────────────────────────

  const hasSubscribe = /\.subscribe\s*\(/.test(src);
  const hasOnDestroy = /implements OnDestroy|ngOnDestroy\s*\(/.test(src);
  const hasTakeUntil = /takeUntil|takeUntilDestroyed|pipe\s*\(/.test(src);

  if (hasSubscribe && !hasOnDestroy && !hasTakeUntil) {
    smells.push({
      name: "Observable Subscription Leak",
      severity: "critical",
      description:
        "Component subscribes to observables but does not implement OnDestroy or use takeUntil",
      recommendation:
        "Implement OnDestroy and unsubscribe, or use takeUntilDestroyed() / AsyncPipe",
      autoFixable: false,
      framework: "angular",
      line: 1,
    });
  }

  // ── ngOnInit complexity ───────────────────────────────────────────────────

  const ngOnInitMatch = src.match(
    /ngOnInit\s*\(\s*\)\s*\{([\s\S]*?)(?=\n\s{2}\w|\n\})/,
  );
  if (ngOnInitMatch) {
    const initBody = ngOnInitMatch[1];
    const initLines = initBody.split("\n").filter((l) => l.trim()).length;
    if (initLines > 15) {
      smells.push({
        name: "Complex ngOnInit",
        severity: "high",
        description: `ngOnInit has ${initLines} statements — too much initialisation logic`,
        recommendation:
          "Extract service calls and setup logic into private methods called from ngOnInit",
        autoFixable: false,
        framework: "angular",
        line: 1,
      });
    }
  }

  // ── Direct DOM access ─────────────────────────────────────────────────────

  if (/document\.getElementById|document\.querySelector(?!All)/.test(src)) {
    smells.push({
      name: "Direct DOM Access in Angular Component",
      severity: "high",
      description:
        "Using document.getElementById/querySelector bypasses Angular rendering",
      recommendation:
        "Use @ViewChild with ElementRef, or Renderer2 for DOM manipulation",
      autoFixable: false,
      framework: "angular",
      line: 1,
    });
  }

  // ── any usage in strict mode ──────────────────────────────────────────────

  if (count(src, /:\s*any\b/g) > 3) {
    smells.push({
      name: "Excessive any in Angular Service/Component",
      severity: "medium",
      description: `${count(src, /:\s*any\b/g)} uses of 'any' type`,
      recommendation:
        "Replace any with proper types or generics. Angular works best with strict typing.",
      autoFixable: false,
      framework: "angular",
      line: 1,
    });
  }

  // ── Large class (line count) ──────────────────────────────────────────────

  if (lines.length > 250) {
    smells.push({
      name: "Oversized Angular Class (>250 lines)",
      severity: "high",
      description: `Class is ${lines.length} lines — violates single responsibility`,
      recommendation:
        "Extract business logic into dedicated services; keep components lean",
      autoFixable: true,
      framework: "angular",
      line: 1,
    });
  }

  return smells;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── SVELTE PLUGIN ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface SvelteBlocks {
  script: string;
  template: string;
  style: string;
}

function extractSvelteBlocks(src: string): SvelteBlocks {
  const scriptM = src.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  const styleM = src.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const template = src
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .trim();
  return { script: scriptM?.[1] ?? "", template, style: styleM?.[1] ?? "" };
}

export function detectSvelteSmells(src: string): FrameworkSmell[] {
  const smells: FrameworkSmell[] = [];
  const { script, template } = extractSvelteBlocks(src);

  // ── Reactive statement ($:) abuse ─────────────────────────────────────────

  const reactiveCount = count(script, /^\s*\$:/gm);
  if (reactiveCount > 6) {
    smells.push({
      name: "Excessive $: Reactive Statements",
      severity: "medium",
      description: `${reactiveCount} reactive $: statements — hard to track dependencies`,
      recommendation:
        "Extract groups of related reactive statements into a separate .svelte component or store",
      autoFixable: false,
      framework: "svelte",
      line: 1,
    });
  }

  // ── Store subscription without onDestroy ──────────────────────────────────

  const hasSubscribe = /\.subscribe\s*\(/.test(script);
  const hasOnDestroy =
    /import\s*\{[^}]*onDestroy/.test(script) || /onDestroy\s*\(/.test(script);
  const hasAutoSub = /\$\w+/.test(template); // Svelte auto-subscribe syntax

  if (hasSubscribe && !hasOnDestroy && !hasAutoSub) {
    smells.push({
      name: "Store Subscription Without onDestroy",
      severity: "critical",
      description:
        "Manually subscribing to a store without onDestroy cleanup causes memory leaks",
      recommendation:
        "Use the $ prefix for auto-subscription ($store), or call unsubscribe inside onDestroy",
      autoFixable: false,
      framework: "svelte",
      line: 1,
    });
  }

  // ── Mutable store assignment ──────────────────────────────────────────────

  if (/\$\w+\s*=\s*/.test(template) && /writable/.test(script)) {
    smells.push({
      name: "Direct Writable Store Assignment in Template",
      severity: "low",
      description:
        "Assigning to $store directly in the template — bypasses update notification patterns",
      recommendation:
        "Use store.set() or store.update() to mutate stores explicitly",
      autoFixable: false,
      framework: "svelte",
      line: 1,
    });
  }

  // ── Missing key on {#each} ────────────────────────────────────────────────

  if (/{#each/.test(template) && !/{#each[^}]+(key)/.test(template)) {
    smells.push({
      name: "Missing key on {#each}",
      severity: "medium",
      description:
        "{#each} block without a key expression causes inefficient DOM updates",
      recommendation:
        "Add a key: {#each items as item (item.id)} for keyed diffing",
      autoFixable: false,
      framework: "svelte",
      line: 1,
    });
  }

  // ── Context misuse ────────────────────────────────────────────────────────

  if (/getContext/.test(script) && !/setContext/.test(src)) {
    smells.push({
      name: "getContext Without setContext in Tree",
      severity: "high",
      description: "getContext() called but no setContext() found in this file",
      recommendation:
        "Ensure a parent component calls setContext() with the same key before this component mounts",
      autoFixable: false,
      framework: "svelte",
      line: 1,
    });
  }

  // ── Inline event handlers ─────────────────────────────────────────────────

  if (count(template, /on:\w+\s*=\s*\{[^}]{40,}\}/g) > 3) {
    smells.push({
      name: "Excessive Inline Event Handlers",
      severity: "low",
      description: "Multiple long inline event handler expressions in template",
      recommendation:
        "Move handler logic to named functions in the <script> block",
      autoFixable: false,
      framework: "svelte",
      line: 1,
    });
  }

  // ── Large component ───────────────────────────────────────────────────────

  const totalLines = src.split("\n").length;
  if (totalLines > 200) {
    smells.push({
      name: "Oversized Svelte Component (>200 lines)",
      severity: "high",
      description: `Component is ${totalLines} lines`,
      recommendation:
        "Extract child components and stores. Svelte components work best under 150 lines.",
      autoFixable: true,
      framework: "svelte",
      line: 1,
    });
  }

  return smells;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Framework detector + dispatcher ──────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export type FrameworkKind =
  | "vue"
  | "angular"
  | "svelte"
  | "react"
  | "qwik"
  | "none";

export function detectFrameworkKind(
  src: string,
  filePath: string,
): FrameworkKind {
  if (filePath.endsWith(".vue")) return "vue";
  if (filePath.endsWith(".svelte")) return "svelte";
  if (/@Component\s*\(|@NgModule\s*\(|@Injectable\s*\(/.test(src))
    return "angular";
  if (/component\$\s*\(|useSignal\s*\(|useStore\s*\(|useTask\$\s*\(/.test(src))
    return "qwik";
  if (/from ['"]react['"]/.test(src) || /useState|useEffect/.test(src))
    return "react";
  return "none";
}

/**
 * Run the appropriate framework plugin and return smells.
 * Returns [] for React (handled by existing smellDetector.ts).
 */
export function detectFrameworkSmells(
  src: string,
  filePath: string,
): FrameworkSmell[] {
  const kind = detectFrameworkKind(src, filePath);
  switch (kind) {
    case "vue":
      return detectVueSmells(src, filePath);
    case "angular":
      return detectAngularSmells(src);
    case "svelte":
      return detectSvelteSmells(src);
    default:
      return [];
  }
}
