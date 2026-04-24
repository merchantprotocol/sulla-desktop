<!--
  IsolatedHtml — renders raw HTML inside an open Shadow DOM so any
  <style> blocks or layout-heavy markup the agent emits can't leak
  out and wreck the rest of the app.

  Isolation guarantees:
    • <style> rules are scoped to the shadow tree only. The host
      app's stylesheet can't reach in (unless the agent uses
      ::part() — which we don't expose).
    • <script> tags inserted via innerHTML do NOT execute (browser
      spec), so ad-hoc <script>…</script> in agent output is inert.
    • DOMPurify still strips event handlers, iframes, object tags,
      and other dangerous attributes before insertion.

  Style access:
    • We ADOPT every stylesheet from the host document into the
      shadow root via `adoptedStyleSheets` (cached module-level so
      the work runs once per session, not per bubble). That gives
      the agent's HTML access to the full protocol-dark theme,
      global typography, component classes, etc.
    • We mirror the active `theme-*` class onto a wrapper div inside
      the shadow so descendant selectors like
      `.theme-protocol-dark .foo` still match.
    • A small :host-scoped rule defines the agent-facing token
      aliases (--bg, --surface-1..3, --text, --green, --font-*)
      that the system prompt promises — these don't exist in
      protocol-dark.css under those names.
-->
<template>
  <div ref="hostEl" class="iso-host" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import DOMPurify from 'dompurify';

const props = defineProps<{ html: string }>();

const hostEl = ref<HTMLDivElement | null>(null);
let shadow: ShadowRoot | null = null;

// Agent-facing token aliases. These names are what the system prompt
// promises agents ( --bg, --surface-1..3, --text, --green, --font-* ) —
// they don't exist under these names in protocol-dark.css, so we alias
// them to the real theme tokens here. If the theme tokens resolve via
// inheritance from the document root, great; otherwise fall back to the
// hard-coded palette values.
const BASE_STYLES = `
  :host {
    display: block;
    font-family: var(--font-body, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
    font-size: 14px;
    line-height: 1.55;
    color-scheme: dark;

    --bg: var(--bg-page, #0d1117);
    --surface-1: var(--bg-surface, #161b22);
    --surface-2: var(--bg-surface-alt, #1c2128);
    --surface-3: var(--bg-surface-hover, #21262d);
    --text: var(--text-primary, #e6edf3);
    --text-muted: #8b949e;
    --text-dim: #6e7681;
    --green: #2ea043;
    --green-bright: #3fb950;
    --green-glow: rgba(46, 160, 67, 0.4);
    --green-glow-soft: rgba(63, 185, 80, 0.15);
    --green-glow-strong: rgba(63, 185, 80, 0.6);
    --border: var(--border-default, #30363d);
    --border-muted: var(--border-subtle, #21262d);
    --info: var(--status-info, #58a6ff);
    --success: var(--status-success, #3fb950);
    --warning: var(--status-warning, #e3b341);
    --danger: var(--status-error, #f85149);
    --font-display: 'Playfair Display', Georgia, serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Courier New', monospace;
    --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;

    color: var(--text);
  }
  * { box-sizing: border-box; }
  a { color: var(--accent-primary, #6ab0cc); }
  pre, code { font-family: var(--font-mono); }
  img, svg, video { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
`;

// Collected once per session — adopting the main document's sheets
// lets the agent's HTML use any class/selector the app exposes.
// Cross-origin sheets (e.g. font CDNs) throw on .cssRules access and
// are skipped.
let cachedDocumentSheets: CSSStyleSheet[] | null = null;

function collectDocumentSheets(): CSSStyleSheet[] {
  if (cachedDocumentSheets) return cachedDocumentSheets;
  const out: CSSStyleSheet[] = [];

  for (const ss of Array.from(document.styleSheets)) {
    try {
      const rules = ss.cssRules;
      const text = Array.from(rules).map(r => r.cssText).join('\n');
      const sheet = new CSSStyleSheet();

      sheet.replaceSync(text);
      out.push(sheet);
    } catch {
      // Cross-origin sheet — skip.
    }
  }
  cachedDocumentSheets = out;
  return out;
}

let cachedBaseSheet: CSSStyleSheet | null = null;
function getBaseSheet(): CSSStyleSheet {
  if (cachedBaseSheet) return cachedBaseSheet;
  cachedBaseSheet = new CSSStyleSheet();
  cachedBaseSheet.replaceSync(BASE_STYLES);
  return cachedBaseSheet;
}

// Mirror the active `theme-*` class from the document root so
// descendant selectors like `.theme-protocol-dark .foo` resolve
// inside the shadow tree.
function activeThemeClass(): string {
  return Array.from(document.documentElement.classList)
    .find(c => c.startsWith('theme-')) ?? '';
}

function render(html: string): void {
  if (!shadow) return;
  const safe = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // Keep <style> — the whole point is letting the agent's CSS apply,
    // scoped by the shadow. Explicitly forbid script-ish sinks (already
    // stripped by the default profile, but belt + suspenders).
    ADD_TAGS:    ['style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
  });
  const themeClass = activeThemeClass();

  shadow.innerHTML = themeClass
    ? `<div class="${ themeClass }">${ safe }</div>`
    : safe;
}

onMounted(() => {
  if (!hostEl.value) return;
  shadow = hostEl.value.attachShadow({ mode: 'open' });
  // Adopt all app stylesheets + our base layer. adoptedStyleSheets
  // is shared by reference, so N bubbles = 1 copy in memory.
  shadow.adoptedStyleSheets = [...collectDocumentSheets(), getBaseSheet()];
  render(props.html);
});

watch(() => props.html, (v) => render(v));

onBeforeUnmount(() => {
  shadow = null;
});
</script>

<style scoped>
.iso-host {
  display: block;
  /* Give the host a sane default width so block content fills the bubble */
  width: 100%;
  /* Contain layout shifts — the shadow content can't affect siblings,
     but an enormous element inside could still reflow the bubble. */
  contain: layout paint;
}
</style>
