<template>
  <div
    ref="frameRef"
    class="routines-frame"
    @dragover.prevent="onDragOver"
    @drop.prevent="onDrop"
  >
    <VueFlow
      v-model:nodes="nodes"
      v-model:edges="edges"
      :default-viewport="{ zoom: 1 }"
      :default-edge-options="{ type: 'smoothstep', pathOptions: { borderRadius: 12, offset: 20 } }"
      :delete-key-code="null"
      fit-view-on-init
      class="routines-flow"
      :class="{ locked }"
      @pane-context-menu="onPaneContextMenu"
      @pane-click="onPaneClick"
      @node-click="onNodeClick"
      @node-context-menu="onNodeContextMenu"
      @edge-click="onEdgeClick"
      @connect="onConnect"
    >
      <template #node-routine="nodeProps">
        <RoutineNode v-bind="nodeProps" />
      </template>
      <Background
        :variant="BackgroundVariant.Lines"
        :gap="32"
        :size="1"
        pattern-color="rgba(140,172,210,0.045)"
      />
      <Controls
        position="bottom-left"
        :show-fit-view="true"
        :show-zoom="true"
        :show-interactive="mode === 'edit'"
        @interaction-change="onInteractionChange"
      >
        <template #icon-zoom-in>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle
              cx="10.5"
              cy="10.5"
              r="6.5"
            />
            <line
              x1="20"
              y1="20"
              x2="15.1"
              y2="15.1"
            />
            <line
              x1="10.5"
              y1="7.5"
              x2="10.5"
              y2="13.5"
            />
            <line
              x1="7.5"
              y1="10.5"
              x2="13.5"
              y2="10.5"
            />
          </svg>
        </template>
        <template #icon-zoom-out>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle
              cx="10.5"
              cy="10.5"
              r="6.5"
            />
            <line
              x1="20"
              y1="20"
              x2="15.1"
              y2="15.1"
            />
            <line
              x1="7.5"
              y1="10.5"
              x2="13.5"
              y2="10.5"
            />
          </svg>
        </template>
        <ControlButton
          class="mode-toggle"
          :class="{ 'is-edit': mode === 'edit' }"
          :title="mode === 'edit' ? 'Save (switch to run mode)' : 'Edit routine'"
          @click="toggleMode"
        >
          <svg
            v-if="mode === 'run'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 20h4l10.5 -10.5a2.121 2.121 0 0 0 -3 -3L5 17v3z" />
            <line
              x1="13.5"
              y1="6.5"
              x2="17.5"
              y2="10.5"
            />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M5 4h11l4 4v12a1 1 0 0 1 -1 1H5a1 1 0 0 1 -1 -1V5a1 1 0 0 1 1 -1z" />
            <polyline points="7 4 7 9 14 9" />
            <rect
              x="7"
              y="13"
              width="10"
              height="7"
            />
          </svg>
        </ControlButton>
      </Controls>
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        bg-color="rgba(0,0,0,0)"
        mask-color="rgba(20,30,54,0.55)"
        mask-stroke-color="rgba(167,139,250,0.5)"
        :mask-stroke-width="1"
        node-color="rgba(196,181,253,0.85)"
        node-stroke-color="rgba(221,214,254,0.9)"
      />
    </VueFlow>

    <div class="glow blue" />
    <div class="glow violet" />
    <div class="stars" />
    <div class="bracket tl" />
    <div class="bracket tr" />
    <div class="bracket bl" />
    <div class="bracket br" />

    <div
      v-if="mode === 'run'"
      ref="streamRef"
      class="stream"
    >
      <div
        v-if="liveEvents.length === 0"
        class="line"
      >
        <span class="t">--:--:--</span>
        <span class="k dec">idle</span>
        <span class="msg">press ▶ to start a run</span>
      </div>
      <div
        v-for="(line, idx) in liveEvents"
        v-else
        :key="idx"
        class="line"
        :class="{ current: idx === liveEvents.length - 1 }"
      >
        <span class="t">{{ line.t }}</span>
        <span
          class="k"
          :class="line.k"
        >{{ streamKindLabel(line.k) }}</span>
        <span class="msg">{{ line.msg }}</span>
      </div>
    </div>

    <div class="title-block">
      <div class="title-kicker">
        <span class="d" />{{ mode === 'edit' ? 'EDIT MODE' : 'LIVE' }}
        <span
          v-if="persistenceLabel"
          class="save-status"
          :class="persistence.status.value"
        >· {{ persistenceLabel }}</span>
      </div>
      <div
        class="title-main"
        :class="{ editable: mode === 'edit' }"
        :contenteditable="mode === 'edit'"
        spellcheck="false"
        @blur="onTitleBlur"
        @keydown.enter.prevent="($event.target as HTMLElement).blur()"
      >{{ title }}</div>
      <div
        class="title-sub"
        :class="{ editable: mode === 'edit' }"
        :contenteditable="mode === 'edit'"
        spellcheck="false"
        @blur="onSubtitleBlur"
        @keydown.enter.prevent="($event.target as HTMLElement).blur()"
      >{{ subtitle }}</div>
    </div>

    <div class="ribbon">
      <div class="left">
        <template v-if="mode === 'run'">
          <span>Elapsed</span>
          <span class="tc">00:03:42</span>
        </template>
        <template v-else>
          <span>Mode</span>
          <span class="tc">EDITING</span>
        </template>
      </div>
      <div class="center">
        <div class="mark">
          A Sulla Original
        </div>
        <div class="signature">
          Made entirely by <span class="sig-mark">agents</span>.
        </div>
      </div>
      <div class="right">
        <template v-if="mode === 'run'">
          <b>3</b> / 21 agents · ETA <b>5m 18s</b>
        </template>
        <template v-else>
          {{ nodes.length }} nodes · drag to build
        </template>
      </div>
    </div>

    <template v-if="mode === 'edit'">
      <button
        type="button"
        class="routines-fab"
        :class="{ active: drawerOpen }"
        :aria-label="drawerOpen ? 'Close library' : 'Add node'"
        @click="drawerOpen = !drawerOpen"
      >+</button>
      <div
        v-if="!drawerOpen"
        class="routines-fab-tip"
      >
        Add node<span class="fab-sc">⌘K</span>
      </div>

      <NodeDrawer
        :open="drawerOpen"
        @close="drawerOpen = false"
      />
    </template>

    <!-- Run-mode FAB: triggers execution of this routine. Placed in the
         same position as the Add-node FAB so switching modes swaps the
         affordance rather than stacking both on screen. -->
    <template v-if="mode === 'run'">
      <button
        type="button"
        class="routines-fab run-fab"
        :class="{ busy: isRunBusy }"
        :aria-label="isRunBusy ? 'Run starting…' : 'Run routine'"
        :disabled="isRunBusy"
        @click="onRunClick"
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 5.14v13.72L19 12 8 5.14z" />
        </svg>
      </button>
      <div class="routines-fab-tip">
        {{ isRunBusy ? 'Starting…' : 'Run routine' }}
      </div>
    </template>

    <NodeConfigPanel
      :open="configOpen"
      :node="selectedNode"
      :mode="mode"
      :upstream-nodes="upstreamNodes"
      @close="closeConfig"
      @save="onConfigSave"
      @update-config="onConfigUpdate"
    />

    <CommandPrompt
      :open="promptOpen"
      @close="promptOpen = false"
    />

    <!-- Canvas context menu (right-click the pane) -->
    <div
      v-if="ctxMenu.visible"
      class="routines-ctx"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <div
        v-if="mode === 'edit'"
        class="cm-item primary"
        @click="onCtxAddNode"
      >
        <span class="ico">＋</span>
        <span class="lbl">Add node</span>
        <span class="sc">⌘K</span>
      </div>
      <div
        v-if="mode === 'edit'"
        class="sep"
      />
      <div
        class="cm-item"
        @click="onCtxZoomIn"
      >
        <span class="ico">⊕</span>
        <span class="lbl">Zoom in</span>
        <span class="sc">⌘+</span>
      </div>
      <div
        class="cm-item"
        @click="onCtxZoomOut"
      >
        <span class="ico">⊖</span>
        <span class="lbl">Zoom out</span>
        <span class="sc">⌘−</span>
      </div>
      <div
        class="cm-item"
        @click="onCtxFitView"
      >
        <span class="ico">⛶</span>
        <span class="lbl">Fit to screen</span>
        <span class="sc">F</span>
      </div>
      <template v-if="mode === 'edit'">
        <div class="sep" />
        <div
          class="cm-item"
          @click="toggleEditLock"
        >
          <span class="ico">{{ editLocked ? '🔓' : '🔒' }}</span>
          <span class="lbl">{{ editLocked ? 'Unlock canvas' : 'Lock canvas' }}</span>
        </div>
      </template>
      <div class="sep" />
      <div
        class="cm-item accent"
        @click="toggleMode"
      >
        <span class="ico">{{ mode === 'edit' ? '▶' : '✎' }}</span>
        <span class="lbl">Switch to {{ mode === 'edit' ? 'Run' : 'Edit' }} mode</span>
      </div>
    </div>

    <!-- Node context menu (right-click a node) -->
    <div
      v-if="nodeCtx.visible"
      class="routines-ctx"
      :style="{ left: nodeCtx.x + 'px', top: nodeCtx.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <div
        v-if="mode === 'edit'"
        class="cm-item primary"
        @click="onNodeCtxEdit"
      >
        <span class="ico">✎</span>
        <span class="lbl">Edit agent</span>
        <span class="sc">↵</span>
      </div>
      <div
        v-if="mode === 'edit'"
        class="cm-item"
        @click="onNodeCtxDuplicate"
      >
        <span class="ico">⎘</span>
        <span class="lbl">Duplicate</span>
        <span class="sc">⌘D</span>
      </div>
      <div
        v-if="mode === 'edit'"
        class="sep"
      />
      <div
        class="cm-item"
        @click="onNodeCtxRunFromHere"
      >
        <span class="ico">▶</span>
        <span class="lbl">Run from here</span>
      </div>
      <div
        class="cm-item"
        @click="onNodeCtxInspectOutput"
      >
        <span class="ico">◎</span>
        <span class="lbl">Inspect output</span>
      </div>
      <template v-if="mode === 'edit'">
        <div class="sep" />
        <div
          class="cm-item danger"
          @click="onNodeCtxRemove"
        >
          <span class="ico">⌫</span>
          <span class="lbl">Remove from flow</span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Background, BackgroundVariant } from '@vue-flow/background';
