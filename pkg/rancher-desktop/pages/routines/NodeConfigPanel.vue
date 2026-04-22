<template>
  <aside
    class="config-panel"
    :class="{ open }"
    @click.stop
  >
    <header class="c-head">
      <div class="title">
        <div class="k">
          {{ node?.data?.kicker || 'Node' }} · {{ node?.data?.nodeCode || '—' }}
        </div>
        <div class="t">
          {{ editable ? 'Configure' : 'Inspect' }}
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

    <div class="c-body">
      <!-- Preview of the current node state -->
      <div
        v-if="node"
        class="preview"
      >
        <div class="tcard">
          <div class="stub">
            <div class="no">
              {{ node.data.nodeCode }}
            </div>
            <div
              class="av"
              :class="node.data.avatar?.type || 'agent'"
            >
              <template v-if="node.data.avatar?.icon">
                {{ node.data.avatar.icon }}
              </template>
              <template v-else>
                {{ node.data.avatar?.initials || '—' }}
              </template>
            </div>
            <div class="st">
              {{ statusLabel }}
            </div>
          </div>
          <div class="body">
            <div class="k">
              {{ node.data.kicker }}
            </div>
            <div class="t">
              {{ node.data.title || (node.data as any).label || 'Untitled' }}
            </div>
            <div
              v-if="node.data.role"
              class="r"
            >
              {{ node.data.role }}
            </div>
            <div
              v-if="node.data.quote"
              class="q"
            >
              {{ node.data.quote }}
            </div>
          </div>
        </div>
      </div>

      <!-- Execution output — only in run mode. Edit mode is a pristine
           configuration view; stale output from a previous run would
           just confuse the "what does this node do?" question the user
           is here to answer. Run mode has NodeOutputPanel for live
           output, but this block also surfaces output inline when the
           canvas is actively running. -->
      <section
        v-if="node && mode === 'run' && hasExecutionInfo"
        class="exec-section"
      >
        <header class="exec-head">
          <span class="exec-title">Output</span>
          <span
            v-if="node.data.state"
            class="exec-state"
            :class="node.data.state"
          >{{ statusLabel }}</span>
          <span
            v-if="formatExecDuration()"
            class="exec-duration"
          >{{ formatExecDuration() }}</span>
        </header>
        <div
          v-if="node.data.execution?.error"
          class="exec-error"
        >{{ node.data.execution.error }}</div>
        <pre
          v-if="outputText"
          class="exec-output"
        >{{ outputText }}</pre>
        <div
          v-else-if="node.data.state === 'running'"
          class="exec-pending"
        >Working…</div>
      </section>

      <!-- Per-subtype config panel (routed from the workflow editor) -->
      <div
        v-if="node && panelComponent"
        class="c-panel"
      >
        <component
          :is="panelComponent"
          v-bind="panelProps"
          @update-config="(nodeId: string, cfg: Record<string, unknown>) => $emit('update-config', nodeId, cfg)"
        />
      </div>
      <div
        v-else-if="node"
        class="c-empty"
      >
        <span class="ico">◈</span>
        <span>No configuration panel for this node type yet.</span>
      </div>

      <!-- Children — loop frames list their nested cards so the user can
           see the loop body from the edit drawer without having to click
           away. Skipped for nodes with no children. -->
      <section
        v-if="children && children.length > 0"
        class="c-section c-children"
      >
        <header class="c-section-head">
          <span class="c-section-title">Children</span>
          <span class="c-section-count">{{ children.length }}</span>
        </header>
        <ul class="cp-children">
          <li
            v-for="c in children"
            :key="c.nodeId"
            class="cp-child"
            :class="c.state"
          >
            <span
              class="cp-child-av"
              :class="c.avatar?.type"
            >
              <template v-if="c.avatar?.icon">{{ c.avatar.icon }}</template>
              <template v-else>{{ c.avatar?.initials || '—' }}</template>
            </span>
            <span class="cp-child-body">
              <span class="cp-child-kicker">{{ c.kicker }} · {{ c.nodeCode }}</span>
              <span class="cp-child-title">{{ c.label }}</span>
            </span>
            <span
              class="cp-child-state"
              :class="c.state"
            >{{ c.state }}</span>
          </li>
        </ul>
      </section>
    </div>

    <footer
      v-if="!editable"
      class="c-foot"
    >
      <span class="ro">Read-only · switch to edit mode to modify</span>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, type Component } from 'vue';

interface UpstreamNodeInfo {
  nodeId:   string;
  label:    string;
  subtype:  string;
  category: string;
}

