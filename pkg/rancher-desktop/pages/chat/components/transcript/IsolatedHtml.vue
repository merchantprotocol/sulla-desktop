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

  We keep <style> allowed (that's the point — we want the agent's
  CSS to apply *within the shadow*). CSS custom properties defined
  on :root (e.g. --read-1) inherit through the shadow boundary, so
  the content picks up the chat theme tokens automatically.
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

const BASE_STYLES = `
  :host {
    display: block;
    color: var(--read-1, #d6dce4);
    font-family: var(--sans, system-ui, -apple-system, sans-serif);
    font-size: 14px;
    line-height: 1.55;
  }
  * { box-sizing: border-box; }
  a { color: var(--steel-400, #6ab0cc); }
  pre, code { font-family: var(--mono, ui-monospace, monospace); }
  img, svg, video { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
`;

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
  shadow.innerHTML = `<style>${ BASE_STYLES }</style>${ safe }`;
}

onMounted(() => {
  if (!hostEl.value) return;
  shadow = hostEl.value.attachShadow({ mode: 'open' });
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