import { ControlButton, Controls } from '@vue-flow/controls';
import { VueFlow, useVueFlow } from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';

import { useWorkflowPersistence, type WorkflowDefinition } from '@pkg/composables/useWorkflowPersistence';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';

import {
  enrichNodesForDisplay,
  findLibraryItem,
  makeIntegrationNodeData,
  makeRoutineNodeData,
  type Integration,
} from './routines/libraryMapping';

import CommandPrompt from './routines/CommandPrompt.vue';
import NodeConfigPanel from './routines/NodeConfigPanel.vue';
import NodeDrawer from './routines/NodeDrawer.vue';
import RoutineNode from './routines/RoutineNode.vue';

type Mode = 'edit' | 'run';

// ── Routine identity ──
// `workflowId` is set when navigated to from RoutinesHome or the /routines/:id
// route. When unset, the canvas renders the hardcoded demo graph unchanged
// (useful for standalone previews and for the ad-hoc BrowserTab mount path).
// `initialMode` lets the caller open the canvas straight into edit or run —
// card clicks from the playbill land in run mode, the explicit Edit button
// opens in edit mode. Emitting `back-to-home` returns to the playbill.
const props = defineProps<{
  workflowId?:  string;
  initialMode?: 'edit' | 'run';
}>();

defineEmits<(e: 'back-to-home') => void>();

const mode = ref<Mode>(props.initialMode ?? 'edit');
const editLocked = ref(false);
const locked = computed(() => mode.value === 'run' || editLocked.value);

const drawerOpen = ref(false);
const promptOpen = ref(false);

// Run-mode FAB state. Clicking Play calls `routines-execute` directly —
// no chat handoff. The handler primes the playbook on the default
// sulla-desktop agent graph and kicks graph.execute(); the agent
// orchestrates from there, emitting WebSocket events. The subscription
// below maps those events into node-state updates and stream lines.
const isRunBusy = ref(false);
const runError = ref<string | null>(null);
const lastExecutionId = ref<string | null>(null);

// ── Live event stream ──
// `liveEvents` is what the top-left stream panel renders while a run
// is in progress. Populated by the WebSocket subscription below as
// PlaybookController emits events. Cleared on `workflow_started` so
// each run begins with a fresh log.
interface StreamLine {
  t:   string;
  k:   'tool' | 'obs' | 'thk' | 'dec' | 'err';
  msg: string;
}
const liveEvents = ref<StreamLine[]>([]);

// ── Stream auto-scroll ──
// The stream is append-only, so new lines fall below the visible area
// as the list grows. We stick-to-bottom by default but respect the user
// when they've scrolled up to read older lines — detected by measuring
// the gap between scrollTop+clientHeight and scrollHeight. If that gap
// is within STICK_THRESHOLD_PX, the next new line snaps us back; if
// they're scrolled further up, we hold position until they scroll back
// into the stickiness zone on a later line.
const streamRef = ref<HTMLElement | null>(null);
const STICK_THRESHOLD_PX = 40;

