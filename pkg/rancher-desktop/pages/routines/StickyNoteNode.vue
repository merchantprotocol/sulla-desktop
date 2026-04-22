<template>
  <div
    class="sticky-note"
    :class="{ 'is-selected': selected, 'is-editing': isEditing }"
    :style="{ background: bgColor, borderColor }"
    @dblclick="onDoubleClick"
  >
    <!-- View mode: markdown rendered through `marked` + DOMPurify. Same
         pipeline NodeOutputPanel uses so sanitization rules stay in one
         place. Falls back to a dim placeholder when the note is empty.
         No `.nodrag` here — the body IS the drag surface, VueFlow owns
         pointerdown so the user can pick up and move the note from
         anywhere on it. Double-click still falls through to `onDoubleClick`
         on the wrapper and swaps to the textarea. -->
    <div
      v-if="!isEditing"
      class="sticky-body"
    >
      <div
        v-if="renderedHtml"
        class="md"
        v-html="renderedHtml"
      />
      <span
        v-else
        class="placeholder"
      >Write anything…</span>
    </div>

    <!-- Color palette — only shown when the note is selected in edit mode,
         floats in the top-right corner, `.nodrag` so clicking a swatch
         doesn't move the note. n8n-style 7-color row, mapped to Sulla's
         dark-mode palette rather than n8n's bright Post-It defaults. -->
    <div
      v-if="showPalette"
      class="sticky-palette nodrag"
      @pointerdown.stop
    >
      <button
        v-for="c in PALETTE"
        :key="c.id"
        type="button"
        class="swatch"
        :class="{ active: (data.bgColor || '') === c.fill }"
        :title="c.label"
        :style="{ background: c.fill, borderColor: c.border }"
        @click="setColor(c.fill)"
      />
    </div>

    <!-- Edit mode: plain textarea. VueFlow would otherwise grab pointer events
         and drag the node instead of letting the user select/type, so .nodrag
         plus pointerdown.stop pin the pointer to the textarea. Explicit
         `v-if` (not `v-else`) because the palette div sits between this and
         the view body — a `v-else` would pair with the palette, not the body,
         and render the textarea alongside the rendered markdown. -->
    <textarea
      v-if="isEditing"
      ref="editorRef"
      v-model="draft"
      class="sticky-editor nodrag"
      :placeholder="PLACEHOLDER"
      @pointerdown.stop
      @blur="commitEdit"
      @keydown.escape.prevent="cancelEdit"
      @keydown.meta.enter.prevent="commitEdit"
      @keydown.ctrl.enter.prevent="commitEdit"
    />

    <!-- Resize handles, edit-mode only. Same 8-direction pattern LoopFrameNode
         uses so sizing feels consistent across container-style nodes. -->
    <template v-if="isEditMode && !isEditing">
      <div
        v-for="dir in RESIZE_DIRS"
        :key="dir"
        class="resize nodrag"
        :class="dir"
        @pointerdown.stop="beginResize($event, dir)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useVueFlow } from '@vue-flow/core';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, inject, nextTick, ref, type Ref } from 'vue';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

const MIN_W = 140;
const MIN_H = 80;

const PLACEHOLDER = 'Write anything…';

// 7-color palette — same slot count as n8n so templates imported from
// there map cleanly, but retoned to sit well on Sulla's dark canvas
// instead of n8n's bright Post-It look. `fill` is the full rgba the
// note renders with; `border` is used only for the swatch ring.
interface PaletteColor { id: string; label: string; fill: string; border: string }
const PALETTE: PaletteColor[] = [
  { id: 'blue', label: 'Blue', fill: 'rgba(80, 150, 179, 0.18)', border: 'rgba(80, 150, 179, 0.7)' },
  { id: 'violet', label: 'Violet', fill: 'rgba(139, 92, 246, 0.18)', border: 'rgba(139, 92, 246, 0.7)' },
  { id: 'cyan', label: 'Cyan', fill: 'rgba(34, 211, 238, 0.16)', border: 'rgba(34, 211, 238, 0.7)' },
  { id: 'green', label: 'Green', fill: 'rgba(52, 160, 110, 0.18)', border: 'rgba(52, 160, 110, 0.7)' },
  { id: 'amber', label: 'Amber', fill: 'rgba(245, 158, 11, 0.18)', border: 'rgba(245, 158, 11, 0.75)' },
  { id: 'rose', label: 'Rose', fill: 'rgba(244, 63, 94, 0.18)', border: 'rgba(244, 63, 94, 0.75)' },
  { id: 'slate', label: 'Slate', fill: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.6)' },
];