interface ChildSummary {
  nodeId:   string;
  label:    string;
  kicker:   string;
  nodeCode: string;
  state:    string;
  avatar:   { type?: string; icon?: string; initials?: string };
}

interface RoutineNodeShape {
  id:   string;
  data: {
    state:      'idle' | 'queued' | 'running' | 'done';
    nodeCode:   string;
    kicker:     string;
    title:      string;
    role?:      string;
    quote?:     string;
    subtype?:   string;
    category?:  string;
    config?:    Record<string, unknown>;
    avatar?:    { type?: string; icon?: string; initials?: string };
    execution?: {
      status?:      'running' | 'completed' | 'failed' | 'waiting' | 'skipped';
      output?:      unknown;
      error?:       string;
      startedAt?:   number;
      completedAt?: number;
    };
  };
}

const props = defineProps<{
  open:           boolean;
  node:           RoutineNodeShape | null;
  mode:           'edit' | 'run';
  upstreamNodes?: UpstreamNodeInfo[];
  /** Children of this node — loop frames list their nested cards at the
   *  bottom of the panel so the user can confirm the loop body. */
  children?:      ChildSummary[];
}>();

defineEmits<{
  close: [];
  save: [payload: { id: string; changes: Record<string, unknown> }];
  'update-config': [nodeId: string, config: Record<string, unknown>];
}>();

const editable = computed(() => props.mode === 'edit');

// Lazily load the workflow editor's config panels so clicking a node doesn't
// spin up all nine of them. Each panel ships its own agent/integration-fetch
// logic — we only want one on screen at a time.
const PANELS: Record<string, Component> = {
  trigger:               defineAsyncComponent(() => import('@pkg/pages/editor/workflow/TriggerNodeConfig.vue')),
  agent:                 defineAsyncComponent(() => import('@pkg/pages/editor/workflow/AgentNodeConfig.vue')),
  'tool-call':           defineAsyncComponent(() => import('@pkg/pages/editor/workflow/ToolCallNodeConfig.vue')),
  'integration-call':    defineAsyncComponent(() => import('@pkg/pages/editor/workflow/IntegrationCallNodeConfig.vue')),
  function:              defineAsyncComponent(() => import('@pkg/pages/editor/workflow/FunctionNodeConfig.vue')),
  'orchestrator-prompt': defineAsyncComponent(() => import('@pkg/pages/editor/workflow/OrchestratorPromptNodeConfig.vue')),
  router:                defineAsyncComponent(() => import('@pkg/pages/editor/workflow/RouterNodeConfig.vue')),
  condition:             defineAsyncComponent(() => import('@pkg/pages/editor/workflow/ConditionNodeConfig.vue')),
  'flow-control':        defineAsyncComponent(() => import('@pkg/pages/editor/workflow/FlowControlNodeConfig.vue')),
  io:                    defineAsyncComponent(() => import('@pkg/pages/editor/workflow/IONodeConfig.vue')),
};

/** Map a node to the right registered panel key. */
function panelKeyFor(node: RoutineNodeShape | null): string | null {
  if (!node) return null;
  const sub = node.data.subtype;
  const cat = node.data.category;
  if (cat === 'trigger') return 'trigger';
  if (sub && PANELS[sub]) return sub;
  if (cat === 'flow-control') return 'flow-control';
  if (cat === 'io') return 'io';
  return null;
}

const panelComponent = computed<Component | null>(() => {
  const key = panelKeyFor(props.node);

  return key ? PANELS[key] : null;
});

const NEEDS_SUBTYPE = new Set(['flow-control', 'io']);
const NEEDS_UPSTREAM = new Set([
  'agent', 'tool-call', 'integration-call', 'function', 'orchestrator-prompt', 'flow-control', 'io',
]);

const panelProps = computed(() => {
  if (!props.node) return {};
  const key = panelKeyFor(props.node);
  const base: Record<string, unknown> = {
    isDark: true,
    nodeId: props.node.id,
    config: props.node.data.config ?? {},
  };
  if (key && NEEDS_SUBTYPE.has(key)) base.subtype = props.node.data.subtype;
  if (key && NEEDS_UPSTREAM.has(key)) base.upstreamNodes = props.upstreamNodes ?? [];

  return base;
});

const statusLabel = computed(() => {
  switch (props.node?.data?.state) {
  case 'running': return 'Live';
  case 'done':    return 'Done';
  case 'queued':  return 'Queue';
  default:        return 'Idle';
  }
});