watch(() => liveEvents.value.length, () => {
  const el = streamRef.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceFromBottom < STICK_THRESHOLD_PX) {
    nextTick(() => {
      // Re-read inside nextTick — the new line is in the DOM now, so
      // scrollHeight reflects its height and we can snap to the true
      // bottom rather than the pre-render bottom.
      const node = streamRef.value;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    }).catch(() => { /* scroll is cosmetic — swallow */ });
  }
});

// Safety timeout: clears `isRunBusy` if no completion event ever lands
// (e.g. the agent graph faulted in a way that skipped the final emit).
// Reset on every node event to extend the window as long as work is
// visibly happening; final completion events clear it explicitly.
const MAX_STALL_MS = 90_000;
let runStallTimer: ReturnType<typeof setTimeout> | null = null;

function bumpStallTimer() {
  if (runStallTimer) clearTimeout(runStallTimer);
  runStallTimer = setTimeout(() => {
    isRunBusy.value = false;
    runStallTimer = null;
  }, MAX_STALL_MS);
}

function clearStallTimer() {
  if (runStallTimer) {
    clearTimeout(runStallTimer);
    runStallTimer = null;
  }
}

async function onRunClick() {
  if (!props.workflowId) {
    console.warn('[AgentRoutines] Run clicked with no workflowId — nothing to execute.');

    return;
  }
  if (isRunBusy.value) return;

  isRunBusy.value = true;
  runError.value = null;
  liveEvents.value = [];
  bumpStallTimer();

  try {
    const result = await ipcRenderer.invoke('routines-execute', props.workflowId);
    lastExecutionId.value = result.executionId;
    console.log(`[AgentRoutines] Routine launched — executionId=${ result.executionId }`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runError.value = msg;
    // Surface the failure in the live stream so the user sees it without
    // digging into devtools. `runError` is still kept so other UI can
    // pick it up later; this just makes sure the error is visible now.
    pushLine('err', `Run failed: ${ msg }`);
    console.error('[AgentRoutines] Failed to launch routine:', err);
    isRunBusy.value = false;
    clearStallTimer();
  }
}

// ── Node state helpers ──
// Execution events arrive with node ids; mutate node.data.state so the
// canvas cards animate. The auto-save watch is deep, but the save gate
// checks `props.workflowId` + `hasHydrated` so these mutations won't
// round-trip to the store.

function setNodeState(nodeId: string, state: 'idle' | 'queued' | 'running' | 'done' | 'failed') {
  const node = nodes.value.find(n => n.id === nodeId);
  if (!node) return;
  node.data = { ...node.data, state };
}

function resetNodeStates() {
  for (const node of nodes.value) {
    if (node.data?.state && node.data.state !== 'idle') {
      node.data = { ...node.data, state: 'idle' };
    }
  }
}

// ── Event handler ──
// Maps a single PlaybookController event to (a) a node.data.state
// change, (b) a stream line, or (c) both. Event shape mirrors what
// EditorChatInterface / AgentEditor already consume elsewhere.

function stamp(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');

  return `${ h }:${ m }:${ s }`;
}

function pushLine(kind: StreamLine['k'], msg: string, ts?: number) {
  const line = { t: stamp(ts), k: kind, msg };
  liveEvents.value = [...liveEvents.value.slice(-49), line];
}

// Short label displayed in the stream kind chip. Kept as a function so
// the existing CSS selectors (.k.tool, .k.obs, .k.thk, .k.dec, .k.err)
// still target the class, and the text tracks alongside.
function streamKindLabel(kind: StreamLine['k']): string {
  switch (kind) {
  case 'tool': return 'tool';
  case 'obs':  return 'observed';
  case 'thk':  return 'thinking';
  case 'dec':  return 'decided';
  case 'err':  return 'error';
  default:     return kind;
  }
}

function handleWorkflowEvent(event: any) {
  // Filter to events belonging to this workflow — events from other
  // routines running on the same channel must not affect this canvas.
  if (event?.workflowId && props.workflowId && event.workflowId !== props.workflowId) {
    return;
  }

  bumpStallTimer();

  const nodeId = event?.nodeId as string | undefined;
  const nodeLabel = event?.nodeLabel as string | undefined;

  switch (event?.type) {
  case 'workflow_started':
    resetNodeStates();
    liveEvents.value = [];
    // Fresh run — drop any leftover error from the previous attempt so
    // the UI doesn't hold onto stale state across runs.
    runError.value = null;
    isRunBusy.value = true;
    pushLine('dec', `started · ${ props.workflowId ?? 'routine' }`, event.timestamp);
    break;

  case 'node_started':
    if (nodeId) setNodeState(nodeId, 'running');
    pushLine('tool', nodeLabel || nodeId || 'node', event.timestamp);
    break;

  case 'node_completed':
    if (nodeId) setNodeState(nodeId, 'done');
    pushLine('obs', `${ nodeLabel || nodeId || 'node' } · done`, event.timestamp);
    break;

  case 'node_failed': {
    if (nodeId) setNodeState(nodeId, 'failed');
    const err = typeof event.error === 'string' ? event.error : JSON.stringify(event.error ?? 'failed');
    pushLine('err', `${ nodeLabel || nodeId || 'node' } · ${ err }`, event.timestamp);
    break;
  }

  case 'node_thinking':
    if (event.content) pushLine('thk', String(event.content).slice(0, 140), event.timestamp);
    break;

  case 'edge_activated':
    // Kept silent in the stream — the node-level events already tell
    // the story. Could visualize the edge later if useful.
    break;

  case 'workflow_completed':
    pushLine('dec', 'completed', event.timestamp);
    isRunBusy.value = false;
    clearStallTimer();
    break;

  case 'workflow_aborted':
    pushLine('err', `aborted${ event.reason ? `: ${ event.reason }` : '' }`, event.timestamp);
    isRunBusy.value = false;
    clearStallTimer();
    break;

  case 'workflow_failed':
    pushLine('err', `failed${ event.error ? `: ${ event.error }` : '' }`, event.timestamp);
    isRunBusy.value = false;
    clearStallTimer();
    break;

  case 'workflow_paused':
    pushLine('dec', `paused${ event.reason ? `: ${ event.reason }` : '' }`, event.timestamp);
    break;
  }
}

// ── Subscription lifecycle ──
// Subscribes to the `sulla-desktop` channel (where routines emit) and
// forwards `workflow_execution_event` messages to `handleWorkflowEvent`.
// Stays active for the component's lifetime so mode toggles don't drop
// events mid-run; the inner filter throws away events unrelated to
// this canvas.
let wsUnsubscribe: (() => void) | null = null;

function subscribeToExecutionEvents() {
  try {
    const ws = getWebSocketClientService();
    wsUnsubscribe = ws.onMessage('sulla-desktop', (msg: any) => {
      if (msg?.type !== 'workflow_execution_event') return;
      const payload = msg.data;
      if (!payload) return;
      handleWorkflowEvent(payload);
    });
  } catch (err) {
    console.warn('[AgentRoutines] WebSocket subscription failed — live events will be inert:', err);
  }
}

function unsubscribeFromExecutionEvents() {
  if (wsUnsubscribe) {
    try { wsUnsubscribe(); } catch { /* ignore */ }
    wsUnsubscribe = null;
  }
  clearStallTimer();
}

const selectedNodeId = ref<string | null>(null);
const selectedNode = computed(() => nodes.value.find(n => n.id === selectedNodeId.value) || null);
const configOpen = computed(() => selectedNodeId.value !== null);

const title = ref('Blog Production Pipeline');
const subtitle = ref('Twenty-one agents, one article, nine minutes.');

// ── Persistence ──
// When `workflowId` is present, the canvas becomes a live editor: the
// graph is hydrated from the store on mount and auto-saved (debounced)
// on every subsequent mutation. Unknown fields on the loaded document
// (author, license, trust, etc.) are kept in `baseDefinition` so the
// save path round-trips them verbatim. `hasHydrated` gates the save
// watch so the initial assignments from load() don't re-save the same
// document straight back.
const persistence = useWorkflowPersistence();
const baseDefinition = ref<WorkflowDefinition | null>(null);
const hasHydrated = ref(false);

function buildDefinitionForSave(): WorkflowDefinition | null {
  if (!props.workflowId) return null;

  return {
    ...(baseDefinition.value ?? {}),
    id:          props.workflowId,
    name:        title.value,
    description: subtitle.value,
    nodes:       nodes.value,
    edges:       edges.value,
  };
}

const persistenceLabel = computed<string | null>(() => {
  switch (persistence.status.value) {
  case 'loading': return 'Loading…';
  case 'saving':  return 'Saving…';
  case 'saved':   return 'Saved';
  case 'error':   return 'Save failed';
  default:        return null;
  }
});

// Provide mode to descendant RoutineNode components so they can hide edit-only UI.
provide<typeof mode>('routines-mode', mode);

const ctxMenu = reactive({ visible: false, x: 0, y: 0 });
const nodeCtx = reactive({ visible: false, x: 0, y: 0, nodeId: null as string | null });
const selectedEdgeId = ref<string | null>(null);

const { setInteractive, zoomIn, zoomOut, fitView, project, addNodes, addEdges } = useVueFlow();

watch(locked, (l) => {
  setInteractive(!l);
}, { immediate: true });

function onInteractionChange(active: boolean) {
  // User clicked the lock button in the toolbar — sync edit-mode lock state.
  if (mode.value === 'edit') editLocked.value = !active;
}

function onPaneContextMenu(event: MouseEvent) {
  event.preventDefault();
  const frame = (event.currentTarget as HTMLElement)?.closest('.routines-frame')
    ?? (event.target as HTMLElement)?.closest('.routines-frame');
  const rect = frame?.getBoundingClientRect();
  const fx = rect ? event.clientX - rect.left : event.clientX;
  const fy = rect ? event.clientY - rect.top : event.clientY;
  ctxMenu.x = fx;
  ctxMenu.y = fy;
  ctxMenu.visible = true;
}

function closeCtxMenu() {
  ctxMenu.visible = false;
}

function onNodeClick({ node }: { node: { id: string } }) {
  closeCtxMenu();
  closeNodeCtx();
  selectedEdgeId.value = null;
  // Config sidebar is an edit-mode affordance only.
  if (mode.value !== 'edit') return;
  selectedNodeId.value = node.id;
}

function onPaneClick() {
  closeCtxMenu();
  closeNodeCtx();
  selectedNodeId.value = null;
  selectedEdgeId.value = null;
}

function onEdgeClick({ edge }: { edge: { id: string } }) {
  closeCtxMenu();
  closeNodeCtx();
  selectedNodeId.value = null;
  selectedEdgeId.value = edge.id;
}

function onNodeContextMenu({ event, node }: { event: MouseEvent | TouchEvent; node: { id: string } }) {
  event.preventDefault();
  closeCtxMenu();
  // Normalise touch vs. mouse coordinates.
  const clientX = 'clientX' in event ? event.clientX : event.touches?.[0]?.clientX ?? 0;
  const clientY = 'clientY' in event ? event.clientY : event.touches?.[0]?.clientY ?? 0;
  const frame = (event.currentTarget as HTMLElement)?.closest('.routines-frame')
    ?? (event.target as HTMLElement)?.closest('.routines-frame');
  const rect = frame?.getBoundingClientRect();
  nodeCtx.x = rect ? clientX - rect.left : clientX;
  nodeCtx.y = rect ? clientY - rect.top : clientY;
  nodeCtx.nodeId = node.id;
  nodeCtx.visible = true;
}

function closeNodeCtx() {
  nodeCtx.visible = false;
  nodeCtx.nodeId = null;
}

function onNodeCtxEdit() {
  if (mode.value !== 'edit') { closeNodeCtx(); return; }
  if (nodeCtx.nodeId) selectedNodeId.value = nodeCtx.nodeId;
  closeNodeCtx();
}

function onNodeCtxDuplicate() {
  if (mode.value !== 'edit' || !nodeCtx.nodeId) { closeNodeCtx(); return; }
  const src = nodes.value.find(n => n.id === nodeCtx.nodeId);
  if (!src) { closeNodeCtx(); return; }
  const clone = {
    ...src,
    id:       `routine-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 6) }`,
    position: { x: src.position.x + 40, y: src.position.y + 40 },
    data:     { ...src.data },
    selected: false,
  };
  addNodes([clone]);
  closeNodeCtx();
}

function onNodeCtxRemove() {
  if (mode.value !== 'edit' || !nodeCtx.nodeId) { closeNodeCtx(); return; }
  const id = nodeCtx.nodeId;
  nodes.value = nodes.value.filter(n => n.id !== id);
  edges.value = edges.value.filter(e => e.source !== id && e.target !== id);
  if (selectedNodeId.value === id) selectedNodeId.value = null;
  closeNodeCtx();
}

// Partial-graph re-execution — stubbed until PlaybookController grows a
// `start-from-node` entry point. Logging the target for now so at least
// the click is observable in devtools.
function onNodeCtxRunFromHere() {
  const id = nodeCtx.nodeId;
  console.log('[AgentRoutines] Run from here (stub) — target node:', id);
  closeNodeCtx();
}

// Checkpoint inspection — needs an IPC that reads the stored output for
// a given (workflowId, nodeId) pair. Stubbed until that lands.
function onNodeCtxInspectOutput() {
  const id = nodeCtx.nodeId;
  console.log('[AgentRoutines] Inspect output (stub) — target node:', id);
  closeNodeCtx();
}

function closeConfig() {
  selectedNodeId.value = null;
}

function onConfigSave(payload: { id: string; changes: Record<string, unknown> }) {
  const target = nodes.value.find(n => n.id === payload.id);
  if (!target) return;
  target.data = { ...target.data, ...payload.changes };
}

// Persist live config edits from whichever editor panel is rendered.
function onConfigUpdate(nodeId: string, newConfig: Record<string, unknown>) {
  const target = nodes.value.find(n => n.id === nodeId);
  if (!target) return;
  target.data = { ...target.data, config: newConfig };
}

// Upstream nodes feeding into the currently-selected node (for panel context).
const upstreamNodes = computed(() => {
  if (!selectedNode.value) return [];
  const incoming = edges.value.filter(e => e.target === selectedNode.value!.id);

  return incoming.flatMap((e) => {
    const src = nodes.value.find(n => n.id === e.source);
    if (!src) return [];

    return [{
      nodeId:   src.id,
      label:    src.data?.title ?? src.data?.label ?? src.id,
      subtype:  src.data?.subtype ?? '',
      category: src.data?.category ?? '',
    }];
  });
});

// ── Edge connections — drag from one handle to another ──
function onConnect(params: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) {
  if (mode.value !== 'edit') return;
  addEdges([{
    ...params,
    id:   `e-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 6) }`,
    type: 'smoothstep',
  }]);
}

// ── Drag-and-drop from the library drawer onto the canvas ──
const frameRef = ref<HTMLElement | null>(null);

function onDragOver(event: DragEvent) {
  if (mode.value !== 'edit') return;
  const dt = event.dataTransfer;
  if (!dt) return;
  const hasRoutine = dt.types?.includes('application/x-routine-subtype')
    || dt.types?.includes('application/x-routine-integration');
  if (!hasRoutine) return;
  dt.dropEffect = 'copy';
}

function onDrop(event: DragEvent) {
  if (mode.value !== 'edit') return;
  const dt = event.dataTransfer;
  if (!dt) return;

  const bounds = frameRef.value?.getBoundingClientRect();
  const position = project({
    x: event.clientX - (bounds?.left ?? 0),
    y: event.clientY - (bounds?.top ?? 0),
  });
  // Center the card on the cursor — RoutineNode is ~220×120
  position.x -= 110;
  position.y -= 60;

  const id = `routine-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 6) }`;

  // Integration drop — decodes to an integration-call node with the slug pre-set.
  const integrationRaw = dt.getData('application/x-routine-integration');
  if (integrationRaw) {
    try {
      const integration = JSON.parse(integrationRaw) as Integration;
      addNodes([{
        id,
        type: 'routine',
        position,
        data: makeIntegrationNodeData(integration),
      }]);
    } catch { /* malformed payload — ignore */ }

    return;
  }

  // Generic library node drop.
  const subtype = dt.getData('application/x-routine-subtype');
  if (!subtype) return;
  const item = findLibraryItem(subtype);
  if (!item) return;

  addNodes([{
    id,
    type: 'routine',
    position,
    data: makeRoutineNodeData(item),
  }]);
}

function onCtxAddNode() {
  closeCtxMenu();
  if (mode.value !== 'edit') return;
  drawerOpen.value = true;
}
function onCtxZoomIn() { closeCtxMenu(); zoomIn(); }
function onCtxZoomOut() { closeCtxMenu(); zoomOut(); }
function onCtxFitView() { closeCtxMenu(); fitView(); }

function toggleEditLock() {
  closeCtxMenu();
  if (mode.value !== 'edit') return;
  editLocked.value = !editLocked.value;
}

function toggleMode() {
  closeCtxMenu();
  mode.value = mode.value === 'edit' ? 'run' : 'edit';
  if (mode.value === 'run') {
    editLocked.value = false;
    drawerOpen.value = false;
    selectedNodeId.value = null;
  }
}

function onTitleBlur(e: FocusEvent) {
  const txt = ((e.target as HTMLElement).innerText || '').trim();
  if (txt) title.value = txt;
  else (e.target as HTMLElement).innerText = title.value;
}
function onSubtitleBlur(e: FocusEvent) {
  const txt = ((e.target as HTMLElement).innerText || '').trim();
  if (txt) subtitle.value = txt;
  else (e.target as HTMLElement).innerText = subtitle.value;
}

function onDocClick(e: MouseEvent) {
  if (!ctxMenu.visible && !nodeCtx.visible) return;
  if ((e.target as HTMLElement)?.closest('.routines-ctx')) return;
  closeCtxMenu();
  closeNodeCtx();
}

function onKeydown(e: KeyboardEvent) {
  // ⌘K / Ctrl+K — toggle the command prompt overlay
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    promptOpen.value = !promptOpen.value;
    if (promptOpen.value) {
      // close any competing overlays so focus is clean
      closeCtxMenu();
      drawerOpen.value = false;
    }
    return;
  }

  if (e.key === 'Escape') {
    if (promptOpen.value) promptOpen.value = false;
    else if (ctxMenu.visible) closeCtxMenu();
    else if (nodeCtx.visible) closeNodeCtx();
    else if (drawerOpen.value) drawerOpen.value = false;
    else if (selectedNodeId.value) closeConfig();
    else if (selectedEdgeId.value) selectedEdgeId.value = null;
    return;
  }

  // Delete / Backspace — remove the selected edge only. Nodes are removed
  // through the context menu's "Remove from flow" action.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (!selectedEdgeId.value) return;
    const id = selectedEdgeId.value;
    edges.value = edges.value.filter(edge => edge.id !== id);
    selectedEdgeId.value = null;
    e.preventDefault();
  }
}