// Same GFM+breaks setup NodeOutputPanel uses. The sanitizer is the real
// security boundary — anything the user pastes passes through it before
// landing in the DOM, and data: URIs are limited to inline images only.
marked.setOptions({ gfm: true, breaks: true });

// Recognised video embed URLs. Anything matching these patterns is turned
// into a safe iframe/<video> element before markdown parsing; everything
// else falls through to standard markdown (plain links stay plain links).
// Narrow, explicit allowlist keeps the iframe attack surface to just the
// two hosts n8n users actually embed from.
const YOUTUBE_RX = /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=([\w-]+)|youtube\.com\/embed\/([\w-]+)|youtu\.be\/([\w-]+))(?:[&?][^\s]*)?$/i;
const VIMEO_RX = /^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:[/?#][^\s]*)?$/i;
const VIDEO_FILE_RX = /^(https?:\/\/[^\s]+?\.(?:mp4|webm|ogg|mov))(\?[^\s]*)?$/i;

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]!));
}

/**
 * Replace bare-line video URLs with an embed-shaped HTML block before
 * markdown parsing. Only whole-line matches so URLs inside sentences or
 * markdown links stay as ordinary links. Uses a wrapper div with an
 * aspect-ratio box so the embed scales with note width.
 */
function expandVideoEmbeds(md: string): string {
  const lines = md.split(/\r?\n/);
  return lines.map((raw) => {
    const line = raw.trim();
    if (!line) return raw;

    const yt = YOUTUBE_RX.exec(line);
    if (yt) {
      const id = yt[1] || yt[2] || yt[3];
      if (!id) return raw;
      const src = `https://www.youtube-nocookie.com/embed/${ escapeAttr(id) }`;
      return `<div class="embed-frame"><iframe src="${ src }" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen frameborder="0"></iframe></div>`;
    }

    const vm = VIMEO_RX.exec(line);
    if (vm) {
      const id = vm[1];
      const src = `https://player.vimeo.com/video/${ escapeAttr(id) }`;
      return `<div class="embed-frame"><iframe src="${ src }" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen frameborder="0"></iframe></div>`;
    }

    const vf = VIDEO_FILE_RX.exec(line);
    if (vf) {
      const src = escapeAttr(vf[0]);
      return `<div class="embed-frame"><video src="${ src }" controls preload="metadata"></video></div>`;
    }

    return raw;
  }).join('\n');
}

// DOMPurify hook — iframes only survive if their src is on the embed
// allowlist. Added once at module scope because DOMPurify hooks are
// global; the guard makes re-mount idempotent.
let embedHookInstalled = false;
function ensureEmbedHook() {
  if (embedHookInstalled) return;
  embedHookInstalled = true;
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'iframe') return;
    const src = (node as HTMLIFrameElement).getAttribute('src') ?? '';
    const ok = /^https:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed\/[\w-]+|player\.vimeo\.com\/video\/\d+)/i.test(src);
    if (!ok) node.parentNode?.removeChild(node);
  });
}

function renderMarkdown(raw: string): string {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!text.trim()) return '';
  ensureEmbedHook();
  const expanded = expandVideoEmbeds(text);
  const html = (marked.parse(expanded) as string) || '';
  return DOMPurify.sanitize(html, {
    USE_PROFILES:       { html: true },
    ADD_TAGS:           ['iframe', 'video'],
    ADD_ATTR:           ['allow', 'allowfullscreen', 'frameborder', 'controls', 'preload', 'poster'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|sulla-routine-asset):|data:image\/(?:png|gif|jpe?g|webp);base64,|\/|\.|#)/i,
  });
}

interface StickyNoteData {
  content?:  string;
  bgColor?:  string;
  subtype?:  string;
  category?: string;
}

const props = defineProps<{
  id:        string;
  data:      StickyNoteData;
  selected?: boolean;
}>();

const routinesMode = inject<Ref<'edit' | 'run'>>('routines-mode');
const isEditMode = computed(() => routinesMode?.value === 'edit');

