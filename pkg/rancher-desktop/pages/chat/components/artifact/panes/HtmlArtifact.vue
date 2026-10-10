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
  '--bg', '--surface-1', '--surface-2', '--surface-3',
  '--text', '--text-muted', '--text-dim',
  '--accent', '--accent-hover', '--accent-dim', '--accent-border', '--accent-glow',
  '--border', '--border-muted', '--success', '--warning', '--danger', '--info',
  '--font-display', '--font-mono', '--font-body',
  '--bg-page', '--bg-surface', '--bg-surface-alt', '--bg-surface-hover',
  '--text-primary', '--text-secondary', '--accent-primary', '--accent-primary-hover',
  '--border-default', '--border-subtle',
  '--status-success', '--status-warning', '--status-error', '--status-info',
  '--nx-paper', '--nx-surface', '--nx-glass', '--nx-ink',
  '--nx-read-1', '--nx-read-2', '--nx-read-3', '--nx-read-4', '--nx-read-5',
  '--nx-hair', '--nx-hair-strong', '--nx-accent', '--nx-accent-2', '--nx-glow',
  '--nx-indicator-bg', '--nx-indicator-edge', '--nx-shadow-lg',
  '--nx-success', '--nx-warning', '--nx-danger',
] as const;

const THEME_ALIASES: Record<string, string[]> = {
  '--bg':            ['--bg-page'],
  '--surface-1':     ['--bg-surface'],
  '--surface-2':     ['--bg-surface-alt'],
  '--surface-3':     ['--bg-surface-hover'],
  '--text':          ['--text-primary'],
  '--text-muted':    ['--text-secondary'],
  '--text-dim':      ['--text-muted'],
  '--accent':        ['--accent-primary', '--nx-accent'],
  '--accent-hover':  ['--accent-primary-hover', '--nx-accent-2'],
  '--accent-dim':    ['--bg-accent'],
  '--accent-border': ['--border-accent'],
  '--accent-glow':   ['--brand-glow', '--nx-glow'],
  '--border':        ['--border-default'],
  '--border-muted':  ['--border-subtle', '--nx-hair'],
  '--success':       ['--status-success', '--nx-success'],
  '--warning':       ['--status-warning', '--nx-warning'],
  '--danger':        ['--status-error', '--nx-danger'],
  '--info':          ['--status-info'],
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
    const value = themeValue(styles, [name, ...(THEME_ALIASES[name] ?? [])]);

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
    color-scheme: dark;
    --bg: #0d1117;
    --surface-1: #161b22;
    --surface-2: #1c2128;
    --surface-3: #21262d;
    --border: #30363d;
    --border-muted: #21262d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-dim: #6e7681;
    --accent: #5096b3;
    --accent-hover: #6ab0cc;
    --accent-dim: rgba(80, 150, 179, 0.15);
    --accent-border: rgba(80, 150, 179, 0.5);
    --accent-glow: rgba(80, 150, 179, 0.4);
    --green: #2ea043;
    --green-bright: #3fb950;
    --green-glow: rgba(46, 160, 67, 0.4);
    --green-glow-soft: rgba(63, 185, 80, 0.15);
    --green-glow-strong: rgba(63, 185, 80, 0.6);
    --info: #58a6ff;
    --success: #3fb950;
    --warning: #e3b341;
    --danger: #f85149;
    --font-display: 'Playfair Display', Georgia, serif;
    --font-mono: 'JetBrains Mono', 'Courier New', monospace;
    --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  }
  html, body {
    margin: 0;
    /* Transparent so the artifact sidebar background shows through —
       content reads as part of the panel, not a separate document. */
    background: transparent;
    color: var(--text);
    font-family: var(--font-body);
    overflow-wrap: break-word;
    word-wrap: break-word;
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
