<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  HTML artifact — sandboxed iframe. Never injects arbitrary HTML into
  the main DOM (CSP + sanitization happens before payload is set).

  Wraps the incoming HTML in a document shell that defines the Sulla
  theme tokens (--bg, --text, --surface-*, accent vars, fonts) so the
  AI-authored markup matches the surrounding app theme. If the payload
  already provides its own full <html> doc it
  still works — we only prepend a <base> stylesheet that defines the
  vars as :root defaults, then mirror the active app theme on top. Authored
  styles still come later and override them cleanly.
-->
<template>
  <iframe
    ref="iframeEl"
    class="html-iframe"
    sandbox="allow-scripts allow-same-origin"
    :srcdoc="wrappedHtml"
    loading="lazy"
    @load="onLoad"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { HtmlPayload } from '../../../models/Artifact';

const props = defineProps<{ payload: HtmlPayload }>();
const iframeEl = ref<HTMLIFrameElement | null>(null);
const liveThemeCss = ref('');
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;

// Auto-size the iframe to its content so the artifact scrolls as one
// continuous column inside ArtifactBody instead of showing a nested
// iframe scrollbar. We measure body.scrollHeight on load + whenever
// the body resizes (fonts loading, images arriving, etc.).
function syncHeight() {
  const frame = iframeEl.value;
  const doc = frame?.contentDocument;

  if (!frame || !doc?.documentElement) return;
  const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);

  frame.style.height = `${ h }px`;
}

function onLoad() {
  resizeObserver?.disconnect();
  resizeObserver = null;

  const body = iframeEl.value?.contentDocument?.body;

  if (!body) return;
  syncHeight();
  resizeObserver = new ResizeObserver(() => syncHeight());
  resizeObserver.observe(body);
}

watch(() => props.payload.html, () => {
  // srcdoc change will re-fire load; drop the observer tied to the old doc.
  resizeObserver?.disconnect();
  resizeObserver = null;
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  themeObserver?.disconnect();
  themeObserver = null;
});

const THEME_VARIABLES = [
  '--bg-page', '--bg-surface', '--bg-surface-alt', '--bg-surface-hover', '--bg-elevated',
  '--bg-input', '--bg-overlay', '--bg-hover', '--bg-selected', '--bg-glass',
  '--text-primary', '--text-secondary', '--text-muted', '--text-dim', '--text-on-accent', '--text-link',
  '--border-default', '--border-subtle', '--border-strong', '--border-focus',
  '--accent', '--accent-hover', '--accent-dim', '--accent-border', '--accent-glow',
  '--status-success', '--status-warning', '--status-error', '--status-info',
  '--status-success-soft', '--status-warning-soft', '--status-error-soft', '--status-info-soft',
  '--focus-ring', '--radius-sm', '--radius-ctl', '--radius-panel', '--radius-sheet',
  '--elev-rest', '--elev-raised', '--elev-float',
  '--font-body', '--font-display', '--font-mono',
  '--fs-display', '--fs-heading', '--fs-body', '--fs-body-sm', '--fs-caption', '--fs-code',
  '--ease-enter', '--ease-std', '--ease-exit', '--dur-instant', '--dur-fast', '--dur-std', '--dur-move', '--spring',
  '--bg', '--surface-1', '--surface-2', '--surface-3', '--text', '--border', '--border-muted',
  '--info', '--success', '--warning', '--danger', '--green', '--green-bright',
] as const;

const THEME_ALIASES: Record<string, string[]> = {
  '--bg': ['--bg-page'], '--surface-1': ['--bg-surface'], '--surface-2': ['--bg-surface-alt'],
  '--surface-3': ['--bg-surface-hover'], '--text': ['--text-primary'],
  // Agent-authored reports use a lighter two-step muted scale than the host app.
  '--text-muted': ['--text-secondary'], '--text-dim': ['--text-muted'],
  '--border': ['--border-default'], '--border-muted': ['--border-subtle'],
  '--info': ['--status-info'], '--success': ['--status-success'], '--warning': ['--status-warning'],
  '--danger': ['--status-error'], '--green': ['--status-success'], '--green-bright': ['--status-success'],
};

