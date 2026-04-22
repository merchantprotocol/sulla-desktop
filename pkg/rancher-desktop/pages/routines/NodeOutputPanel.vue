<template>
  <aside
    class="output-panel"
    :class="{ open }"
    @click.stop
  >
    <header class="op-head">
      <div class="title">
        <div class="k">
          {{ node?.data?.kicker || 'Node' }} · {{ node?.data?.nodeCode || '—' }}
        </div>
        <div class="t">
          {{ node?.data?.title || node?.data?.label || 'Output' }}
        </div>
      </div>
      <button
        type="button"
        class="close"
        aria-label="Close"
        @click="$emit('close')"
      >
        ✕
      </button>
    </header>

    <div class="op-meta">
      <span
        class="state"
        :class="node?.data?.state || 'idle'"
      >
        <span class="dot" />
        {{ statusLabel }}
      </span>
      <span
        v-if="durationLabel"
        class="dur"
      >{{ durationLabel }}</span>
    </div>

    <div
      v-if="node?.data?.execution?.error"
      class="op-error"
    >
      <div class="err-label">Error</div>
      <div class="err-msg">
        {{ node.data.execution.error }}
      </div>
    </div>

    <div class="op-body">
      <!-- Turns timeline — conversation log filtered to this node. Only
           rendered when we've actually captured lines for this node; an
           empty list would just add a header with nothing under it. -->
      <section
        v-if="turns.length > 0"
        class="op-section"
      >
        <div class="op-section-head">
          <span class="op-section-title">Turns</span>
          <span class="op-section-count">{{ turns.length }}</span>
        </div>
        <ol class="turns">
          <li
            v-for="(t, idx) in turns"
            :key="idx"
            class="turn"
            :class="t.k"
          >
            <span class="turn-time">{{ t.t }}</span>
            <span
              class="turn-kind"
              :class="t.k"
            >{{ t.badge || kindLabel(t.k) }}</span>
            <!-- Rendered as markdown — agent prose usually contains
                 headers, bullet lists, code spans; the raw string would
                 read as cluttered source instead of a conversation. -->
            <span
              class="turn-msg md"
              v-html="renderMarkdown(t.msg)"
            />
          </li>
        </ol>
      </section>

      <!-- Final/latest output. One section per block — orchestrator
           delegation responses carry multiple sub-agent results bundled
           in a single JSON envelope; we unpack those into labeled blocks
           so the drawer reads as prose instead of a one-line JSON blob. -->
      <section
        v-if="outputBlocks.length > 0"
        class="op-section"
      >
        <div class="op-section-head">
          <span class="op-section-title">Output</span>
          <span
            v-if="outputBlocks.length > 1"
            class="op-section-count"
          >{{ outputBlocks.length }}</span>
        </div>
        <div class="op-blocks">
          <article
            v-for="(block, idx) in outputBlocks"
            :key="idx"
            class="op-block"
            :class="{ json: block.format === 'json' }"
          >
            <div
              v-if="block.label"
              class="op-block-head"
            >
              <span class="op-block-title">{{ block.label }}</span>
              <span
                v-if="block.sub"
                class="op-block-sub"
              >{{ block.sub }}</span>
            </div>
            <!-- Prose blocks render as markdown; JSON blocks stay as a
                 raw pre so structure isn't mangled by the parser. -->
            <div
              v-if="block.format === 'json'"
              class="op-output json"
            >
              <pre>{{ block.text }}</pre>
            </div>
            <div
              v-else
              class="op-output md"
              v-html="renderMarkdown(block.text)"
            />
          </article>
        </div>
      </section>

      <!-- Idle/queued node with nothing to show — tell the user why the
           panel is empty instead of leaving a blank column. -->
      <section
        v-if="turns.length === 0 && outputBlocks.length === 0 && !node?.data?.execution?.error"
        class="op-empty"
      >
        <span class="ico">◉</span>
        <span class="msg">{{ emptyMessage }}</span>
      </section>

      <!-- Children — loop frames list their nested cards here so the user
           can confirm what's actually inside without having to eyeball the
           canvas. Skipped when the node has no children (e.g. regular
           routine cards). -->
      <section
        v-if="children && children.length > 0"
        class="op-section"
      >
        <header class="op-section-head">
          <span class="op-section-title">Children</span>
          <span class="op-section-count">{{ children.length }}</span>
        </header>
        <ul class="op-children">
          <li
            v-for="c in children"
            :key="c.nodeId"
            class="op-child"
            :class="c.state"
          >
            <span
              class="op-child-av"
              :class="c.avatar?.type"
            >
              <template v-if="c.avatar?.icon">{{ c.avatar.icon }}</template>
              <template v-else>{{ c.avatar?.initials || '—' }}</template>
            </span>
            <span class="op-child-body">
              <span class="op-child-kicker">{{ c.kicker }} · {{ c.nodeCode }}</span>
              <span class="op-child-title">{{ c.label }}</span>
            </span>
            <span
              class="op-child-state"
              :class="c.state"
            >{{ c.state }}</span>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>