const { findNode, getViewport } = useVueFlow();

// Steel-blue default that sits well against the dark canvas. Individual
// notes override via data.bgColor (picker lands in phase 2).
const DEFAULT_BG = 'rgba(80, 150, 179, 0.18)';
const bgColor = computed(() => props.data.bgColor || DEFAULT_BG);
// Border tracks the fill hue at a stronger alpha so the note reads as a
// cohesive card regardless of which color the user picked.
const borderColor = computed(() => {
  const bg = bgColor.value;
  const match = /rgba?\(([^)]+)\)/i.exec(bg);
  if (!match) return 'rgba(140, 172, 210, 0.45)';
  const [r, g, b] = match[1].split(',').map(s => s.trim());
  return `rgba(${ r }, ${ g }, ${ b }, 0.55)`;
});

const trimmedContent = computed(() => (props.data.content ?? '').trim());
const renderedHtml = computed(() => renderMarkdown(trimmedContent.value));

// Palette is only offered in edit mode and only when the note is selected
// — otherwise every note on the canvas would fight for attention with a
// permanent swatch strip on top.
const showPalette = computed(() => isEditMode.value && !!props.selected && !isEditing.value);

function setColor(fill: string) {
  const node = findNode(props.id);
  if (!node) return;
  (node as any).data = { ...(node as any).data, bgColor: fill };
}

// ── Edit state ──
// Double-click swaps the view for a textarea; blur / Esc / Cmd+Enter commits.
// Run mode is always read-only — sticky notes are documentation, not inputs.
const isEditing = ref(false);
const draft = ref('');
const editorRef = ref<HTMLTextAreaElement | null>(null);

async function onDoubleClick() {
  if (!isEditMode.value) return;
  draft.value = props.data.content ?? '';
  isEditing.value = true;
  await nextTick();
  editorRef.value?.focus();
  editorRef.value?.select();
}

function commitEdit() {
  if (!isEditing.value) return;
  const node = findNode(props.id);
  if (node) {
    // Mutate data reactively — the parent's deep watcher picks this up and
    // schedules a debounced save through the existing persistence pipeline.
    (node as any).data = { ...(node as any).data, content: draft.value };
  }
  isEditing.value = false;
}

function cancelEdit() {
  isEditing.value = false;
}