function themeValue(styles: CSSStyleDeclaration[], names: string[]): string {
  for (const name of names) {
    for (const style of styles) {
      const value = style.getPropertyValue(name).trim();

      if (value) return value;
    }
  }
  return '';
}

function refreshTheme(): void {
  const root = document.documentElement;
  const source = iframeEl.value?.closest('.chat-root') ?? root;
  const styles = source === root
    ? [getComputedStyle(root)]
    : [getComputedStyle(source), getComputedStyle(root)];
  const declarations = THEME_VARIABLES.flatMap((name) => {
    const value = themeValue(styles, [...(THEME_ALIASES[name] ?? []), name]);

    return value ? [`${ name }: ${ value };`] : [];
  });
  const themeClass = Array.from(root.classList).find(name => name.startsWith('theme-')) ?? '';
  const computedScheme = styles[0].colorScheme;
  const colorScheme = computedScheme === 'light' || computedScheme === 'dark'
    ? computedScheme
    : (themeClass.includes('light') ? 'light' : 'dark');
  const next = `:root { color-scheme: ${ colorScheme }; ${ declarations.join(' ') } }`;

  if (next !== liveThemeCss.value) liveThemeCss.value = next;
}

onMounted(() => {
  refreshTheme();
  themeObserver = new MutationObserver(refreshTheme);
  const root = document.documentElement;
  const source = iframeEl.value?.closest('.chat-root');

  themeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
  if (source && source !== root) {
    themeObserver.observe(source, { attributes: true, attributeFilter: ['class', 'style'] });
  }
});

const THEME_FALLBACK_CSS = `
  :root {
    color-scheme: light;
    --bg: #f7f8fa; --surface-1: #ffffff; --surface-2: #f1f3f5; --surface-3: #e9ecef;
    --text: #1a2332; --text-muted: #5f6b7a; --text-dim: #8a94a3;
    --accent: #5096b3; --accent-hover: #3f819e; --accent-dim: rgba(80, 150, 179, 0.12);
    --accent-border: rgba(80, 150, 179, 0.35); --accent-glow: rgba(80, 150, 179, 0.22);
    --border: #d5dae0; --border-muted: #e5e8ec;
    --success: #238636; --warning: #9a6700; --danger: #cf222e; --info: #0969da;
    --green: #238636; --green-bright: #2da44e;
    --font-display: Georgia, 'Times New Roman', serif;
    --font-mono: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
    --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  html, body {
    margin: 0; background: transparent; color: var(--text);
    font-family: var(--font-body); overflow-wrap: break-word; word-wrap: break-word;
  }
  img, table, pre { max-width: 100%; }
`;

const wrappedHtml = computed(() => {
  const raw = props.payload.html ?? '';
  const styleTag = `<style>${ THEME_FALLBACK_CSS }${ liveThemeCss.value }</style>`;

  // If the payload is a full doc, inject our theme into <head> (or
  // before <html>'s first child). Otherwise wrap it in a minimal doc.
  if (/<html[\s>]/i.test(raw)) {
    if (/<head[\s>]/i.test(raw)) {
      return raw.replace(/<head([^>]*)>/i, `<head$1>${ styleTag }`);
    }
    return raw.replace(/<html([^>]*)>/i, `<html$1><head>${ styleTag }</head>`);
  }
  return `<!doctype html><html><head>${ styleTag }</head><body>${ raw }</body></html>`;
});
</script>

<style scoped>
/* No card, no border, no rounded corners — content flows inside the
   artifact body and shares its scrollbar. Height is set dynamically
   from the iframe's own scrollHeight so the page scrolls as one. */
.html-iframe {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
}
</style>
