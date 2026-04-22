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
      class="stream"
    >
      <div class="line"><span class="t">14:03</span><span class="k tool">tool</span><span class="msg">ahrefs.lookup()</span></div>
      <div class="line"><span class="t">14:05</span><span class="k obs">observed</span><span class="msg">Volume 8,200/mo · KD 71</span></div>
      <div class="line"><span class="t">14:08</span><span class="k thk">thinking</span><span class="msg">SEMRush off by 40%</span></div>
      <div class="line"><span class="t">14:14</span><span class="k tool">tool</span><span class="msg">google_trends.compare()</span></div>
      <div class="line"><span class="t">14:17</span><span class="k obs">observed</span><span class="msg">rising 3x faster</span></div>
      <div class="line current"><span class="t">14:19</span><span class="k dec">decided</span><span class="msg">Target: <span class="h">"AI tools SMB"</span></span></div>
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
        @click="closeNodeCtx"
      >
        <span class="ico">▶</span>
        <span class="lbl">Run from here</span>
      </div>
      <div
        class="cm-item"
        @click="closeNodeCtx"
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
import { NODE_REGISTRY } from '@pkg/pages/editor/workflow/nodeRegistry';

import {
  enrichNodesForDisplay,
  findLibraryItem,
  makeIntegrationNodeData,
  makeRoutineNodeData,
  type Integration,
} from './routines/libraryMapping';

function defaultsFor(subtype: string): Record<string, unknown> {
  return NODE_REGISTRY.find(n => n.subtype === subtype)?.defaultConfig() ?? {};
}
import CommandPrompt from './routines/CommandPrompt.vue';
import NodeConfigPanel from './routines/NodeConfigPanel.vue';
import NodeDrawer from './routines/NodeDrawer.vue';
import RoutineNode from './routines/RoutineNode.vue';

type Mode = 'edit' | 'run';

// ── Routine identity ──
// `workflowId` is set when navigated to from RoutinesHome or the /routines/:id
// route. When unset, the canvas renders the hardcoded demo graph unchanged
// (useful for standalone previews and for the ad-hoc BrowserTab mount path).
// Emitting `back-to-home` lets the parent return to the playbill view.
const props = defineProps<{
  workflowId?: string;
}>();

defineEmits<(e: 'back-to-home') => void>();

const mode = ref<Mode>('edit');
const editLocked = ref(false);
const locked = computed(() => mode.value === 'run' || editLocked.value);

const drawerOpen = ref(false);
const promptOpen = ref(false);

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

  // Hydrate from the store when the parent handed us a workflow id.
  // Without an id the canvas stays on its hardcoded demo graph.
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
  } else {
    // Standalone preview path — still enrich so the hardcoded demo
    // renders consistently with DB-loaded workflows.
    enrichNodesForDisplay(nodes.value);
  }
  hasHydrated.value = true;
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKeydown);

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

const nodes = ref<any[]>([
  {
    id:       'trigger-1',
    type:     'routine',
    position: { x: 0, y: 140 },
    data:     {
      state:         'done',
      nodeCode:      'T-01',
      kicker:        'Trigger',
      title:         'Chat Trigger',
      role:          'Entry · user message',
      quote:         '"Write a blog on AI for SMB owners."',
      subtype:       'chat-app',
      category:      'trigger',
      config:        defaultsFor('chat-app'),
      avatar:        { type: 'trigger', icon: '⚡' },
      metricsStrong: '2s',
      metrics:       ' ago',
      footerRight:   'captured',
    },
  },
  {
    id:       'agent-kr',
    type:     'routine',
    position: { x: 290, y: 140 },
    data:     {
      state:       'done',
      nodeCode:    'A-04',
      kicker:      'Agent',
      title:       'Keyword Research',
      role:        'SEO Strategist',
      quote:       '"Honest about data limits."',
      subtype:     'agent',
      category:    'agent',
      config:      defaultsFor('agent'),
      avatar:      { type: 'default', initials: 'KR' },
      metrics:     '⏱ 32s · $0.04',
      footerRight: '94%',
    },
  },
  {
    id:       'agent-tr',
    type:     'routine',
    position: { x: 580, y: 140 },
    data:     {
      state:       'running',
      nodeCode:    'A-07',
      kicker:      'Session',
      title:       'Topic Researcher',
      role:        'Audience Intent',
      quote:       '"Translates tech for non-tech owners."',
      subtype:     'agent',
      category:    'agent',
      config:      defaultsFor('agent'),
      avatar:      { type: 'default', initials: 'TR' },
      think:       'Reading 14 SMB forum threads…',
      thinkStrong: '14 SMB forum threads',
      metrics:     '⏱ 1m 04s · $0.07',
      footerRight: '91%',
    },
  },
  {
    id:       'agent-cb',
    type:     'routine',
    position: { x: 870, y: 140 },
    data:     {
      state:       'failed',
      nodeCode:    'A-11',
      kicker:      'Agent',
      title:       'Brief Generator',
      role:        'Content Strategist',
      quote:       '"Opinionated about structure."',
      subtype:     'agent',
      category:    'agent',
      config:      defaultsFor('agent'),
      avatar:      { type: 'default', initials: 'CB' },
      metrics:     '⏱ 12s · $0.02',
      footerRight: 'timed out',
    },
  },
]);

const edges = ref<any[]>([
  { id: 'e1', source: 'trigger-1', target: 'agent-kr', type: 'smoothstep' },
  { id: 'e2', source: 'agent-kr', target: 'agent-tr', type: 'smoothstep' },
  {
    id:       'e3',
    source:   'agent-tr',
    target:   'agent-cb',
    type:     'smoothstep',
    animated: true,
    style:    { stroke: '#a78bfa', strokeWidth: 2 },
  },
]);

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
  pointer-events: none;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.7;
  width: 28%;
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

/* Edges — clickable with a fat invisible hit area, subtle default, violet when selected. */
.routines-flow :deep(.vue-flow__edge-path) {
  stroke: rgba(168, 192, 220, 0.55);
  stroke-width: 2;
  transition: stroke 0.12s ease, stroke-width 0.12s ease;
}
.routines-flow :deep(.vue-flow__edge:hover .vue-flow__edge-path) {
  stroke: var(--violet-300);
}
.routines-flow :deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: var(--violet-400);
  stroke-width: 3;
  filter: drop-shadow(0 0 6px rgba(139, 92, 246, 0.6));
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