onMounted(async() => {
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKeydown);

  // Subscribe before the first hydrate finishes so we don't race any
  // very-fast execution events (unlikely, but cheap to guarantee).
  subscribeToExecutionEvents();

  // Hydrate from the store when the parent handed us a workflow id.
  // Without an id the canvas stays empty.
  if (props.workflowId) {
    const def = await persistence.load(props.workflowId);
    if (def) {
      if (typeof def.name === 'string') title.value = def.name;
      if (typeof def.description === 'string') subtitle.value = def.description;
      if (Array.isArray(def.nodes)) nodes.value = def.nodes as typeof nodes.value;
      if (Array.isArray(def.edges)) edges.value = def.edges as typeof edges.value;
      baseDefinition.value = def;
      // Backfill display fields (nodeCode, avatar, kicker, state) for
      // nodes that came off the wire without them — covers templates
      // and any workflow saved before the display contract existed.
      enrichNodesForDisplay(nodes.value);
    }
    // Wait a tick so the watch registered below sees the post-hydration
    // state as its baseline rather than firing on the initial assignments.
    await nextTick();
    // Snap the viewport to the freshly-loaded graph. fit-view-on-init
    // fired against an empty canvas, so without this the user lands on
    // whatever the default viewport was instead of their nodes.
    fitView();
  }
  hasHydrated.value = true;
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKeydown);
  unsubscribeFromExecutionEvents();

  // Best-effort flush of any pending debounced save. Vue doesn't await
  // async unmount handlers, so this is fire-and-forget — good enough
  // for everything except the first keystroke followed by an instant
  // back-navigation, which the debounce would swallow anyway.
  const payload = buildDefinitionForSave();
  if (payload && hasHydrated.value) {
    void persistence.saveNow(payload);
  } else {
    persistence.cancel();
  }
});