<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed } from 'vue';

// Marked setup — GitHub-flavored is already the default in v17, but
// turn off header-id generation since the drawer can mount multiple
// instances of the same heading on one run and ids would collide.
marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(raw: string): string {
  const text = typeof raw === 'string' ? raw : String(raw || '');
  if (!text.trim()) return '';
  const html = (marked.parse(text) as string) || '';
  return DOMPurify.sanitize(html, {
    USE_PROFILES:       { html: true },
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|data:image\/(?:png|gif|jpe?g|webp);base64,|\/|\.|#)/i,
  });
}

/**
 * Run-mode output drawer. Mirrors NodeConfigPanel's frame + header but
 * drops the config form in favor of a per-node turn log and the latest
 * output value. Used only during run mode (see AgentRoutines.vue); edit
 * mode still opens NodeConfigPanel for node configuration.
 */
interface NodeTurnShape {
  t:      string;
  k:      'tool' | 'obs' | 'thk' | 'dec' | 'err';
  msg:    string;
  badge?: string;
}

interface NodeShape {
  id:   string;
  data: {
    state?:    'idle' | 'queued' | 'running' | 'done' | 'failed';
    nodeCode?: string;
    kicker?:   string;
    title?:    string;
    label?:    string;
    execution?: {
      status?:      'running' | 'completed' | 'failed' | 'waiting' | 'skipped';
      output?:      unknown;
      error?:       string;
      startedAt?:   number;
      completedAt?: number;
      turns?:       NodeTurnShape[];
    };
  };
}

interface ChildSummary {
  nodeId:   string;
  label:    string;
  kicker:   string;
  nodeCode: string;
  state:    string;
  avatar:   { type?: string; icon?: string; initials?: string };
}

const props = defineProps<{
  open:      boolean;
  node:      NodeShape | null;
  /** Children of this node (loop frames list their nested cards). Shown
   *  at the bottom of the drawer so the user can confirm what's inside. */
  children?: ChildSummary[];
}>();

defineEmits<{
  close: [];
}>();

// Turns live on the node itself (node.data.execution.turns) — the parent
// pushes into that buffer as node-attributed events arrive, so each node
// keeps its own persistent conversation log independent of the global
// stream's rolling horizon.
const turns = computed<NodeTurnShape[]>(() => {
  return props.node?.data?.execution?.turns ?? [];
});

const statusLabel = computed(() => {
  switch (props.node?.data?.state) {
  case 'running': return 'Live';
  case 'done':    return 'Done';
  case 'queued':  return 'Queued';
  case 'failed':  return 'Failed';
  default:        return 'Idle';
  }
});

const emptyMessage = computed(() => {
  const state = props.node?.data?.state;
  if (state === 'running') return 'Working — no turns emitted yet.';
  if (state === 'queued')  return 'Queued — nothing to show until this card runs.';
  if (state === 'failed')  return 'Failed with no output captured.';
  if (state === 'done')    return 'Completed with no captured output.';
  return 'Idle — this card has not run yet.';
});

// A single displayable chunk of output. The drawer renders one per
// block so the orchestrator's delegation envelope (which bundles
// multiple sub-agent results in a single JSON object) unpacks into
// readable labeled sections instead of a one-line JSON blob.
interface OutputBlock {
  /** Optional heading shown above the block (sub-agent label, etc). */
  label?:  string;
  /** Optional smaller text shown next to the label (nodeId, strategy). */
  sub?:    string;
  /** Body — prose or pretty-printed JSON. */
  text:    string;
  /** Hint to the template for monospace / wider max-width styling. */
  format?: 'prose' | 'json';
}

// Try to parse a string as JSON. Returns undefined if it doesn't look
// parseable — a quick shape check avoids throwing for every plain-prose
// response (which is the common case).
function tryParseJson(s: string): unknown | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return undefined;
  try { return JSON.parse(trimmed) } catch { return undefined }
}