// ── Resize ──
// Identical math to LoopFrameNode: screen-space delta divided by zoom so the
// handle tracks the cursor 1:1 regardless of canvas zoom level.
function beginResize(e: PointerEvent, dir: ResizeDir) {
  const node = findNode(props.id);
  if (!node) return;

  const startX = e.clientX;
  const startY = e.clientY;
  const startW = (node as any).dimensions?.width ?? (node as any).width ?? 240;
  const startH = (node as any).dimensions?.height ?? (node as any).height ?? 160;
  const startPos = { x: node.position.x, y: node.position.y };

  const onMove = (ev: PointerEvent) => {
    const zoom = getViewport().zoom || 1;
    const dx = (ev.clientX - startX) / zoom;
    const dy = (ev.clientY - startY) / zoom;

    let w = startW;
    let h = startH;
    let px = startPos.x;
    let py = startPos.y;

    if (dir.includes('e')) w = Math.max(MIN_W, startW + dx);
    if (dir.includes('s')) h = Math.max(MIN_H, startH + dy);
    if (dir.includes('w')) {
      const newW = Math.max(MIN_W, startW - dx);
      px = startPos.x + (startW - newW);
      w = newW;
    }
    if (dir.includes('n')) {
      const newH = Math.max(MIN_H, startH - dy);
      py = startPos.y + (startH - newH);
      h = newH;
    }

    (node as any).width = w;
    (node as any).height = h;
    node.position = { x: px, y: py };
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

</script>

<style scoped>
.sticky-note {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid rgba(140, 172, 210, 0.45);
  color: #e6ecf5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  transition: box-shadow 0.12s ease;
}

.sticky-note.is-selected {
  box-shadow:
    0 0 0 1px rgba(106, 176, 204, 0.85),
    0 2px 14px rgba(0, 0, 0, 0.35);
}

.sticky-body {
  width: 100%;
  height: 100%;
  overflow: auto;
  color: rgba(230, 236, 245, 0.9);
}

.sticky-body .placeholder {
  color: rgba(230, 236, 245, 0.35);
  font-style: italic;
}

/* ── Markdown rendering ──
   Dark-theme overrides for marked's default HTML output. Keeps list
   indentation readable, links visible against the colored background,
   and code blocks distinct from the note's base color. */
.sticky-body .md :first-child { margin-top: 0; }
.sticky-body .md :last-child  { margin-bottom: 0; }
.sticky-body .md h1,
.sticky-body .md h2,
.sticky-body .md h3,
.sticky-body .md h4 {
  margin: 0.4em 0 0.3em;
  font-weight: 700;
  line-height: 1.25;
}
.sticky-body .md h1 { font-size: 1.35em; }
.sticky-body .md h2 { font-size: 1.2em; }
.sticky-body .md h3 { font-size: 1.08em; }
.sticky-body .md p  { margin: 0.25em 0 0.5em; }
.sticky-body .md ul,
.sticky-body .md ol { margin: 0.25em 0 0.5em; padding-left: 1.3em; }
.sticky-body .md li { margin: 0.1em 0; }
.sticky-body .md a {
  color: #6ab0cc;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.sticky-body .md a:hover { color: #8cc7de; }
.sticky-body .md code {
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.35);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.9em;
}
.sticky-body .md pre {
  margin: 0.4em 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.35);
  overflow: auto;
}
.sticky-body .md pre code { padding: 0; background: transparent; }
.sticky-body .md blockquote {
  margin: 0.4em 0;
  padding: 2px 10px;
  border-left: 3px solid rgba(140, 172, 210, 0.45);
  color: rgba(230, 236, 245, 0.8);
  font-style: italic;
}
.sticky-body .md hr {
  border: 0;
  border-top: 1px solid rgba(230, 236, 245, 0.18);
  margin: 0.6em 0;
}
.sticky-body .md img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  display: block;
  margin: 0.3em 0;
}
.sticky-body .md table {
  border-collapse: collapse;
  margin: 0.4em 0;
  font-size: 0.92em;
}
.sticky-body .md th,
.sticky-body .md td {
  border: 1px solid rgba(230, 236, 245, 0.18);
  padding: 4px 8px;
}
.sticky-body .md .embed-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  margin: 0.4em 0;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 8px;
  overflow: hidden;
}
.sticky-body .md .embed-frame iframe,
.sticky-body .md .embed-frame video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}

/* ── Color palette ──
   Sits INSIDE the top-right of the note so the wrapper's `overflow: hidden`
   doesn't have to be lifted. Floats above the body content, `.nodrag`
   keeps clicks from starting a VueFlow drag. */
.sticky-palette {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  padding: 3px 5px;
  background: rgba(14, 24, 40, 0.85);
  border: 1px solid rgba(140, 172, 210, 0.35);
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(4px);
  z-index: 6;
}
.sticky-palette .swatch {
  width: 14px;
  height: 14px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid transparent;
  cursor: pointer;
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}
.sticky-palette .swatch:hover { transform: scale(1.15); }
.sticky-palette .swatch.active {
  box-shadow: 0 0 0 2px rgba(106, 176, 204, 0.9);
}

.sticky-editor {
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  color: #f0f4fa;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

.sticky-editor::placeholder {
  color: rgba(230, 236, 245, 0.35);
  font-style: italic;
}

/* ── Resize grabs — edges and corners, mirrors LoopFrameNode ── */
.resize {
  position: absolute;
  z-index: 5;
  pointer-events: all;
  background: transparent;
}
.resize.n, .resize.s {
  left: 14px;
  right: 14px;
  height: 8px;
  cursor: ns-resize;
}
.resize.n { top: -4px; }
.resize.s { bottom: -4px; }
.resize.e, .resize.w {
  top: 14px;
  bottom: 14px;
  width: 8px;
  cursor: ew-resize;
}
.resize.e { right: -4px; }
.resize.w { left: -4px; }

.resize.ne, .resize.nw, .resize.se, .resize.sw {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: transparent;
}
.resize.ne { top: -7px; right: -7px; cursor: nesw-resize; }
.resize.nw { top: -7px; left: -7px;  cursor: nwse-resize; }
.resize.se { bottom: -7px; right: -7px; cursor: nwse-resize; }
.resize.sw { bottom: -7px; left: -7px;  cursor: nesw-resize; }
</style>