const nodes = ref<any[]>([]);
const edges = ref<any[]>([]);

// Auto-save on any mutation of the graph or its metadata. Deep watch so
// in-place changes to nodes/edges (position, config, label) are caught
// without requiring every mutation site to call a markDirty helper.
// Declared here — after nodes/edges — so TypeScript's TDZ analysis is
// happy; at runtime Vue would hoist the refs either way.
watch(
  [title, subtitle, nodes, edges],
  () => {
    if (!hasHydrated.value || !props.workflowId) return;
    const payload = buildDefinitionForSave();
    if (payload) persistence.scheduleSave(payload);
  },
  { deep: true },
);
</script>

<style scoped>
.routines-frame {
  --steel-100: #c4d4e6;
  --steel-200: #a8c0dc;
  --steel-300: #8cacc9;
  --steel-400: #6989b3;
  --steel-500: #4a6fa5;
  --steel-700: #2c4871;
  --violet-200: #ddd6fe;
  --violet-300: #c4b5fd;
  --violet-400: #a78bfa;
  --violet-500: #8b5cf6;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --serif: "Iowan Old Style", "Palatino", Georgia, serif;

  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: #e6ecf5;
  background: linear-gradient(135deg, #03060c 0%, #070d1a 60%, #01030a 100%);
  -webkit-font-smoothing: antialiased;
}

.routines-flow {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.glow {
  position: absolute;
  pointer-events: none;
  mix-blend-mode: screen;
  transform: translate(-50%, -50%) scale(1);
  will-change: transform, opacity, top, left;
  z-index: 2;
}
.glow.blue {
  width: 160%;
  height: 160%;
  top: 18%;
  left: 22%;
  background: radial-gradient(circle at center,
    rgba(74,111,165,0.55) 0%, rgba(74,111,165,0.38) 10%, rgba(74,111,165,0.22) 22%,
    rgba(74,111,165,0.11) 34%, rgba(74,111,165,0.05) 46%, rgba(74,111,165,0.018) 58%,
    rgba(74,111,165,0.004) 72%, transparent 90%);
  animation: breathe-blue 26s ease-in-out infinite;
}
.glow.violet {
  width: 150%;
  height: 150%;
  top: 82%;
  left: 80%;
  background: radial-gradient(circle at center,
    rgba(139,92,246,0.45) 0%, rgba(139,92,246,0.28) 10%, rgba(139,92,246,0.16) 22%,
    rgba(139,92,246,0.08) 34%, rgba(139,92,246,0.035) 46%, rgba(139,92,246,0.012) 58%,
    rgba(139,92,246,0.003) 72%, transparent 90%);
  animation: breathe-violet 34s ease-in-out infinite;
  animation-delay: -8s;
}
@keyframes breathe-blue {
  0%   { top: 18%; left: 22%; opacity: 0.85; transform: translate(-50%, -50%) scale(1); }
  25%  { top: 14%; left: 28%; opacity: 1.00; transform: translate(-50%, -50%) scale(1.15); }
  50%  { top: 24%; left: 18%; opacity: 0.70; transform: translate(-50%, -50%) scale(0.92); }
  75%  { top: 20%; left: 30%; opacity: 0.95; transform: translate(-50%, -50%) scale(1.08); }
  100% { top: 18%; left: 22%; opacity: 0.85; transform: translate(-50%, -50%) scale(1); }
}
@keyframes breathe-violet {
  0%   { top: 82%; left: 80%; opacity: 0.80; transform: translate(-50%, -50%) scale(1); }
  30%  { top: 78%; left: 86%; opacity: 1.00; transform: translate(-50%, -50%) scale(1.2); }
  55%  { top: 88%; left: 74%; opacity: 0.65; transform: translate(-50%, -50%) scale(0.9); }
  80%  { top: 84%; left: 88%; opacity: 0.92; transform: translate(-50%, -50%) scale(1.1); }
  100% { top: 82%; left: 80%; opacity: 0.80; transform: translate(-50%, -50%) scale(1); }
}

.stars {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.35;
  z-index: 2;
  background-image:
    radial-gradient(1px 1px at 15% 25%, white, transparent),
    radial-gradient(1px 1px at 35% 70%, #c4b5fd, transparent),
    radial-gradient(1px 1px at 55% 15%, white, transparent),
    radial-gradient(1px 1px at 72% 55%, white, transparent),
    radial-gradient(1px 1px at 88% 80%, #a8c0dc, transparent),
    radial-gradient(1.5px 1.5px at 5% 65%, white, transparent),
    radial-gradient(1px 1px at 62% 88%, white, transparent);
}

.bracket {
  position: absolute;
  width: 22px;
  height: 22px;
  z-index: 4;
  pointer-events: none;
  border-color: rgba(196,212,230,0.5);
}
.bracket.tl { top: 18px; left: 22px; border-top: 1.5px solid; border-left: 1.5px solid; }
.bracket.tr { top: 18px; right: 22px; border-top: 1.5px solid; border-right: 1.5px solid; }
.bracket.bl { bottom: 18px; left: 22px; border-bottom: 1.5px solid; border-left: 1.5px solid; }
.bracket.br { bottom: 18px; right: 22px; border-bottom: 1.5px solid; border-right: 1.5px solid; }

.title-block {
  position: absolute;
  top: 48px;
  right: 52px;
  z-index: 4;
  pointer-events: none;
  text-align: right;
  max-width: 48%;
}
.title-kicker {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.3em;
  color: var(--violet-300);
  text-transform: uppercase;
  margin-bottom: 10px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.title-kicker::before {
  content: '';
  display: inline-block;
  width: 20px;
  height: 1px;
  background: var(--violet-400);
}
.title-kicker .d {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--violet-400);
  box-shadow: 0 0 8px var(--violet-400);
  animation: routines-pulse 1.5s infinite;
}
@keyframes routines-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.title-kicker .save-status {
  margin-left: 6px;
  color: rgba(196, 181, 253, 0.6);
  transition: color 0.2s;
}
.title-kicker .save-status.saving  { color: rgba(196, 212, 230, 0.85); }
.title-kicker .save-status.saved   { color: rgba(134, 239, 172, 0.85); }
.title-kicker .save-status.error   { color: rgba(252, 165, 165, 0.9); }
.title-kicker .save-status.loading { color: rgba(168, 192, 220, 0.7); }

.title-main {
  font-family: var(--serif);
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.05;
  color: white;
  font-style: italic;
}
.title-sub {
  font-family: var(--serif);
  font-size: 13px;
  font-style: italic;
  color: var(--steel-200);
  margin-top: 8px;
  letter-spacing: 0.01em;
}

.stream {
  position: absolute;
  top: 28px;
  left: 52px;
  z-index: 4;
  /* Scrollable so auto-scroll + user-pause-to-read behaviour works. Wheel
   * events inside this box run the container's scroll rather than the
   * VueFlow pane underneath — the area is narrow enough that this is a
   * net win. */
  pointer-events: auto;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.7;
  width: 28%;
  max-height: 42vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.8) 15%, black 35%);
  mask-image: linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.8) 15%, black 35%);
}
.line {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 1px 0;
}
.line .t {
  color: var(--steel-400);
  flex-shrink: 0;
  font-size: 10px;
}
.line .k {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.line .k.tool { background: rgba(168,192,220,0.18); color: var(--steel-100); border: 1px solid rgba(168,192,220,0.25); }
.line .k.obs  { background: rgba(74,111,165,0.25); color: #b4d0f0; border: 1px solid rgba(116,158,214,0.35); }
.line .k.thk  { background: rgba(196,181,253,0.18); color: var(--violet-300); border: 1px solid rgba(167,139,250,0.35); }
.line .k.dec  {
  background: rgba(139,92,246,0.25);
  color: var(--violet-200);
  border: 1px solid rgba(167,139,250,0.55);
  box-shadow: 0 0 10px rgba(139,92,246,0.25);
}
.line .k.err  {
  background: rgba(244,63,94,0.2);
  color: #fda4af;
  border: 1px solid rgba(244,63,94,0.5);
}
.line .msg { color: var(--steel-200); font-size: 11px; }
.line .msg .h {
  color: white;
  background: rgba(139,92,246,0.2);
  padding: 0 3px;
  border-radius: 2px;
}
.line:nth-child(1) { opacity: 0.45; }
.line:nth-child(2) { opacity: 0.6; }
.line:nth-child(3) { opacity: 0.72; }
.line:nth-child(4) { opacity: 0.82; }
.line:nth-child(5) { opacity: 0.92; }
.line.current { opacity: 1; }
.line.current .msg { color: white; }
.line.current .t { color: var(--violet-300); }

.ribbon {
  position: absolute;
  bottom: 36px;
  left: 52px;
  right: 52px;
  z-index: 4;
  pointer-events: none;
  padding: 12px 18px;
  background: linear-gradient(90deg,
    rgba(20,30,54,0.3) 0%,
    rgba(20,30,54,0.85) 30%,
    rgba(20,30,54,0.85) 70%,
    rgba(20,30,54,0.3) 100%);
  border-top: 1px solid rgba(168,192,220,0.15);
  border-bottom: 1px solid rgba(168,192,220,0.15);
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 20px;
  align-items: center;
}
.ribbon .left {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-300);
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 10px;
}
.ribbon .left .tc {
  color: white;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.ribbon .center {
  text-align: center;
  overflow: hidden;
}
.ribbon .center .mark {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.3em;
  color: var(--steel-400);
  text-transform: uppercase;
}
.ribbon .center .signature {
  font-family: var(--serif);
  font-size: 14px;
  font-style: italic;
  color: white;
  margin-top: 4px;
  line-height: 1.2;
}
.ribbon .center .sig-mark {
  color: var(--violet-300);
  font-weight: 700;
}
.ribbon .right {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-300);
  letter-spacing: 0.15em;
  text-transform: uppercase;
  text-align: right;
}
.ribbon .right b { color: white; font-weight: 700; }

/* Make VueFlow's pane transparent so the deep-ocean gradient + glows show through.
 * The grid itself comes from <Background variant=Lines>. */
.routines-flow :deep(.vue-flow__pane),
.routines-flow :deep(.vue-flow__renderer),
.routines-flow :deep(.vue-flow__container) {
  background: transparent;
}

/* Match the design mockup's diagonal fade — grid shows only in the center band,
 * fades into the dark corners so the glows can breathe. */
.routines-flow :deep(.vue-flow__background) {
  -webkit-mask-image: linear-gradient(45deg, transparent 20%, black 46%, black 54%, transparent 80%);
          mask-image: linear-gradient(45deg, transparent 20%, black 46%, black 54%, transparent 80%);
}

/* Our custom node provides its own chrome — strip the default wrapper box */
.routines-flow :deep(.vue-flow__node-routine) {
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 10px;
  overflow: visible;
  color: inherit;
}
.routines-flow :deep(.vue-flow__node-routine.selected .inner) {
  outline: 2px solid rgba(140, 172, 210, 0.6);
  outline-offset: 2px;
}

/* Edges — clickable with a fat invisible hit area. Selection is a
   glowing blue; the violet palette is reserved for the "running"/active
   state on animated edges so the two reads don't collide. */
.routines-flow :deep(.vue-flow__edge-path) {
  stroke: rgba(168, 192, 220, 0.55);
  stroke-width: 2;
  transition: stroke 0.12s ease, stroke-width 0.12s ease, filter 0.12s ease;
}
.routines-flow :deep(.vue-flow__edge:hover .vue-flow__edge-path) {
  stroke: #7dd3fc; /* brighter cyan-blue on hover */
}
.routines-flow :deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: #60a5fa; /* glowing blue for the selected state */
  stroke-width: 3;
  filter: drop-shadow(0 0 6px rgba(96, 165, 250, 0.75))
    drop-shadow(0 0 14px rgba(96, 165, 250, 0.35));
}
/* Widen the hit area so edges are easy to click. */
.routines-flow :deep(.vue-flow__edge .vue-flow__edge-interaction) {
  stroke: transparent;
  stroke-width: 18;
}