// Extract prose text from an Anthropic-style content-block array.
function joinAnthropicBlocks(arr: any[]): string {
  return arr
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n').trim();
}

// Break a raw output value into one or more readable blocks. Handles the
// shapes we actually see in production:
//   • plain string prose                       → one block, as-is
//   • string that parses to JSON               → recurse on parsed value
//   • Anthropic content-block array            → join text blocks
//   • orchestrator delegation envelope
//     `{strategy, merged: [{label, result}]}`  → one labeled block per merged item
//   • arbitrary object/array                   → pretty-printed JSON
function blocksFromOutput(raw: unknown): OutputBlock[] {
  if (raw == null) return [];

  // Strings: passthrough if prose, recurse if JSON.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parsed = tryParseJson(trimmed);
    if (parsed !== undefined) return blocksFromOutput(parsed);
    return [{ text: trimmed, format: 'prose' }];
  }

  // Arrays: Anthropic content blocks first, fall back to pretty JSON.
  if (Array.isArray(raw)) {
    const joined = joinAnthropicBlocks(raw);
    if (joined) return [{ text: joined, format: 'prose' }];
    try {
      return [{ text: JSON.stringify(raw, null, 2), format: 'json' }];
    } catch { return [{ text: String(raw), format: 'prose' }] }
  }

  // Orchestrator delegation envelope — unpack every merged sub-agent
  // result into its own labeled block so the drawer reads like a
  // conversation, not a config dump.
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const merged = obj.merged;
    if (Array.isArray(merged) && merged.length > 0 &&
        merged.every((m: any) => m && typeof m === 'object' && 'result' in m)) {
      const strategy = typeof obj.strategy === 'string' ? obj.strategy : undefined;
      return merged.map((m: any, idx: number) => {
        // Each result is usually prose but may itself be a JSON blob —
        // recurse so a delegation-of-delegation still renders nicely.
        const resultRaw = m.result;
        const nested = blocksFromOutput(resultRaw);
        const head = {
          label: typeof m.label === 'string' && m.label.trim()
            ? m.label
            : (typeof m.nodeId === 'string' ? m.nodeId : `Result ${ idx + 1 }`),
          sub: [strategy, typeof m.nodeId === 'string' ? m.nodeId : null]
            .filter(Boolean).join(' · ') || undefined,
        };
        // If the nested parse produced exactly one prose block, promote
        // it under the head label. Multiple / json blocks stay below as
        // raw blocks without duplicated headers.
        if (nested.length === 1 && nested[0].format === 'prose') {
          return { ...head, text: nested[0].text, format: 'prose' as const };
        }
        return {
          ...head,
          text:   nested.map(n => n.text).join('\n\n') || String(resultRaw ?? ''),
          format: nested.every(n => n.format === 'prose') ? 'prose' as const : 'json' as const,
        };
      });
    }

    // Common "single result" envelope shapes.
    if (typeof obj.result === 'string') {
      return blocksFromOutput(obj.result);
    }
    if (typeof obj.text === 'string') {
      return blocksFromOutput(obj.text);
    }
    if (typeof obj.output === 'string') {
      return blocksFromOutput(obj.output);
    }

    try {
      return [{ text: JSON.stringify(raw, null, 2), format: 'json' }];
    } catch { return [{ text: String(raw), format: 'prose' }] }
  }

  return [{ text: String(raw), format: 'prose' }];
}

const outputBlocks = computed<OutputBlock[]>(() => {
  return blocksFromOutput(props.node?.data?.execution?.output);
});

