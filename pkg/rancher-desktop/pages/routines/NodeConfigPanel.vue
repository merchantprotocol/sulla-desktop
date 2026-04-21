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
              {{ node.data.title || 'Untitled' }}
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
  };
}

const props = defineProps<{
  open:           boolean;
  node:           RoutineNodeShape | null;
  mode:           'edit' | 'run';
  upstreamNodes?: UpstreamNodeInfo[];
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
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
</style>