/* ── Controls — toolbar treatment (matches V3 drawer-reveal mockup) ── */
.routines-flow :deep(.vue-flow__controls) {
  bottom: 108px;
  left: 120px;
  top: auto;
  right: auto;
  display: flex;
  flex-direction: row;
  gap: 3px;
  padding: 4px;
  background: rgba(20, 30, 54, 0.8);
  border: 1px solid rgba(168, 192, 220, 0.2);
  border-radius: 8px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: none;
}
.routines-flow :deep(.vue-flow__controls-button) {
  width: 28px;
  height: 28px;
  padding: 0;
  display: grid;
  place-items: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--steel-300);
  cursor: pointer;
  font-size: 12px;
  box-sizing: border-box;
}
.routines-flow :deep(.vue-flow__controls-button:hover) {
  color: white;
  background: rgba(168, 192, 220, 0.08);
}
.routines-flow :deep(.vue-flow__controls-button svg) {
  width: 14px;
  height: 14px;
}
/* Fill VueFlow's built-in icons (they don't declare fill="none"), but leave
 * our custom stroke-based icons alone so they stay hollow/outlined. */
.routines-flow :deep(.vue-flow__controls-button svg:not([fill])) {
  fill: currentColor;
}
.routines-flow :deep(.vue-flow__controls-button svg:not([fill]) path) {
  fill: currentColor;
}

