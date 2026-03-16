<template>
  <div
    ref="hostEl"
    class="html-message-host"
  />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';

const props = withDefaults(defineProps<{
  content: string;
  isDark: boolean;
  /** When true, fills the parent container instead of capping at 80vh */
  fullPage?: boolean;
}>(), { fullPage: false });

const hostEl = ref<HTMLElement | null>(null);

let shadow: ShadowRoot | null = null;
let resizeObserver: ResizeObserver | null = null;

/**
 * Merchant Protocol "Noir Terminal Editorial" design system defaults.
 * These CSS variables and base styles are injected into every Shadow DOM
 * so agent HTML responses inherit the brand design language automatically.
 */
function getDefaultStyles(): string {
  const hostHeight = props.fullPage ? 'height: 100%; min-height: 100%;' : 'max-height: 80vh;';

  return `
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=JetBrains+Mono:wght@300;400;500;700&display=swap');

    :host {
      display: block;
      ${ hostHeight }
      overflow-y: auto;
      overflow-x: hidden;
      color-scheme: dark;

      /* Backgrounds */
      --bg: #0d1117;
      --surface-1: #161b22;
      --surface-2: #1c2128;
      --surface-3: #21262d;

      /* Borders */
      --border: #30363d;
      --border-muted: #21262d;

      /* Text */
      --text: #e6edf3;
      --text-muted: #8b949e;
      --text-dim: #6e7681;

      /* Green accent system */
      --green: #2ea043;
      --green-bright: #3fb950;
      --green-glow: rgba(46, 160, 67, 0.4);
      --green-glow-soft: rgba(63, 185, 80, 0.15);
      --green-glow-strong: rgba(63, 185, 80, 0.6);

      /* Status */
      --info: #58a6ff;
      --success: #3fb950;
      --warning: #e3b341;
      --danger: #f85149;

      /* Traffic-light dots */
      --red-dot: #ff5f57;
      --yellow-dot: #febc2e;
      --green-dot: #28c840;

      /* Fonts */
      --font-display: 'Playfair Display', Georgia, serif;
      --font-mono: 'JetBrains Mono', 'Courier New', monospace;
      --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    }

    .html-message-wrapper {
      color: var(--text);
      background: transparent;
      font-family: var(--font-mono);
      font-size: 14px;
      line-height: 1.7;
      word-wrap: break-word;
      overflow-wrap: break-word;
      -webkit-font-smoothing: antialiased;
    }

    /* Typography */
    h1, h2, h3, h4, h5, h6 {
      font-family: var(--font-display);
      color: var(--text);
      margin: 1.5em 0 0.5em;
    }
    h1 { font-weight: 900; font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.1; }
    h2 { font-weight: 900; font-size: clamp(1.5rem, 4vw, 2.5rem); line-height: 1.15; }
    h3 { font-weight: 700; font-size: 1.3rem; line-height: 1.2; }
    h4 { font-weight: 700; font-size: 1.1rem; }

    h1 em, h2 em, h3 em {
      color: var(--green-bright);
      font-style: italic;
      text-shadow: 0 0 40px var(--green-glow);
    }

    p { margin: 0.75em 0; color: var(--text-muted); }

    /* Links — always green, never blue */
    a { color: var(--green-bright); text-decoration: none; transition: all 0.3s; }
    a:hover { color: var(--text); text-shadow: 0 0 10px var(--green-glow); }

    /* Selection */
    ::selection { background: var(--green); color: #fff; }

    /* Code */
    code {
      background: var(--surface-2);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 0.85em;
      color: var(--green-bright);
      border: 1px solid var(--border);
    }
    pre {
      background: #1a1e24;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.5rem 1.75rem;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      line-height: 1.8;
      color: var(--text-muted);
      overflow-x: auto;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03);
    }
    pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: inherit;
      color: inherit;
    }

    /* Terminal window chrome */
    .terminal-window {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2);
    }
    .terminal-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    .terminal-dot { width: 12px; height: 12px; border-radius: 50%; }
    .terminal-dot.red { background: var(--red-dot); }
    .terminal-dot.yellow { background: var(--yellow-dot); }
    .terminal-dot.green { background: var(--green-dot); }

    /* Cards */
    .card {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      transition: border-color 0.4s, box-shadow 0.4s;
    }
    .card:hover {
      border-color: var(--green-bright);
      box-shadow: 0 0 20px rgba(46, 160, 67, 0.1);
    }

    /* Tables */
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    th {
      background: var(--surface-2);
      color: var(--green-bright);
      text-transform: uppercase;
      font-family: var(--font-mono);
      font-size: 0.65rem;
      letter-spacing: 0.08em;
      padding: 0.65rem 1rem;
      text-align: left;
      border-bottom: 2px solid var(--green);
    }
    td { padding: 0.65rem 1rem; color: var(--text-muted); border-bottom: 1px solid var(--border-muted); }
    tr:hover { background: var(--surface-1); }

    /* Buttons */
    button, .btn {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      font-weight: 500;
      padding: 10px 24px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      letter-spacing: 0.05em;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .btn-primary, button:not(.btn-outline):not(.btn-ghost) {
      background: var(--green);
      color: #fff;
    }
    .btn-primary:hover, button:not(.btn-outline):not(.btn-ghost):hover {
      background: var(--green-bright);
      box-shadow: 0 0 20px var(--green-glow);
      transform: translateY(-2px);
    }
    .btn-outline {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn-outline:hover {
      border-color: var(--green-bright);
      color: var(--green-bright);
      box-shadow: 0 0 15px var(--green-glow-soft);
      transform: translateY(-2px);
    }

    /* Blockquotes / Pull quotes */
    blockquote {
      border-left: 3px solid var(--green);
      padding: 1rem 0 1rem 1.5rem;
      margin: 1em 0;
      font-family: var(--font-display);
      font-weight: 700;
      font-style: italic;
      font-size: 1.1rem;
      line-height: 1.5;
      color: var(--text);
      box-shadow: -4px 0 20px var(--green-glow);
    }

    /* Dividers */
    hr {
      border: none;
      height: 1px;
      margin: 2rem 0;
      background: linear-gradient(90deg, transparent 0%, var(--green) 35%, var(--green-bright) 50%, var(--green) 65%, transparent 100%);
      box-shadow: 0 0 15px var(--green-glow), 0 0 30px var(--green-glow-soft);
    }

    /* Lists */
    ul, ol { color: var(--text-muted); padding-left: 1.5em; }
    li { margin: 0.3em 0; }
    li::marker { color: var(--green-bright); }

    /* Section labels */
    .section-label {
      font-family: var(--font-mono);
      font-weight: 500;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.3em;
      color: var(--green-bright);
    }

    /* Stat numbers */
    .stat-number {
      font-family: var(--font-display);
      font-weight: 900;
      font-size: 3rem;
      line-height: 1;
      color: var(--green-bright);
      text-shadow: 0 0 30px var(--green-glow);
    }
    .stat-label {
      font-family: var(--font-mono);
      font-weight: 400;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      color: var(--text-muted);
    }

    /* Images */
    img { max-width: 100%; height: auto; border-radius: 8px; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--green); border-radius: 3px; }

    /* Utility */
    .text-green { color: var(--green-bright); }
    .text-muted { color: var(--text-muted); }
    .text-dim { color: var(--text-dim); }
    .bg-surface { background: var(--surface-1); }
    .glow { box-shadow: 0 0 20px var(--green-glow); }
  `;
}