const durationLabel = computed(() => {
  const exec = props.node?.data?.execution;
  if (!exec?.startedAt) return '';
  const end = exec.completedAt ?? Date.now();
  const ms = Math.max(end - exec.startedAt, 0);
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${ m }m ${ String(s).padStart(2, '0') }s` : `${ s }s`;
});

function kindLabel(k: NodeTurnShape['k']): string {
  switch (k) {
  case 'tool': return 'tool';
  case 'obs':  return 'observed';
  case 'thk':  return 'thinking';
  case 'dec':  return 'decided';
  case 'err':  return 'error';
  default:     return k;
  }
}
</script>

<style scoped>
.output-panel {
  --steel-100: #c4d4e6;
  --steel-200: #a8c0dc;
  --steel-300: #8cacc9;
  --steel-400: #6989b3;
  --steel-500: #4a6fa5;
  --steel-600: #375789;
  --steel-700: #2c4871;
  --violet-200: #ddd6fe;
  --violet-300: #c4b5fd;
  --violet-400: #a78bfa;
  --violet-500: #8b5cf6;
  --violet-600: #7c3aed;
  --amber-400: #f59e0b;
  --teal-400: #06b6d4;
  --rose-300: #fda4af;
  --rose-400: #fb7185;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --serif: "Iowan Old Style", "Palatino", Georgia, serif;

  position: absolute;
  top: 28px;
  bottom: 28px;
  right: 0;
  z-index: 10;
  width: 440px;
  background: linear-gradient(180deg, rgba(20, 30, 54, 0.92), rgba(14, 22, 40, 0.95));
  border: 1px solid rgba(168, 192, 220, 0.22);
  border-right: none;
  border-radius: 12px 0 0 12px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 30px rgba(139, 92, 246, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #e6ecf5;
  transform: translateX(100%);
  opacity: 0;
  pointer-events: none;
  transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.25, 1), opacity 0.22s ease;
}
.output-panel.open {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
}

.op-head {
  padding: 12px 14px 10px;
  border-bottom: 1px solid rgba(168, 192, 220, 0.14);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.op-head .title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.op-head .k {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.3em;
  color: var(--violet-300);
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.op-head .k::before {
  content: '';
  width: 14px;
  height: 1px;
  background: var(--violet-400);
  flex-shrink: 0;
}
.op-head .t {
  font-family: var(--serif);
  font-size: 18px;
  font-style: italic;
  color: white;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.op-head .close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid rgba(168, 192, 220, 0.18);
  background: transparent;
  color: var(--steel-200);
  cursor: pointer;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.op-head .close:hover {
  color: white;
  border-color: rgba(167, 139, 250, 0.4);
  background: rgba(139, 92, 246, 0.12);
}

/* Meta strip — state pill + duration */
.op-meta {
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid rgba(168, 192, 220, 0.1);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.op-meta .state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--steel-200);
}
.op-meta .state .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--steel-400);
}
.op-meta .state.running {
  color: var(--violet-200);
  border-color: rgba(167, 139, 250, 0.45);
}
.op-meta .state.running .dot {
  background: var(--violet-400);
  box-shadow: 0 0 6px var(--violet-400);
  animation: op-pulse 1s infinite;
}
.op-meta .state.done {
  color: #7ad4a8;
  border-color: rgba(122, 212, 168, 0.4);
}
.op-meta .state.done .dot { background: #7ad4a8; }
.op-meta .state.failed {
  color: var(--rose-400);
  border-color: rgba(244, 63, 94, 0.4);
}
.op-meta .state.failed .dot { background: var(--rose-400); }
.op-meta .dur {
  color: var(--steel-300);
  font-variant-numeric: tabular-nums;
}
@keyframes op-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* Error block sits outside the scrollable body so it never gets lost
   below the fold when turns pile up — errors should always be one
   glance away. */
.op-error {
  margin: 10px 14px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(244, 63, 94, 0.08);
  border: 1px solid rgba(244, 63, 94, 0.3);
}
.op-error .err-label {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--rose-400);
  text-transform: uppercase;
  margin-bottom: 4px;
}
.op-error .err-msg {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--rose-300);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.op-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px 14px;
  scrollbar-width: thin;
  scrollbar-color: rgba(168, 192, 220, 0.25) transparent;
}
.op-body::-webkit-scrollbar { width: 6px; }
.op-body::-webkit-scrollbar-thumb {
  background: rgba(168, 192, 220, 0.25);
  border-radius: 3px;
}
.op-body::-webkit-scrollbar-thumb:hover { background: rgba(167, 139, 250, 0.4); }

.op-section + .op-section { margin-top: 14px; }
/* Using div (not <header>) so a global `header {}` theme rule can't
   slap a solid-black background on these — the drawer is already on a
   dark panel, an opaque strip on top looks like a bug. */
.op-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding-bottom: 6px;
  background: transparent;
  border-bottom: 1px dashed rgba(168, 192, 220, 0.15);
}
.op-section-title {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.25em;
  color: var(--violet-300);
  text-transform: uppercase;
}
.op-section-count {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--steel-400);
  letter-spacing: 0.08em;
}

/* Turn list — each line echoes the top-left stream row's layout so the
   drawer reads as a *filtered view* of the same conversation, not a
   different UI. */
.turns {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
}
.turn {
  display: grid;
  grid-template-columns: 44px 72px 1fr;
  gap: 8px;
  padding: 3px 0;
  align-items: start;
}
.turn + .turn { border-top: 1px dashed rgba(168, 192, 220, 0.08); }
.turn-time {
  font-size: 10px;
  color: var(--steel-400);
  font-variant-numeric: tabular-nums;
}
.turn-kind {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 3px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.turn-kind.tool { background: rgba(168, 192, 220, 0.18); color: var(--steel-100); border: 1px solid rgba(168, 192, 220, 0.25); }
.turn-kind.obs  { background: rgba(74, 111, 165, 0.25); color: #b4d0f0; border: 1px solid rgba(116, 158, 214, 0.35); }
.turn-kind.thk  { background: rgba(196, 181, 253, 0.18); color: var(--violet-300); border: 1px solid rgba(167, 139, 250, 0.35); }
.turn-kind.dec  { background: rgba(139, 92, 246, 0.25); color: var(--violet-200); border: 1px solid rgba(167, 139, 250, 0.55); }
.turn-kind.err  { background: rgba(244, 63, 94, 0.18); color: var(--rose-300); border: 1px solid rgba(244, 63, 94, 0.35); }
.turn-msg {
  color: var(--steel-200);
  word-break: break-word;
}
.turn.thk .turn-msg { color: #d8cdfa; }
.turn.err .turn-msg { color: var(--rose-300); }

/* Markdown inside a turn-msg cell — compact spacing since each turn
   is one narrow row in the grid. Uses :deep() because v-html strips
   Vue's scope attribute. */
.turn-msg.md :deep(p) { margin: 0 0 4px; }
.turn-msg.md :deep(p:last-child) { margin-bottom: 0; }
.turn-msg.md :deep(ul),
.turn-msg.md :deep(ol) { margin: 2px 0 4px; padding-left: 18px; }
.turn-msg.md :deep(li) { margin: 1px 0; }
.turn-msg.md :deep(code) {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(168, 192, 220, 0.08);
  color: var(--steel-100);
}
.turn-msg.md :deep(pre) {
  margin: 4px 0;
  padding: 6px 8px;
  background: rgba(6, 12, 26, 0.6);
  border: 1px solid rgba(168, 192, 220, 0.1);
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.45;
  overflow-x: auto;
}
.turn-msg.md :deep(strong) { color: white; }
.turn-msg.md :deep(a) { color: #7dd3fc; text-decoration: underline; }
.turn-msg.md :deep(h1),
.turn-msg.md :deep(h2),
.turn-msg.md :deep(h3),
.turn-msg.md :deep(h4) {
  margin: 6px 0 3px;
  font-size: 11.5px;
  font-weight: 700;
  color: white;
  background: transparent;
}

/* One or more output blocks stacked vertically. Each block has its own
   labeled header (sub-agent name) + body. Prose blocks use serif-friendly
   sizing and looser leading; JSON blocks stay monospaced. */
.op-blocks {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.op-block {
  background: rgba(14, 22, 40, 0.55);
  border: 1px solid rgba(168, 192, 220, 0.14);
  border-radius: 8px;
  overflow: hidden;
}
/* Using div (not <header>) so a global `header {}` theme rule can't
   paint a solid-black background over this strip. */
.op-block-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(105, 137, 179, 0.08);
  border-bottom: 1px solid rgba(168, 192, 220, 0.1);
}
.op-block-title {
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  color: white;
  letter-spacing: 0.01em;
}
.op-block-sub {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--steel-400);
}
.op-output {
  margin: 0;
  padding: 12px 14px;
  background: transparent;
  border: none;
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.6;
  color: #e6ecf5;
  overflow-x: auto;
}
/* Plain JSON blocks keep the <pre> inside untouched so structure
   (nesting, whitespace) stays readable. */
.op-output.json {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.55;
}
.op-output.json pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Markdown rendered via v-html ──
   Scoped styles don't reach v-html content by default, so these use
   :deep() on the parent. Keeps headings/lists/code tight to the dark
   drawer palette. */
.op-output.md :deep(p) {
  margin: 0 0 10px;
}
.op-output.md :deep(p:last-child) { margin-bottom: 0; }
.op-output.md :deep(h1),
.op-output.md :deep(h2),
.op-output.md :deep(h3),
.op-output.md :deep(h4) {
  margin: 14px 0 6px;
  color: white;
  font-weight: 700;
  line-height: 1.25;
  background: transparent;
}
.op-output.md :deep(h1) { font-size: 17px; }
.op-output.md :deep(h2) { font-size: 15px; color: var(--violet-200); }
.op-output.md :deep(h3) { font-size: 13px; color: var(--steel-100); text-transform: uppercase; letter-spacing: 0.08em; }
.op-output.md :deep(h4) { font-size: 12px; color: var(--steel-200); }
.op-output.md :deep(ul),
.op-output.md :deep(ol) {
  margin: 0 0 10px;
  padding-left: 20px;
}
.op-output.md :deep(li) { margin: 2px 0; }
.op-output.md :deep(li::marker) { color: var(--steel-400); }
.op-output.md :deep(strong) { color: white; font-weight: 700; }
.op-output.md :deep(em) { color: var(--violet-200); }
.op-output.md :deep(a) {
  color: #7dd3fc;
  text-decoration: none;
  border-bottom: 1px dashed rgba(125, 211, 252, 0.5);
}
.op-output.md :deep(a:hover) { color: white; border-bottom-color: white; }
.op-output.md :deep(code) {
  font-family: var(--mono);
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(168, 192, 220, 0.08);
  color: var(--steel-100);
  border: 1px solid rgba(168, 192, 220, 0.12);
}
.op-output.md :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  background: rgba(6, 12, 26, 0.7);
  border: 1px solid rgba(168, 192, 220, 0.12);
  border-radius: 6px;
  overflow-x: auto;
}
.op-output.md :deep(pre code) {
  padding: 0;
  background: transparent;
  border: none;
  font-size: 11px;
  line-height: 1.55;
  color: #d6dde8;
}
.op-output.md :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 2px solid var(--violet-400);
  color: var(--violet-200);
  font-style: italic;
  background: rgba(139, 92, 246, 0.06);
}
.op-output.md :deep(hr) {
  border: none;
  border-top: 1px dashed rgba(168, 192, 220, 0.2);
  margin: 12px 0;
}
.op-output.md :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}
.op-output.md :deep(th),
.op-output.md :deep(td) {
  padding: 6px 10px;
  border: 1px solid rgba(168, 192, 220, 0.14);
  text-align: left;
}
.op-output.md :deep(th) {
  background: rgba(105, 137, 179, 0.1);
  color: white;
  font-weight: 600;
}

.op-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--steel-400);
  text-align: center;
  gap: 10px;
}
.op-empty .ico {
  font-size: 20px;
  color: var(--steel-500);
}
.op-empty .msg {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  line-height: 1.5;
}

/* ── Children list — loop body summary ── */
.op-children {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.op-child {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 7px 9px;
  border-radius: 7px;
  background: rgba(20, 30, 54, 0.55);
  border: 1px solid rgba(168, 192, 220, 0.12);
}
.op-child.running { border-color: rgba(167, 139, 250, 0.35); }
.op-child.done    { border-color: rgba(122, 212, 168, 0.3); }
.op-child.failed  { border-color: rgba(244, 63, 94, 0.35); }

.op-child-av {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  color: white;
  font-weight: 800;
  font-size: 10px;
  background: linear-gradient(135deg, var(--steel-400), var(--steel-600));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.op-child-av.trigger { background: linear-gradient(135deg, var(--amber-400), #d97706); }
.op-child-av.tool    { background: linear-gradient(135deg, var(--teal-400), #0891b2); }
.op-child-av.logic   { background: linear-gradient(135deg, #94a3b8, #475569); }
.op-child-av.loop    { background: linear-gradient(135deg, var(--violet-400), var(--violet-600)); }
.op-child-av.agent   { background: linear-gradient(135deg, var(--violet-400), var(--violet-600)); }

.op-child-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.op-child-kicker {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.18em;
  color: var(--steel-400);
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.op-child-title {
  font-family: var(--serif);
  font-size: 13px;
  font-style: italic;
  color: white;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.op-child-state {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 3px;
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--steel-300);
}
.op-child-state.running {
  color: var(--violet-200);
  border-color: rgba(167, 139, 250, 0.4);
  background: rgba(139, 92, 246, 0.12);
}
.op-child-state.done {
  color: #7ad4a8;
  border-color: rgba(122, 212, 168, 0.35);
}
.op-child-state.failed {
  color: var(--rose-400);
  border-color: rgba(244, 63, 94, 0.35);
}
</style>