/* Mode-toggle button: violet accent while edit mode is active */
.routines-flow :deep(.vue-flow__controls-button.mode-toggle.is-edit) {
  color: var(--violet-300);
  background: rgba(139, 92, 246, 0.12);
  border-color: rgba(167, 139, 250, 0.35);
}
.routines-flow :deep(.vue-flow__controls-button.mode-toggle.is-edit:hover) {
  color: white;
  background: rgba(139, 92, 246, 0.22);
}

/* ── MiniMap — tactical radar panel ── */
.routines-flow :deep(.vue-flow__minimap) {
  bottom: 108px;
  right: 52px;
  top: auto;
  left: auto;
  width: 200px;
  height: 130px;
  padding: 0;
  background-color: rgba(11, 20, 38, 0.92);
  background-image:
    linear-gradient(0deg,  transparent 49.5%, rgba(167, 139, 250, 0.16) 50%, transparent 50.5%),
    linear-gradient(90deg, transparent 49.5%, rgba(167, 139, 250, 0.16) 50%, transparent 50.5%);
  border: 1px solid rgba(167, 139, 250, 0.45);
  border-radius: 8px;
  overflow: hidden;
  box-shadow:
    0 0 24px rgba(139, 92, 246, 0.28),
    inset 0 0 32px rgba(139, 92, 246, 0.1);
}
.routines-flow :deep(.vue-flow__minimap svg) {
  position: relative;
  z-index: 2;
}