function stripMetaRefresh(html: string): string {
  return html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
}

function render(): void {
  const el = hostEl.value;
  if (!el || !props.content) return;

  try {
    if (!shadow) {
      shadow = el.attachShadow({ mode: 'open' });
    }

    const sanitizedContent = stripMetaRefresh(props.content);

    shadow.innerHTML = `
      <style>${ getDefaultStyles() }</style>
      <div class="html-message-wrapper">${ sanitizedContent }</div>
    `;

    // Execute script tags manually since innerHTML doesn't execute them
    const scripts = shadow.querySelectorAll('script');
    scripts.forEach((oldScript) => {
      const newScript = document.createElement('script');
      for (const attr of oldScript.attributes) {
        newScript.setAttribute(attr.name, attr.value);
      }
      newScript.textContent = oldScript.textContent;
      oldScript.parentNode?.replaceChild(newScript, oldScript);
    });

    // Set up resize observer on the wrapper
    const wrapper = shadow.querySelector('.html-message-wrapper');
    if (wrapper && !resizeObserver) {
      resizeObserver = new ResizeObserver(() => {
        // Parent scroll container will handle scrolling;
        // this just ensures the host element sizes correctly.
      });
      resizeObserver.observe(wrapper);
    }
  } catch (e) {
    // Fallback: render in a regular div with CSS reset if shadow fails
    console.warn('[HtmlMessageRenderer] Shadow DOM failed, falling back:', e);
    el.style.cssText = 'all: initial; display: block; max-height: 80vh; overflow-y: auto;';
    el.innerHTML = `
      <div style="font-family: sans-serif; font-size: 14px; line-height: 1.6;">
        ${ stripMetaRefresh(props.content) }
      </div>
    `;
  }
}

onMounted(() => {
  render();
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch(() => props.content, () => render());
</script>

<style scoped>
.html-message-host {
  min-height: 24px;
  border-radius: 0.75rem;
  overflow: hidden;
}
</style>