// Flatten the raw execution output into something the drawer can display
// as prose. Strings pass through, Anthropic-style block arrays get their
// text blocks joined, everything else falls back to pretty JSON. Empty
// string means "nothing worth showing" — the template hides the section.
const outputText = computed<string>(() => {
  const raw = props.node?.data?.execution?.output;
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    const text = raw
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n').trim();
    if (text) return text;
    try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
  }
  if (typeof raw === 'object') {
    try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
  }
  return String(raw);
});

const hasExecutionInfo = computed(() => {
  const exec = props.node?.data?.execution;
  if (!exec) return false;
  return !!exec.output || !!exec.error || !!exec.startedAt;
});

function formatExecDuration(): string {
  const exec = props.node?.data?.execution;
  if (!exec?.startedAt) return '';
  const end = exec.completedAt ?? Date.now();
  const ms = Math.max(end - exec.startedAt, 0);
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${ m }m ${ String(s).padStart(2, '0') }s` : `${ s }s`;
}
</script>

<style scoped>
.config-panel {
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
  --amber-600: #d97706;
  --teal-400: #06b6d4;
  --teal-600: #0891b2;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --serif: "Iowan Old Style", "Palatino", Georgia, serif;

  position: absolute;
  top: 28px;
  bottom: 28px;
  right: 0;
  z-index: 10;
  width: 420px;
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
.config-panel.open {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
}

.c-head {
  padding: 12px 14px 10px;
  border-bottom: 1px solid rgba(168, 192, 220, 0.14);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.c-head .title { display: flex; flex-direction: column; gap: 2px; }
.c-head .k {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.3em;
  color: var(--violet-300);
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.c-head .k::before {
  content: '';
  width: 14px;
  height: 1px;
  background: var(--violet-400);
  display: inline-block;
}
.c-head .t {
  font-family: var(--serif);
  font-size: 15px;
  font-style: italic;
  color: white;
}
.c-head .close {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--steel-300);
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.18);
  font-size: 12px;
  line-height: 1;
  padding: 0;
}
.c-head .close:hover {
  color: white;
  border-color: rgba(167, 139, 250, 0.5);
  background: rgba(139, 92, 246, 0.1);
}

.c-body {
  flex: 1 1 auto;
  min-height: 0;
  height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.c-body > * {
  flex-shrink: 0;
}

/* Preview card */
.preview { padding: 2px; }
.tcard {
  display: flex;
  border-radius: 9px;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(24, 36, 62, 0.95), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(167, 139, 250, 0.45);
  box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.15), 0 0 24px rgba(139, 92, 246, 0.2);
}
.tcard .stub {
  width: 48px;
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-right: 2px dashed rgba(167, 139, 250, 0.45);
  text-align: center;
}
.tcard .stub .no {
  font-family: var(--mono);
  font-size: 8px;
  color: var(--steel-400);
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
.tcard .stub .av {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  margin: 4px 0 3px;
  display: grid;
  place-items: center;
  color: white;
  font-weight: 800;
  font-size: 10px;
  background: linear-gradient(135deg, var(--violet-400), var(--violet-600));
  box-shadow: 0 0 10px rgba(139, 92, 246, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2);
}
.tcard .stub .av.trigger { background: linear-gradient(135deg, var(--amber-400), var(--amber-600)); }
.tcard .stub .av.tool    { background: linear-gradient(135deg, var(--teal-400), var(--teal-600)); }
.tcard .stub .av.logic   { background: linear-gradient(135deg, #94a3b8, #475569); }
.tcard .stub .av.loop    { background: linear-gradient(135deg, #8fb3d9, var(--steel-600)); }
.tcard .stub .st {
  font-family: var(--mono);
  font-size: 7px;
  letter-spacing: 0.18em;
  color: var(--violet-300);
  text-transform: uppercase;
}
.tcard .body {
  flex: 1;
  padding: 8px 10px;
  min-width: 0;
}
.tcard .body .k {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--violet-300);
  text-transform: uppercase;
}
.tcard .body .t {
  font-family: var(--serif);
  font-size: 14px;
  font-style: italic;
  color: white;
  line-height: 1.15;
  margin-top: 2px;
}
.tcard .body .r {
  font-size: 10px;
  color: var(--steel-200);
  opacity: 0.85;
  margin-top: 2px;
}
.tcard .body .q {
  margin-top: 5px;
  padding-left: 7px;
  border-left: 2px solid var(--violet-400);
  font-family: var(--serif);
  font-size: 10.5px;
  font-style: italic;
  color: var(--violet-300);
  line-height: 1.3;
}

/* Execution output — appears above the config panel when a node has
   actually run. Header strip shows the state pill + elapsed; the body
   is a monospace pre for readable JSON / prose output. */
.exec-section {
  margin: 0 0 14px;
  padding: 12px 14px;
  background: rgba(14, 22, 40, 0.7);
  border: 1px solid rgba(167, 139, 250, 0.24);
  border-radius: 8px;
}
.exec-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.exec-title {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--violet-300);
  flex-shrink: 0;
}
.exec-state {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 3px;
  border: 1px solid currentColor;
  flex-shrink: 0;
}
.exec-state.running { color: var(--violet-300); }
.exec-state.done    { color: #7ad4a8; }
.exec-state.failed  { color: #fca5a5; }
.exec-state.queued,
.exec-state.idle    { color: var(--steel-400); }
.exec-duration {
  margin-left: auto;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  color: var(--steel-300);
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
}
.exec-output {
  margin: 0;
  padding: 10px 12px;
  background: rgba(6, 12, 26, 0.7);
  border: 1px solid rgba(168, 192, 220, 0.14);
  border-radius: 6px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.5;
  color: #d6dde8;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 360px;
  overflow: auto;
}
.exec-error {
  margin-bottom: 8px;
  padding: 8px 10px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #fca5a5;
  font-size: 12px;
  line-height: 1.4;
}
.exec-pending {
  padding: 10px 12px;
  color: var(--violet-300);
  font-style: italic;
  font-size: 12px;
}

/* Host container for whichever editor config panel is mounted.
 * The panels were written for the workbench and use global design tokens
 * (--bg-surface, --text-primary, etc.). We override those tokens inside
 * this scope so they render in the routines' deep-ocean / violet palette. */
.c-panel {
  /* Backgrounds */
  --bg-surface:         rgba(14, 22, 40, 0.85);
  --bg-surface-alt:     rgba(20, 30, 54, 0.7);
  --bg-surface-hover:   rgba(139, 92, 246, 0.1);
  --bg-hover:           rgba(139, 92, 246, 0.12);
  --bg-accent:          rgba(139, 92, 246, 0.18);
  --bg-error:           rgba(239, 68, 68, 0.15);

  /* Text */
  --text-primary:       #e6ecf5;
  --text-secondary:     var(--steel-200);
  --text-muted:         var(--steel-400);
  --text-info:          var(--violet-300);
  --text-error:         #fca5a5;

  /* Borders */
  --border-default:     rgba(168, 192, 220, 0.18);
  --border-strong:      rgba(168, 192, 220, 0.35);
  --border-accent:      rgba(167, 139, 250, 0.55);

  /* Accent */
  --accent-primary:     var(--violet-500);

  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  overflow: hidden;
  color: #e6ecf5;
}

/* Inputs / textareas / selects — lifted a full step above the drawer bg
 * so they read as distinct controls instead of dark-on-dark. */
.c-panel :deep(input),
.c-panel :deep(textarea),
.c-panel :deep(select) {
  background: rgba(168, 192, 220, 0.06);
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: white;
  border-radius: 6px;
}
.c-panel :deep(input::placeholder),
.c-panel :deep(textarea::placeholder) {
  color: var(--steel-500);
}
.c-panel :deep(input:hover),
.c-panel :deep(textarea:hover),
.c-panel :deep(select:hover) {
  background: rgba(168, 192, 220, 0.1);
  border-color: rgba(168, 192, 220, 0.32);
}
.c-panel :deep(input:focus),
.c-panel :deep(textarea:focus),
.c-panel :deep(select:focus) {
  background: rgba(168, 192, 220, 0.12);
  border-color: rgba(167, 139, 250, 0.55);
  box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.15);
  outline: none;
}
.c-panel :deep(select) {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 28px;
  background-image: linear-gradient(45deg, transparent 49%, var(--steel-400) 49%, var(--steel-400) 51%, transparent 51%),
                    linear-gradient(-45deg, transparent 49%, var(--steel-400) 49%, var(--steel-400) 51%, transparent 51%);
  background-size: 5px 5px, 5px 5px;
  background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%;
  background-repeat: no-repeat;
}
.c-panel :deep(select option) {
  background: #0e1a2e;
  color: white;
}

/* Buttons inside editor panels */
.c-panel :deep(button) {
  background: rgba(20, 30, 54, 0.7);
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--steel-200);
  border-radius: 5px;
}
.c-panel :deep(button:hover:not(:disabled)) {
  color: white;
  border-color: rgba(167, 139, 250, 0.45);
  background: rgba(139, 92, 246, 0.15);
}

/* Section dividers / field rows */
.c-panel :deep(.node-field) {
  border-bottom-color: rgba(168, 192, 220, 0.1) !important;
}
.c-panel :deep(.node-field:last-child) {
  border-bottom: none !important;
}

/* Labels */
.c-panel :deep(.node-field-label),
.c-panel :deep(label) {
  color: var(--steel-400);
}

/* Help text — lighten subtly */
.c-panel :deep(.help-text),
.c-panel :deep(.help-title) {
  color: var(--steel-300) !important;
}
.c-panel :deep(.help-text code) {
  background: rgba(139, 92, 246, 0.14);
  color: var(--violet-200);
  border: 1px solid rgba(167, 139, 250, 0.22);
  padding: 0 4px;
  border-radius: 3px;
}

/* Combobox / dropdown styling from AgentNodeConfig */
.c-panel :deep(.combo-dropdown),
.c-panel :deep(.var-menu) {
  background: linear-gradient(180deg, rgba(20, 30, 54, 0.98), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(168, 192, 220, 0.25);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.55);
}
.c-panel :deep(.combo-option),
.c-panel :deep(.var-menu-item) {
  color: var(--steel-200);
}
.c-panel :deep(.combo-option:hover),
.c-panel :deep(.combo-option.active),
.c-panel :deep(.var-menu-item:hover) {
  background: rgba(167, 139, 250, 0.18);
  color: white;
}
.c-panel :deep(.combo-option.selected) {
  background: rgba(139, 92, 246, 0.3);
  color: white;
}
.c-panel :deep(.combo-option-name) { color: white; }
.c-panel :deep(.combo-option-desc) { color: var(--steel-400); }
.c-panel :deep(.combo-empty) { color: var(--steel-500); }

.c-panel :deep(.var-insert-btn) {
  background: rgba(20, 30, 54, 0.7);
  border-color: rgba(168, 192, 220, 0.2);
  color: var(--steel-300);
}
.c-panel :deep(.var-insert-btn:hover) {
  color: var(--violet-200);
  border-color: rgba(167, 139, 250, 0.55);
  background: rgba(139, 92, 246, 0.15);
}

.c-empty {
  padding: 20px;
  text-align: center;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  color: var(--steel-400);
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.c-empty .ico {
  font-size: 18px;
  color: var(--violet-400);
  opacity: 0.6;
}

.c-foot {
  padding: 10px 12px;
  border-top: 1px solid rgba(168, 192, 220, 0.14);
  display: flex;
  align-items: center;
}
.c-foot .ro {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  color: var(--steel-400);
  text-transform: uppercase;
}

/* ── Children list (loop body summary) ── */
.c-section {
  padding: 0 14px;
  margin-top: 14px;
}
.c-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  margin-bottom: 8px;
  border-bottom: 1px dashed rgba(168, 192, 220, 0.15);
}
.c-section-title {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.25em;
  color: var(--violet-300);
  text-transform: uppercase;
}
.c-section-count {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--steel-400);
}
.cp-children {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cp-child {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 7px 9px;
  border-radius: 7px;
  background: rgba(20, 30, 54, 0.55);
  border: 1px solid rgba(168, 192, 220, 0.12);
}
.cp-child.running { border-color: rgba(167, 139, 250, 0.35); }
.cp-child.done    { border-color: rgba(122, 212, 168, 0.3); }
.cp-child.failed  { border-color: rgba(244, 63, 94, 0.35); }
.cp-child-av {
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
.cp-child-av.trigger { background: linear-gradient(135deg, var(--amber-400), var(--amber-600)); }
.cp-child-av.tool    { background: linear-gradient(135deg, var(--teal-400), var(--teal-600)); }
.cp-child-av.logic   { background: linear-gradient(135deg, #94a3b8, #475569); }
.cp-child-av.loop    { background: linear-gradient(135deg, var(--violet-400), var(--violet-600)); }
.cp-child-av.agent   { background: linear-gradient(135deg, var(--violet-400), var(--violet-600)); }
.cp-child-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.cp-child-kicker {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.18em;
  color: var(--steel-400);
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cp-child-title {
  font-family: var(--serif);
  font-size: 13px;
  font-style: italic;
  color: white;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cp-child-state {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 3px;
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--steel-300);
}
.cp-child-state.running {
  color: var(--violet-200);
  border-color: rgba(167, 139, 250, 0.4);
  background: rgba(139, 92, 246, 0.12);
}
.cp-child-state.done {
  color: #7ad4a8;
  border-color: rgba(122, 212, 168, 0.35);
}
.cp-child-state.failed {
  color: var(--rose-400);
  border-color: rgba(244, 63, 94, 0.35);
}
</style>