/* ── Floating Action Button — "Add node" (matches V2 drawer-reveal mockup) ── */
.routines-fab {
  position: absolute;
  left: 52px;
  bottom: 108px;
  z-index: 5;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  padding: 0;
  background: linear-gradient(135deg, var(--violet-400), var(--violet-500));
  border: 1px solid rgba(196, 181, 253, 0.55);
  box-shadow:
    0 10px 28px rgba(139, 92, 246, 0.4),
    0 0 18px rgba(139, 92, 246, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.15);
  color: white;
  font-size: 24px;
  font-weight: 300;
  line-height: 1;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.25, 1);
  font-family: var(--mono);
}
.routines-fab:hover {
  transform: scale(1.06);
}
.routines-fab.active {
  transform: rotate(45deg);
  background: linear-gradient(135deg, #4b3085, #2a1555);
}

/* Run-mode variant — same violet palette as the Add-node FAB but with
   a play triangle instead of a plus, and a slightly brighter glow so
   the button reads as "go" rather than "create". */
.routines-fab.run-fab {
  font-size: 0; /* suppress any stray text; icon is an inline svg */
}
.routines-fab.run-fab svg {
  width: 22px;
  height: 22px;
  margin-left: 2px; /* optical nudge — the triangle is heavier on the right */
  color: white;
  filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.35));
}
.routines-fab.run-fab:hover {
  box-shadow:
    0 12px 32px rgba(139, 92, 246, 0.5),
    0 0 24px rgba(139, 92, 246, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}
.routines-fab.run-fab.busy {
  cursor: progress;
  opacity: 0.75;
  animation: run-fab-pulse 1.1s ease-in-out infinite;
}
@keyframes run-fab-pulse {
  0%, 100% { box-shadow: 0 10px 28px rgba(139, 92, 246, 0.4), 0 0 18px rgba(139, 92, 246, 0.35); }
  50%      { box-shadow: 0 10px 28px rgba(139, 92, 246, 0.55), 0 0 32px rgba(139, 92, 246, 0.7); }
}

.routines-fab-tip {
  position: absolute;
  left: 52px;
  bottom: 168px;
  z-index: 5;
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(20, 30, 54, 0.9);
  border: 1px solid rgba(168, 192, 220, 0.2);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--steel-200);
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.routines-fab-tip .fab-sc {
  color: var(--violet-300);
  margin-left: 6px;
}
.routines-fab-tip::after {
  content: '';
  position: absolute;
  left: 20px;
  bottom: -5px;
  width: 8px;
  height: 8px;
  background: rgba(20, 30, 54, 0.9);
  border-right: 1px solid rgba(168, 192, 220, 0.2);
  border-bottom: 1px solid rgba(168, 192, 220, 0.2);
  transform: rotate(45deg);
}
.routines-fab:hover + .routines-fab-tip {
  opacity: 1;
  transform: translateY(0);
}

/* ── Editable title / subtitle (edit mode only) ── */
.title-main.editable,
.title-sub.editable {
  cursor: text;
  border-radius: 3px;
  outline: 1px dashed transparent;
  outline-offset: 4px;
  transition: outline-color 0.15s ease;
}
.title-main.editable:hover,
.title-sub.editable:hover {
  outline-color: rgba(167, 139, 250, 0.35);
}
.title-main.editable:focus,
.title-sub.editable:focus {
  outline: 1px solid rgba(167, 139, 250, 0.6);
  outline-offset: 4px;
  background: rgba(139, 92, 246, 0.05);
}

/* Locked pane: hide VueFlow's grab cursor so it doesn't lie about interactivity */
.routines-flow.locked :deep(.vue-flow__node) { cursor: default; }

/* ── Canvas context menu ── */
.routines-ctx {
  position: absolute;
  z-index: 20;
  min-width: 210px;
  background: linear-gradient(180deg, rgba(20, 30, 54, 0.96), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(168, 192, 220, 0.25);
  border-radius: 8px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.55), 0 0 24px rgba(139, 92, 246, 0.15);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  padding: 5px;
  color: var(--steel-100);
  font-family: var(--font);
}
.routines-ctx .cm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 9px;
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--steel-100);
  cursor: pointer;
  user-select: none;
}
.routines-ctx .cm-item:hover {
  background: rgba(167, 139, 250, 0.16);
  color: white;
}
.routines-ctx .cm-item.primary {
  color: var(--violet-200);
}
.routines-ctx .cm-item.primary:hover {
  background: rgba(139, 92, 246, 0.28);
  color: white;
}
.routines-ctx .cm-item.accent {
  color: var(--violet-300);
}
.routines-ctx .cm-item .ico {
  width: 18px;
  text-align: center;
  font-size: 12px;
  color: var(--steel-300);
  flex-shrink: 0;
}
.routines-ctx .cm-item.primary .ico,
.routines-ctx .cm-item.accent .ico { color: var(--violet-300); }
.routines-ctx .cm-item.danger { color: #fca5a5; }
.routines-ctx .cm-item.danger:hover {
  background: rgba(244, 63, 94, 0.16);
  color: #fee2e2;
}
.routines-ctx .cm-item.danger .ico { color: #fb7185; }
.routines-ctx .cm-item .lbl { flex: 1; }
.routines-ctx .cm-item .sc {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 9px;
  color: var(--steel-500);
  letter-spacing: 0.08em;
}
.routines-ctx .sep {
  height: 1px;
  background: rgba(168, 192, 220, 0.14);
  margin: 4px 2px;
}
</style>
