<template>
  <div
    ref="frameRef"
    class="routines-frame"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <VueFlow
      v-model:nodes="nodes"
      v-model:edges="edges"
      :default-viewport="{ zoom: 1 }"
      :default-edge-options="{ type: 'routine' }"
      :delete-key-code="null"
      :selection-key-code="null"
      :multi-selection-key-code="null"
      fit-view-on-init
      class="routines-flow"
      :class="{ locked }"
      @pane-context-menu="onPaneContextMenu"
      @pane-click="onPaneClick"
      @node-click="onNodeClick"
      @node-context-menu="onNodeContextMenu"
      @node-drag="onNodeDrag"
      @node-drag-stop="onNodeDragStop"
      @edge-click="onEdgeClick"
      @connect="onConnect"
    >
      <template #node-routine="nodeProps">
        <RoutineNode v-bind="nodeProps" />
      </template>
      <!-- Historical node type from the old workflow YAML. Routine files
           imported from the pre-rename world still carry `type: workflow`
           on every node; render them through the same component so the
           file stays importable as-is. -->
      <template #node-workflow="nodeProps">
        <RoutineNode v-bind="nodeProps" />
      </template>
      <!-- Loop container — dashed-frame that (phase 2) parents the body
           nodes via VueFlow's parentNode. Distinct from other routine
           nodes so it can own its own layout, handles, and sizing. -->
      <template #node-loop-frame="nodeProps">
        <LoopFrameNode v-bind="nodeProps" />
      </template>
      <!-- Sticky note — non-executing annotation node. Doesn't run, doesn't
           emit events, doesn't count toward execution totals. Pure canvas
           documentation (markdown, media, colored background). -->
      <template #node-sticky-note="nodeProps">
        <StickyNoteNode v-bind="nodeProps" />
      </template>
      <!-- Custom edge with dim base + traveling violet pulse overlay when
           flowing. Matches the L1 canvas design's animated-gradient feel
           (which default SmoothStepEdge can't do — only one path). -->
      <template #edge-routine="edgeProps">
        <RoutineEdge v-bind="edgeProps" />
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
        <template v-if="mode === 'edit'">
          <ControlButton
            class="history-btn history-undo"
            :class="{ disabled: !history.canUndo.value }"
            :disabled="!history.canUndo.value"
            :title="`Undo (${shortcutLabel('Z')})`"
            @click="undo"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 14L4 9l5-5" />
              <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
            </svg>
          </ControlButton>
          <ControlButton
            class="history-btn history-redo"
            :class="{ disabled: !history.canRedo.value }"
            :disabled="!history.canRedo.value"
            :title="`Redo (${shortcutLabel('Shift+Z')})`"
            @click="redo"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M15 14l5-5-5-5" />
              <path d="M20 9H9a5 5 0 0 0 0 10h4" />
            </svg>
          </ControlButton>
        </template>
        <ControlButton
          v-if="mode === 'edit' && props.workflowId"
          class="status-toggle"
          :class="{ 'is-production': workflowStatus === 'production', disabled: statusBusy }"
          :disabled="statusBusy"
          :title="workflowStatus === 'production'
            ? 'Published — click to move back to draft'
            : 'Draft — click to publish to production'"
          @click="togglePublished"
        >
          <span class="status-dot" />
          <span class="status-lbl">{{ workflowStatus === 'production' ? 'Published' : 'Draft' }}</span>
        </ControlButton>
        <ControlButton
          v-if="mode === 'run'"
          class="runs-btn"
          :class="{ active: runsFlyoutOpen }"
          title="Run history"
          @click="toggleRunsFlyout"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle
              cx="12"
              cy="12"
              r="9"
            />
            <path d="M12 7v5l3 2" />
          </svg>
        </ControlButton>
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

    <!-- Stream backdrop — solid panel that occupies the exact footprint
         of the live stream, sitting above the VueFlow canvas (hides the
         node cards behind it) but below the ambient canvas overlays
         (glow, stars, brackets) so those still read through. Only
         rendered once the stream actually has content — an empty panel
         is just visual clutter blocking cards underneath. -->
    <div
      v-if="mode === 'run' && liveEvents.length > 0"
      class="stream-backdrop"
      aria-hidden="true"
    />

    <div class="glow blue" />
    <div class="glow violet" />
    <div class="stars" />
    <div class="bracket tl" />
    <div class="bracket tr" />
    <div class="bracket bl" />
    <div class="bracket br" />

    <!-- Live stream — only renders once events arrive so an idle routine
         doesn't show an empty panel covering the canvas. -->
    <div
      v-if="mode === 'run' && liveEvents.length > 0"
      ref="streamRef"
      class="stream"
    >
      <div
        v-for="(line, idx) in liveEvents"
        :key="idx"
        class="line"
        :class="{ current: idx === liveEvents.length - 1 }"
      >
        <span class="t">{{ line.t }}</span>
        <span
          class="k"
          :class="line.k"
        >{{ line.badge || streamKindLabel(line.k) }}</span>
        <span class="msg">{{ line.msg }}</span>
      </div>
    </div>

    <!-- Backdrop for the top-right title block. Sits between the canvas
         (z-index 0/auto) and the ambient overlays so node cards passing
         beneath the HUD are obscured and the kicker/title stays legible.
         Matches the stream-backdrop's mask-faded edges for a soft fit. -->
    <div
      class="title-backdrop"
      aria-hidden="true"
    />

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
      >
        {{ title }}
      </div>
      <div
        class="title-sub"
        :class="{ editable: mode === 'edit' }"
        :contenteditable="mode === 'edit'"
        spellcheck="false"
        @blur="onSubtitleBlur"
        @keydown.enter.prevent="($event.target as HTMLElement).blur()"
      >
        {{ subtitle }}
      </div>
    </div>

    <div class="ribbon">
      <div class="left">
        <template v-if="mode === 'run'">
          <span>Elapsed</span>
          <span class="tc">{{ runElapsedLabel }}</span>
        </template>
        <template v-else>
          <span>Mode</span>
          <span class="tc">EDITING</span>
        </template>
      </div>
      <div class="center">
        <template v-if="mode === 'run' && isRunBusy && runningTitle">
          <div class="kicker">
            Now Producing
          </div>
          <div class="output-now">
            {{ runningTitle }}
          </div>
        </template>
        <template v-else>
          <div class="mark">
            A Sulla Original
          </div>
          <div class="signature">
            Made entirely by <span class="sig-mark">agents</span>.
          </div>
        </template>
      </div>
      <div class="right">
        <template v-if="mode === 'run'">
          <b>{{ completedCount }}</b> / {{ totalExecutableCount }} agents<template v-if="runEtaLabel">
            · ETA <b>{{ runEtaLabel }}</b>
          </template>
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
      >
        +
      </button>
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
    <template v-if="mode === 'run' && !viewingPastRun">
      <button
        type="button"
        class="routines-fab run-fab"
        :class="{ busy: isRunBusy, 'is-stop': isStopVisible, stalled: isStalled }"
        :aria-label="isStopVisible ? 'Stop routine' : 'Run routine'"
        @click="isStopVisible ? onStopClick() : onRunClick()"
      >
        <svg
          v-if="isStopVisible"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect
            x="6"
            y="6"
            width="12"
            height="12"
            rx="1.5"
          />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 5.14v13.72L19 12 8 5.14z" />
        </svg>
      </button>
      <div class="routines-fab-tip">
        {{ isStopVisible ? (isStalled ? 'Stop routine (stalled)' : 'Stop routine') : 'Run routine' }}
      </div>
    </template>

    <!-- Runs flyout — anchored under the Runs button in the Controls bar.
         Lists recent executions for this workflow; clicking one hydrates
         the canvas with that run's final node outputs for inspection. -->
    <div
      v-if="runsFlyoutOpen"
      class="runs-flyout nodrag"
      @click.stop
      @pointerdown.stop
    >
      <div class="runs-flyout-head">
        <span class="runs-flyout-title">Run history</span>
        <button
          type="button"
          class="runs-flyout-close"
          aria-label="Close"
          @click="closeRunsFlyout"
        >
          ✕
        </button>
      </div>
      <div
        v-if="pastRunsLoading"
        class="runs-flyout-status"
      >
        Loading…
      </div>
      <div
        v-else-if="pastRuns.length === 0"
        class="runs-flyout-status"
      >
        No recorded runs yet.
      </div>
      <ul
        v-else
        class="runs-list"
      >
        <li
          v-for="run in pastRuns"
          :key="run.executionId"
          class="runs-item"
          :class="{ active: viewingPastRun?.executionId === run.executionId }"
          @click="openPastRun(run.executionId)"
        >
          <span class="runs-item-time">{{ formatRunStamp(run.startedAt) }}</span>
          <span class="runs-item-body">
            <span class="runs-item-last">{{ run.lastNodeLabel || '—' }}</span>
            <span class="runs-item-meta">{{ run.checkpointCount }} steps · {{ formatRunSpan(run.startedAt, run.endedAt) }}</span>
          </span>
        </li>
      </ul>
    </div>

    <!-- Delete confirmation — one dialog for every delete path (keyboard
         Delete, context menu, future buttons). Enter confirms, Escape
         cancels; clicking the backdrop also cancels. -->
    <div
      v-if="deleteConfirm"
      class="delete-confirm-backdrop"
      @click="cancelDelete"
    >
      <div
        class="delete-confirm"
        role="dialog"
        aria-labelledby="delete-confirm-title"
        @click.stop
      >
        <div
          id="delete-confirm-title"
          class="dc-title"
        >
          Delete {{ deleteConfirmSummary }}?
        </div>
        <div class="dc-body">
          This can't be undone from the canvas — only the undo stack will
          bring it back.
        </div>
        <div class="dc-actions">
          <button
            type="button"
            class="dc-btn cancel"
            @click="cancelDelete"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dc-btn danger"
            autofocus
            @click="confirmDelete"
          >
            Delete
          </button>
        </div>
      </div>
    </div>

    <!-- Past-run banner — pinned at the top of the frame when the user is
         inspecting a historical run so the canvas can't be mistaken for a
         live one. Return-to-live clears node state and drops back to idle. -->
    <div
      v-if="viewingPastRun"
      class="past-run-banner"
    >
      <span class="banner-dot" />
      <span class="banner-text">
        Viewing past run · <b>{{ formatRunStamp(viewingPastRun.startedAt) }}</b>
        · {{ formatRunSpan(viewingPastRun.startedAt, viewingPastRun.endedAt) }}
      </span>
      <button
        type="button"
        class="banner-exit"
        @click="exitPastRunView"
      >
        Return to live
      </button>
    </div>

    <!-- Edit mode — right-hand config drawer for the selected node.
         Run mode uses NodeOutputPanel instead (output + turns, no form). -->
    <NodeConfigPanel
      v-if="mode === 'edit'"
      :open="configOpen"
      :node="selectedNode"
      :mode="mode"
      :upstream-nodes="upstreamNodes"
      :children="selectedChildren"
      @close="closeConfig"
      @save="onConfigSave"
      @update-config="onConfigUpdate"
    />
    <NodeOutputPanel
      v-else
      :open="configOpen"
      :node="selectedNode"
      :children="selectedChildren"
      @close="closeConfig"
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
        class="cm-item"
        @click="onCtxAddStickyNote"
      >
        <span class="ico">✎</span>
        <span class="lbl">Add sticky note</span>
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
      <div class="sep" />
      <div
        class="cm-item"
        @click="onCtxScreenshot"
      >
        <span class="ico">📸</span>
        <span class="lbl">Screenshot view</span>
      </div>
      <div
        class="cm-item"
        :class="{ accent: isRecording }"
        @click="onCtxRecord"
      >
        <span class="ico">{{ isRecording ? '⏹' : '⏺' }}</span>
        <span class="lbl">{{ isRecording ? 'Stop recording' : 'Record execution' }}</span>
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

import CommandPrompt from './routines/CommandPrompt.vue';
import LoopFrameNode from './routines/LoopFrameNode.vue';
import NodeConfigPanel from './routines/NodeConfigPanel.vue';
import NodeDrawer from './routines/NodeDrawer.vue';
import NodeOutputPanel from './routines/NodeOutputPanel.vue';
import RoutineEdge from './routines/RoutineEdge.vue';
import RoutineNode from './routines/RoutineNode.vue';
import StickyNoteNode from './routines/StickyNoteNode.vue';
import {
  enrichNodesForDisplay,
  findLibraryItem,
  makeFunctionNodeData,
  makeIntegrationNodeData,
  makeRoutineNodeData,
  type FunctionInfo,
  type Integration,
} from './routines/libraryMapping';

import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';
import { useLiveClock } from '@pkg/composables/useLiveClock';
import { useWorkflowHistory } from '@pkg/composables/useWorkflowHistory';
import { useWorkflowPersistence, type WorkflowDefinition } from '@pkg/composables/useWorkflowPersistence';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

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

const emit = defineEmits<{
  'back-to-home':   [];
  /** Fires whenever execution state flips — parent hides the "All routines"
      back button (and anything else in its chrome) while a run is live. */
  'running-change': [running: boolean];
}>();

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
// `hasActiveExecution` is the source of truth for "is a run still live?".
// It flips true the moment we hit Run and only flips false on a *real*
// terminal event from the backend (workflow_completed/failed/aborted) or
// a successful abort IPC round-trip. The stall watchdog surfaces a
// "stalled" hint but does NOT clear this flag — otherwise a quiet stream
// would strand the user with a dangling backend run and no Stop button.
const hasActiveExecution = ref(false);
const isStalled = ref(false);
const isRunBusy = ref(false);
const runError = ref<string | null>(null);
const lastExecutionId = ref<string | null>(null);

// Emit on transitions so the parent can hide its chrome during a run
// without needing its own WebSocket subscription.
watch(hasActiveExecution, (v) => emit('running-change', v), { immediate: true });

// The Stop button is visible whenever the backend might still be doing
// work. `hasActiveExecution` keeps it available even if the event stream
// goes quiet (stall) — the user must always be able to abort a dangling
// run, otherwise they're stuck waiting with no recourse.
const isStopVisible = computed(() => hasActiveExecution.value || isRunBusy.value);

// ── Run-level telemetry for the bottom Output Ribbon ──
// `runStartedAt` is stamped on `workflow_started` and cleared on the
// terminal events so the ribbon's elapsed counter freezes at the final
// runtime. Completed nodes get tallied in a ref so the ribbon's X / Y
// readout updates reactively as the run progresses.
const runStartedAt = ref<number | null>(null);
const runEndedAt = ref<number | null>(null);
const runCompletedNodeIds = ref<Set<string>>(new Set());
const runClock = useLiveClock();

function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${ String(h).padStart(2, '0') }:${ mm }:${ ss }` : `${ mm }:${ ss }`;
}

const runElapsedLabel = computed(() => {
  if (!runStartedAt.value) return '00:00';
  const end = runEndedAt.value ?? runClock.value;
  return formatRunDuration(end - runStartedAt.value);
});

// Trigger nodes don't run through the orchestrator; sticky notes are
// canvas annotations and never execute. Exclude both from the ribbon's
// X / Y count so the total matches what actually executes.
const totalExecutableCount = computed(() => {
  return nodes.value.filter((n) => {
    if ((n).type === 'sticky-note') return false;
    return n.data?.category !== 'trigger';
  }).length;
});

const completedCount = computed(() => runCompletedNodeIds.value.size);

const runningTitle = computed(() => {
  for (const n of nodes.value) {
    const running = n.data?.execution?.status === 'running' || n.data?.state === 'running';
    if (running) {
      return (n.data?.title as string | undefined) || (n.data?.label as string | undefined) || 'agent';
    }
  }
  return '';
});

// ETA is a rough "average time per completed node × remaining". Shown
// only once we have at least two completions so the initial guess isn't
// wildly off. Cleared when the run ends.
const runEtaLabel = computed(() => {
  if (!isRunBusy.value || !runStartedAt.value) return '';
  const completed = runCompletedNodeIds.value.size;
  if (completed < 2) return '';
  const total = totalExecutableCount.value;
  const remaining = Math.max(total - completed, 0);
  if (remaining === 0) return '';
  const elapsed = runClock.value - runStartedAt.value;
  const avg = elapsed / completed;
  return formatRunDuration(avg * remaining);
});

// ── Live event stream ──
// `liveEvents` is what the top-left stream panel renders while a run
// is in progress. Populated by the WebSocket subscription below as
// PlaybookController emits events. Cleared on `workflow_started` so
// each run begins with a fresh log.
interface StreamLine {
  t:       string;
  k:       'tool' | 'obs' | 'thk' | 'dec' | 'err';
  msg:     string;
  /** Optional override for the kind chip label. When set, the chip shows
      this string instead of the default "thinking"/"tool"/etc. — used
      for `thk` lines so the chip tells you *which* node is thinking. */
  badge?:  string;
  /** Emitting node, when the event is node-attributed. Lets the run-mode
      output drawer filter the global stream down to one card's turns. */
  nodeId?: string;
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
    // Re-read inside nextTick — the new line is in the DOM now, so
    // scrollHeight reflects its height and we snap to the true bottom
    // rather than the pre-render bottom. Scroll is cosmetic; floating
    // the promise is intentional (void marks it as such).
    void nextTick(() => {
      const node = streamRef.value;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    });
  }
});

// Stall watchdog — a quiet event stream doesn't mean the backend died.
// Long agent thinking phases or remote calls can pause the event stream
// for minutes while the run is still very much alive. So stalling only
// SURFACES a hint (`isStalled`); it no longer clears `isRunBusy` or
// `hasActiveExecution`. The Stop button stays live the entire time —
// the user must always be able to abort a dangling run.
// 5 minutes — long enough that a slow subconscious / long agent thinking
// phase doesn't falsely flag the run as stalled, short enough that a
// truly dead stream eventually surfaces. This flag is visual-only;
// Stop stays clickable regardless.
const MAX_STALL_MS = 300_000;
let runStallTimer: ReturnType<typeof setTimeout> | null = null;

function bumpStallTimer() {
  if (runStallTimer) clearTimeout(runStallTimer);
  isStalled.value = false;
  runStallTimer = setTimeout(() => {
    isStalled.value = true;
    runStallTimer = null;
  }, MAX_STALL_MS);
}

function clearStallTimer() {
  if (runStallTimer) {
    clearTimeout(runStallTimer);
    runStallTimer = null;
  }
  isStalled.value = false;
}

// Centralized lifecycle transitions so the three flags never get out of
// sync. `beginRun` fires the instant the user hits Play; `endRun` fires
// only on real terminal signals (workflow_completed/failed/aborted or a
// confirmed abort IPC) — never from the stall watchdog.
function beginRun() {
  // Launching a live run bumps us out of any historical view — the
  // banner/hydrated state would otherwise fight with incoming live
  // events.
  viewingPastRun.value = null;
  hasActiveExecution.value = true;
  isRunBusy.value = true;
  runError.value = null;
  liveEvents.value = [{ t: stamp(), k: 'thk', msg: 'Loading routine…', badge: 'booting' }];
  bumpStallTimer();
}

// Any nodes still in `running` state when a run terminates need to have
// their execution sealed so the live elapsed timer freezes and the card
// stops glowing violet. `terminal` decides the settled state: 'done' for
// clean completions, 'failed' for aborts / failures (the node was in the
// middle of work and got interrupted — closer to failed than done).
function freezeRunningNodes(terminal: 'done' | 'failed') {
  const ts = Date.now();
  let touched = false;
  for (const node of nodes.value) {
    const state = node.data?.state;
    if (state !== 'running') continue;
    const prevExec = (node.data?.execution as Record<string, unknown> | undefined) ?? {};
    node.data = {
      ...node.data,
      state:     terminal,
      execution: {
        ...prevExec,
        status:      terminal === 'done' ? 'completed' : 'failed',
        completedAt: ts,
        // Preserve existing startedAt so elapsedLabel resolves to a
        // frozen duration instead of blanking.
        startedAt:   prevExec.startedAt ?? ts,
      },
    };
    touched = true;
  }
  if (touched) nodes.value = [...nodes.value];
}

function endRun(terminal: 'done' | 'failed' = 'failed') {
  freezeRunningNodes(terminal);
  hasActiveExecution.value = false;
  isRunBusy.value = false;
  clearStallTimer();
}

async function onRunClick() {
  if (!props.workflowId) {
    console.warn('[AgentRoutines] Run clicked with no workflowId — nothing to execute.');

    return;
  }
  if (hasActiveExecution.value) return;

  beginRun();

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
    endRun();
  }
}

async function onStopClick() {
  const execId = lastExecutionId.value;
  if (!execId) {
    // No known execution — just clear local state so the user can
    // recover the UI. The walker is either already done or never
    // started; either way there's nothing to abort.
    endRun();

    return;
  }
  try {
    pushLine('dec', 'aborting…');
    const result = await ipcRenderer.invoke('routines-abort', execId);
    if (!result?.aborted) {
      pushLine('err', `abort failed${ result?.reason ? `: ${ result.reason }` : '' }`);
    }
    // On success the backend emits `workflow_aborted` which hits the
    // event handler and calls endRun(). If the IPC reported no active
    // execution, the backend already lost track of it — clear locally.
    if (!result?.aborted) endRun();
  } catch (err) {
    console.error('[AgentRoutines] Failed to abort routine:', err);
    pushLine('err', `abort failed: ${ err instanceof Error ? err.message : String(err) }`);
    endRun();
  }
}

// ── Node state helpers ──
// Execution events arrive with node ids; mutate node.data.state so the
// canvas cards animate. The auto-save watch is deep, but the save gate
// checks `props.workflowId` + `hasHydrated` so these mutations won't
// round-trip to the store.

// Map UI state vocabulary → execution.status vocabulary the node
// component reads for timestamped state transitions.
function execStatusFor(state: 'idle' | 'queued' | 'running' | 'done' | 'failed') {
  switch (state) {
  case 'running': return 'running' as const;
  case 'done': return 'completed' as const;
  case 'failed': return 'failed' as const;
  case 'queued': return 'waiting' as const;
  default: return undefined;
  }
}

// ── Cinematic auto-follow camera ──
// When a node starts running during a live execution, pan + zoom the
// canvas so the active card sits centered and takes roughly a fifth of
// the viewport. Includes its 1-hop neighbors in the fit so the viewer
// can see where data is coming from and where it's heading next. Only
// fires during `isRunBusy` so editing stays uninterrupted, and can be
// opted out via `cinemaMode.value`.
const cinemaMode = ref(true);

function focusOnRunningNode(nodeId: string) {
  if (!cinemaMode.value || !isRunBusy.value) return;

  // Events may arrive with a subnode id (e.g. `-prompt-0`). Resolve to
  // the real canvas card so the fitView actually matches.
  const canvasNode = resolveCanvasNode(nodeId);
  if (!canvasNode) return;
  const canvasId = canvasNode.id;

  // Collect 1-hop neighbors on both sides so the frame tells a story:
  // source → running → target.
  const neighbors = new Set<string>([canvasId]);
  for (const edge of edges.value) {
    if (edge.source === canvasId) neighbors.add(edge.target);
    if (edge.target === canvasId) neighbors.add(edge.source);
  }
  const ids = [...neighbors].filter(id => nodes.value.some(n => n.id === id));
  if (ids.length === 0) return;

  // Padding ~1.2 keeps the running card around 20-25% of the viewport
  // width on a typical canvas — wide enough to read details, with the
  // neighbors visible at the edges of frame for context.
  void fitView({
    nodes:    ids,
    padding:  1.2,
    duration: 700,
    maxZoom:  1.4,
    minZoom:  0.4,
  });
}

function setNodeState(
  nodeId: string,
  state: 'idle' | 'queued' | 'running' | 'done' | 'failed',
  ts?: number,
) {
  const node = resolveCanvasNode(nodeId);
  if (!node) return;

  const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
  const prevExec = (node.data?.execution as
    { startedAt?: number; completedAt?: number } | undefined) ?? {};
  const execStatus = execStatusFor(state);

  // Stamp startedAt/completedAt so RoutineNode.vue's elapsed counter has
  // a clock to read. `running` always starts a fresh timer (overwrites
  // any previous start). `done`/`failed` seal the duration — preserve an
  // existing startedAt if the run actually had one.
  let startedAt = prevExec.startedAt;
  let completedAt = prevExec.completedAt;

  if (state === 'running') {
    startedAt = t;
    completedAt = undefined;
  } else if (state === 'done' || state === 'failed') {
    completedAt = t;
    if (typeof startedAt !== 'number') startedAt = t;
  } else if (state === 'idle' || state === 'queued') {
    startedAt = undefined;
    completedAt = undefined;
  }

  node.data = {
    ...node.data,
    state,
    execution: {
      ...(node.data?.execution as Record<string, unknown> ?? {}),
      status: execStatus,
      startedAt,
      completedAt,
    },
  };
}

function resetNodeStates() {
  for (const node of nodes.value) {
    if (node.data?.state && node.data.state !== 'idle') {
      node.data = {
        ...node.data,
        state:     'idle',
        execution: undefined,
      };
    }
  }
}

// Attach the node's output to its `execution` bag so the right-hand
// drawer can show it when the user clicks a running/done card during a
// run. We keep the raw value — the drawer does its own formatting.
function setNodeExecutionOutput(nodeId: string, output: unknown) {
  const node = resolveCanvasNode(nodeId);
  if (!node) return;
  const prevExec = (node.data?.execution as Record<string, unknown> | undefined) ?? {};
  node.data = {
    ...node.data,
    execution: { ...prevExec, output },
  };
}

/**
 * Per-node conversation log. Mirrors the top-left live stream but stored
 * on each node so turns survive longer than the global 50-line buffer
 * and the run-mode output drawer can show a card's full timeline.
 *
 * Capped at NODE_TURN_LIMIT so a chatty multi-turn agent can't pin
 * unbounded memory on the node. Cleared implicitly when the node's
 * execution bag is reset at the start of a run (see resetNodeStates).
 */
interface NodeTurn {
  t:      string;
  k:      'tool' | 'obs' | 'thk' | 'dec' | 'err';
  msg:    string;
  badge?: string;
}
const NODE_TURN_LIMIT = 200;

// PlaybookController attaches subnode suffixes like `-prompt-0` to the
// node id on delegation — the same regex `displayNodeName` uses. Resolve
// here so turns and state transitions route to the actual canvas card
// even when events carry sub-ids.
function resolveCanvasNode(nodeId: string) {
  const direct = nodes.value.find(n => n.id === nodeId);
  if (direct) return direct;
  const baseId = nodeId.replace(/-[a-z]+-\d+$/, '');
  if (baseId !== nodeId) {
    return nodes.value.find(n => n.id === baseId);
  }
  return undefined;
}

function appendNodeTurn(nodeId: string, turn: NodeTurn) {
  const node = resolveCanvasNode(nodeId);
  if (!node) return;
  const prevExec = (node.data?.execution as { turns?: NodeTurn[] } & Record<string, unknown> | undefined) ?? {};
  const prevTurns: NodeTurn[] = Array.isArray(prevExec.turns) ? prevExec.turns : [];
  // Keep the most recent NODE_TURN_LIMIT entries — drops the oldest when
  // the ring fills so the newest turn is always visible in the drawer.
  const nextTurns = prevTurns.length >= NODE_TURN_LIMIT
    ? [...prevTurns.slice(-(NODE_TURN_LIMIT - 1)), turn]
    : [...prevTurns, turn];
  node.data = {
    ...node.data,
    execution: { ...prevExec, turns: nextTurns },
  };
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

function pushLine(
  kind:    StreamLine['k'],
  msg:     string,
  ts?:     number,
  badge?:  string,
  nodeId?: string,
) {
  const t = stamp(ts);
  const line: StreamLine = { t, k: kind, msg };
  if (badge) line.badge = badge;
  if (nodeId) line.nodeId = nodeId;
  liveEvents.value = [...liveEvents.value.slice(-49), line];

  // Shadow every node-attributed line into that node's own turns log —
  // gives the run-mode output drawer a persistent conversation buffer
  // that survives past the global stream's 50-line horizon.
  if (nodeId) {
    const turn: NodeTurn = { t, k: kind, msg };
    if (badge) turn.badge = badge;
    appendNodeTurn(nodeId, turn);
  }
}

// Short label displayed in the stream kind chip. Kept as a function so
// the existing CSS selectors (.k.tool, .k.obs, .k.thk, .k.dec, .k.err)
// still target the class, and the text tracks alongside.
function streamKindLabel(kind: StreamLine['k']): string {
  switch (kind) {
  case 'tool': return 'tool';
  case 'obs': return 'observed';
  case 'thk': return 'thinking';
  case 'dec': return 'decided';
  case 'err': return 'error';
  default: return kind;
  }
}

// Strip XML/HTML tags, CDATA sections, and HTML entities from agent
// content before it lands in the stream. Agents occasionally emit
// structured thinking like `<thinking>…</thinking>` or tool-call blobs
// like `<function_calls>…</function_calls>` that read as noise in a
// live ticker — we want the prose, not the envelope.
function stripXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/&(?:[a-zA-Z]+|#\d+);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolve a human-readable name for a node. Prefer the event-supplied
// label (PlaybookController attaches it), then fall back to the on-canvas
// node's `data.title`/`data.label`. Raw node ids are never shown — they
// leak internals like `node-1741000000002-prompt-0` that mean nothing
// to the user reading the live stream.
function displayNodeName(nodeId?: string, nodeLabel?: string): string {
  if (nodeLabel?.trim()) return nodeLabel.trim();
  if (nodeId) {
    // Strip subnode suffixes like "-prompt-0" that PlaybookController
    // appends — the underlying node still lives in nodes.value under
    // the base id.
    const baseId = nodeId.replace(/-[a-z]+-\d+$/, '');
    const node = nodes.value.find(n => n.id === baseId || n.id === nodeId);
    const d = node?.data as { title?: string; label?: string } | undefined;
    const name = d?.title || d?.label;
    if (name?.trim()) return name.trim();
  }

  return 'agent';
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
  const who = displayNodeName(nodeId, nodeLabel);
  // PlaybookController emits ISO strings; the elapsed counter in
  // RoutineNode needs ms. Parse once per event so every setNodeState
  // call inside this switch gets the same timebase.
  const tsMs = typeof event?.timestamp === 'string'
    ? Date.parse(event.timestamp)
    : (typeof event?.timestamp === 'number' ? event.timestamp : Date.now());

  switch (event?.type) {
  case 'workflow_started':
    resetNodeStates();
    // Re-arm the run lifecycle flags in case this is a reconnect (the
    // user's initial Run click already called beginRun, but a late-
    // arriving reconnect needs the same setup so the Stop button stays
    // correct and the stall watchdog restarts).
    beginRun();
    runStartedAt.value = tsMs;
    runEndedAt.value = null;
    runCompletedNodeIds.value = new Set();
    pushLine('dec', 'started', event.timestamp);
    break;

  case 'node_started':
    if (nodeId) {
      setNodeState(nodeId, 'running', tsMs);
      focusOnRunningNode(nodeId);
    }
    pushLine('tool', who, event.timestamp, undefined, nodeId);
    break;

  case 'node_completed':
    if (nodeId) {
      setNodeState(nodeId, 'done', tsMs);
      if (event.output != null) setNodeExecutionOutput(nodeId, event.output);
      // Tally toward the ribbon's X / Y without double-counting if the
      // same node completes twice (retry paths do re-emit).
      if (!runCompletedNodeIds.value.has(nodeId)) {
        const next = new Set(runCompletedNodeIds.value);
        next.add(nodeId);
        runCompletedNodeIds.value = next;
      }
    }
    pushLine('obs', `${ who } · done`, event.timestamp, undefined, nodeId);
    break;

  case 'node_failed': {
    if (nodeId) setNodeState(nodeId, 'failed', tsMs);
    const raw = typeof event.error === 'string' ? event.error : JSON.stringify(event.error ?? 'failed');
    const err = stripXml(raw).slice(0, 240);
    pushLine('err', `${ who } · ${ err }`, event.timestamp, undefined, nodeId);
    break;
  }

  case 'node_thinking':
    // All agent thinking surfaces in the top-left stream. The chip
    // prefers the event's `thinkingLabel` when set — subconscious
    // subagents (memory-recall, observation, summarizer) use it so
    // their work is visibly attributed instead of silently running
    // under the orchestrator's name for 30+ seconds.
    if (event.content) {
      const text = stripXml(String(event.content)).slice(0, 220);
      const badge = (typeof event.thinkingLabel === 'string' && event.thinkingLabel.trim())
        ? event.thinkingLabel.trim()
        : who;
      if (text) pushLine('thk', text, event.timestamp, badge, nodeId);
    }
    break;

  case 'edge_activated':
    // Kept silent in the stream — the node-level events already tell
    // the story. Could visualize the edge later if useful.
    break;

  case 'workflow_completed':
    pushLine('dec', 'completed', event.timestamp);
    runEndedAt.value = tsMs;
    endRun('done');
    break;

  case 'workflow_aborted':
    pushLine('err', `aborted${ event.reason ? `: ${ event.reason }` : '' }`, event.timestamp);
    runEndedAt.value = tsMs;
    endRun('failed');
    break;

  case 'workflow_failed':
    pushLine('err', `failed${ event.error ? `: ${ event.error }` : '' }`, event.timestamp);
    runEndedAt.value = tsMs;
    endRun('failed');
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
    try { wsUnsubscribe() } catch { /* ignore */ }
    wsUnsubscribe = null;
  }
  clearStallTimer();
}

const selectedNodeId = ref<string | null>(null);
const selectedNode = computed(() => nodes.value.find(n => n.id === selectedNodeId.value) || null);
const configOpen = computed(() => selectedNodeId.value !== null);

const title = ref('Blog Production Pipeline');
const subtitle = ref('Twenty-one agents, one article, nine minutes.');
const workflowStatus = ref<'draft' | 'production' | 'archive'>('draft');
const statusBusy = ref(false);

async function togglePublished(): Promise<void> {
  if (!props.workflowId || statusBusy.value) return;
  const next = workflowStatus.value === 'production' ? 'draft' : 'production';
  statusBusy.value = true;
  try {
    const result = await ipcRenderer.invoke('workflow-move', props.workflowId, next);
    if (result?.success) {
      workflowStatus.value = result.newStatus ?? next;
    }
  } catch (err) {
    console.error('[AgentRoutines] workflow-move failed:', err);
  } finally {
    statusBusy.value = false;
  }
}

// ── Persistence ──
// When `workflowId` is present, the canvas becomes a live editor: the
// graph is hydrated from the store on mount and auto-saved (debounced)
// on every subsequent mutation. Unknown fields on the loaded document
// (author, license, trust, etc.) are kept in `baseDefinition` so the
// save path round-trips them verbatim. `hasHydrated` gates the save
// watch so the initial assignments from load() don't re-save the same
// document straight back.
const persistence = useWorkflowPersistence();
const history = useWorkflowHistory();
const baseDefinition = ref<WorkflowDefinition | null>(null);
const hasHydrated = ref(false);
// Flag that suppresses the auto-save watch while we're re-hydrating from
// a history snapshot (undo/redo). Otherwise applyDefinition() would
// trigger scheduleSave → create a new history row → undo would itself
// pollute the audit trail we're trying to walk.
const isRestoring = ref(false);

// VueFlow wraps every on-canvas node/edge with runtime metadata that
// isn't structured-cloneable across IPC (event handler maps, computed
// getters, symbol-keyed internals, DOM rects). Before handing a save
// payload to the main process we reduce each node/edge down to the
// routine-schema fields — explicit allowlist keeps the wire shape in
// sync with the YAML contract and avoids DataCloneError surprises.
//
// For free-form subtrees (node `data`, `viewport`) we walk the value
// and drop anything structured-clone rejects (functions, symbols, class
// instances with non-cloneable backing) while preserving every plain
// JSON value. Safer than JSON.stringify because it doesn't silently
// lose Dates or typed arrays — those stay intact and clone fine.
function toCloneable(v: any): any {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return v;
  if (t === 'function' || t === 'symbol') return undefined;
  if (t !== 'object') return undefined;
  if (Array.isArray(v)) {
    return v.map(toCloneable).filter(x => x !== undefined);
  }
  // Plain object or reactive proxy over one. Copy own-enumerable
  // string keys only — drops symbol-keyed internals (VueFlow uses
  // these for framework-only state) which are the usual DataCloneError
  // culprit.
  const out: Record<string, any> = {};
  for (const k of Object.keys(v)) {
    try {
      const cleaned = toCloneable(v[k]);
      if (cleaned !== undefined) out[k] = cleaned;
    } catch {
      // Accessor that throws during read — skip it entirely.
    }
  }

  return out;
}

function toPlainNode(n: any) {
  return {
    id:       String(n.id),
    type:     n.type,
    position: { x: Number(n.position?.x ?? 0), y: Number(n.position?.y ?? 0) },
    data:     toCloneable(n.data),
    ...(n.width != null ? { width: n.width } : {}),
    ...(n.height != null ? { height: n.height } : {}),
    ...(n.zIndex != null ? { zIndex: Number(n.zIndex) } : {}),
    ...(n.parentNode ? { parentNode: n.parentNode } : {}),
  };
}

function toPlainEdge(e: any) {
  return {
    id:     String(e.id),
    source: e.source,
    target: e.target,
    ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
    ...(e.type ? { type: e.type } : {}),
    ...(e.label != null ? { label: e.label } : {}),
    ...(e.data ? { data: toCloneable(e.data) } : {}),
  };
}

function buildDefinitionForSave(): WorkflowDefinition | null {
  if (!props.workflowId) return null;

  const base = baseDefinition.value ?? {};
  const vp: any = (base as any).viewport;

  return {
    ...base,
    id:          props.workflowId,
    name:        title.value,
    description: subtitle.value,
    nodes:       nodes.value.map(toPlainNode),
    edges:       edges.value.map(toPlainEdge),
    viewport:    vp
      ? { x: Number(vp.x ?? 0), y: Number(vp.y ?? 0), zoom: Number(vp.zoom ?? 1) }
      : { x: 0, y: 0, zoom: 1 },
  };
}

/**
 * Replace the canvas state with a definition snapshot — used by the
 * undo/redo flow and by the initial mount hydration. Keeps both paths
 * in sync so any field the editor cares about is re-applied from the
 * snapshot consistently.
 */
function applyDefinition(def: WorkflowDefinition): void {
  if (typeof def.name === 'string') title.value = def.name;
  if (typeof def.description === 'string') subtitle.value = def.description;
  const status = (def as any)._status;
  if (status === 'draft' || status === 'production' || status === 'archive') {
    workflowStatus.value = status;
  }
  if (Array.isArray(def.nodes)) nodes.value = def.nodes as typeof nodes.value;
  if (Array.isArray(def.edges)) {
    // Migrate legacy edges that were persisted as `smoothstep` (or with
    // no type at all) to our custom `routine` edge so every edge picks
    // up the base-track + traveling-pulse treatment. Auto-save will
    // re-persist with the new type on the next mutation.
    edges.value = (def.edges as any[]).map((e) => {
      if (!e.type || e.type === 'smoothstep') return { ...e, type: 'routine' };
      return e;
    });
  }
  baseDefinition.value = def;
  enrichNodesForDisplay(nodes.value);
}

async function undo(): Promise<void> {
  if (!props.workflowId || !history.canUndo.value) return;
  const snapshot = history.stepBack();
  if (!snapshot) return;
  isRestoring.value = true;
  try {
    applyDefinition(snapshot);
    await nextTick();
    const payload = buildDefinitionForSave();
    if (payload) await persistence.saveSilent(payload);
  } finally {
    // Give the deep watch one tick to flush before re-enabling auto-save.
    await nextTick();
    isRestoring.value = false;
  }
}

async function redo(): Promise<void> {
  if (!props.workflowId || !history.canRedo.value) return;
  const snapshot = history.stepForward();
  if (!snapshot) return;
  isRestoring.value = true;
  try {
    applyDefinition(snapshot);
    await nextTick();
    const payload = buildDefinitionForSave();
    if (payload) await persistence.saveSilent(payload);
  } finally {
    await nextTick();
    isRestoring.value = false;
  }
}

// Platform-appropriate modifier symbol for tooltips. macOS users expect
// ⌘, Windows/Linux users expect Ctrl.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent ?? '');
function shortcutLabel(key: string): string {
  return isMac ? `⌘${ key }` : `Ctrl+${ key }`;
}

const persistenceLabel = computed<string | null>(() => {
  switch (persistence.status.value) {
  case 'loading': return 'Loading…';
  case 'saving': return 'Saving…';
  case 'saved': return 'Saved';
  case 'error': return 'Save failed';
  default: return null;
  }
});

// Provide mode to descendant RoutineNode components so they can hide edit-only UI.
provide<typeof mode>('routines-mode', mode);

// When a drag (library item OR an on-canvas node) passes over a loop
// frame, we stash the frame's id here so the LoopFrameNode can add a
// "drop target" highlight class. Cleared on drop / drag-end / leave.
const dropTargetLoopId = ref<string | null>(null);
provide('routines-drop-target-loop', dropTargetLoopId);

const ctxMenu = reactive({ visible: false, x: 0, y: 0 });
const nodeCtx = reactive({ visible: false, x: 0, y: 0, nodeId: null as string | null });
const selectedEdgeId = ref<string | null>(null);

// ── Run history ──
// Backed by the `workflow_checkpoints` table. `routines-list-runs`
// returns summary rows; clicking one fires `routines-load-run` and
// hydrates the canvas with that run's recorded node outputs. The
// canvas enters `viewingPastRun` mode — Run / edits disabled until
// the user returns to live.
interface PastRunSummary {
  executionId:     string;
  workflowId:      string;
  workflowName:    string;
  lastNodeId:      string;
  lastNodeLabel:   string;
  checkpointCount: number;
  startedAt:       string;
  endedAt:         string;
}
const runsFlyoutOpen = ref(false);
const pastRuns = ref<PastRunSummary[]>([]);
const pastRunsLoading = ref(false);
const viewingPastRun = ref<{ executionId: string; startedAt: string; endedAt: string } | null>(null);

async function fetchPastRuns() {
  if (!props.workflowId) {
    pastRuns.value = [];
    return;
  }
  pastRunsLoading.value = true;
  try {
    const rows = await ipcRenderer.invoke('routines-list-runs', props.workflowId, 25);
    pastRuns.value = Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.warn('[AgentRoutines] Failed to load run history:', err);
    pastRuns.value = [];
  } finally {
    pastRunsLoading.value = false;
  }
}

function toggleRunsFlyout() {
  runsFlyoutOpen.value = !runsFlyoutOpen.value;
  if (runsFlyoutOpen.value) void fetchPastRuns();
}

function closeRunsFlyout() {
  runsFlyoutOpen.value = false;
}

async function openPastRun(executionId: string) {
  closeRunsFlyout();
  try {
    const snapshot = await ipcRenderer.invoke('routines-load-run', executionId);
    if (!snapshot) {
      pushLine('err', 'Run snapshot not found');
      return;
    }
    // Clear any in-flight state first so the canvas doesn't show a
    // half-live, half-historical mix.
    resetNodeStates();
    liveEvents.value = [];

    // Apply each checkpointed node's output + state to its canvas card.
    // Nodes that never ran in this execution stay idle. The baseline
    // startedAt / completedAt give the elapsed counter a stable frozen
    // duration.
    const startedMs = Date.parse(snapshot.startedAt) || Date.now();
    const endedMs = Date.parse(snapshot.endedAt) || startedMs;
    for (const [nodeId, entry] of Object.entries(snapshot.nodeOutputs ?? {})) {
      const out = entry as { nodeId: string; output: unknown; completedAt: string };
      const completedMs = Date.parse(out.completedAt) || endedMs;
      setNodeState(out.nodeId ?? nodeId, 'done', completedMs);
      // Back-date startedAt to give the elapsed readout a sensible
      // duration — we don't have per-node start times in the checkpoint
      // so fall back to the run's start.
      const canvasNode = resolveCanvasNode(out.nodeId ?? nodeId);
      if (canvasNode) {
        const exec = (canvasNode.data?.execution as Record<string, unknown> | undefined) ?? {};
        canvasNode.data = {
          ...canvasNode.data,
          execution: { ...exec, startedAt: startedMs, completedAt: completedMs },
        };
      }
      if (out.output != null) setNodeExecutionOutput(out.nodeId ?? nodeId, out.output);
    }

    viewingPastRun.value = {
      executionId: snapshot.executionId,
      startedAt:   snapshot.startedAt,
      endedAt:     snapshot.endedAt,
    };
    // Trigger the edge-flow recompute so idle edges stay dim (no edges
    // should light up during history view — no node is "running").
    nodes.value = [...nodes.value];
  } catch (err) {
    console.warn('[AgentRoutines] Failed to open past run:', err);
    pushLine('err', `failed to load run: ${ err instanceof Error ? err.message : String(err) }`);
  }
}

function exitPastRunView() {
  viewingPastRun.value = null;
  resetNodeStates();
  liveEvents.value = [];
}

function formatRunStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatRunSpan(startIso: string, endIso: string): string {
  const ms = Math.max(Date.parse(endIso) - Date.parse(startIso), 0);
  if (!Number.isFinite(ms)) return '';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${ h }h ${ String(mm).padStart(2, '0') }m`;
  }
  return m > 0 ? `${ m }m ${ String(s).padStart(2, '0') }s` : `${ s }s`;
}

const { setInteractive, zoomIn, zoomOut, fitView, project, addNodes, addEdges, getSelectedNodes, getSelectedEdges } = useVueFlow();

// ── Delete confirmation ──
// One dialog handles keyboard Delete, the node context menu's "Remove
// from flow" item, and any future delete path — keeps deletion behind
// exactly one confirmation so we can never drop work by accident. The
// selection snapshot is taken when the dialog opens so subsequent
// canvas clicks (which would change the selection) don't silently
// change what gets deleted.
interface DeleteTarget {
  nodeIds: string[];
  edgeIds: string[];
}
const deleteConfirm = ref<DeleteTarget | null>(null);

function collectDeletionTarget(): DeleteTarget | null {
  if (mode.value !== 'edit') return null;
  const selectedNodes = getSelectedNodes.value ?? [];
  const selectedEdges = getSelectedEdges.value ?? [];
  const nodeIds = new Set<string>(selectedNodes.map((n: any) => n.id));
  const edgeIds = new Set<string>(selectedEdges.map((e: any) => e.id));
  // Fall back to the explicit selection refs so single-click selections
  // (which don't always populate VueFlow's multiselect state) still work.
  if (selectedNodeId.value) nodeIds.add(selectedNodeId.value);
  if (selectedEdgeId.value) edgeIds.add(selectedEdgeId.value);
  if (nodeIds.size === 0 && edgeIds.size === 0) return null;
  return { nodeIds: [...nodeIds], edgeIds: [...edgeIds] };
}

function requestDelete(explicit?: DeleteTarget) {
  if (mode.value !== 'edit') return;
  const target = explicit ?? collectDeletionTarget();
  if (!target) return;
  deleteConfirm.value = target;
}

function cancelDelete() {
  deleteConfirm.value = null;
}

function confirmDelete() {
  const target = deleteConfirm.value;
  if (!target) return;
  const nodeIds = new Set(target.nodeIds);
  const edgeIds = new Set(target.edgeIds);
  // Drop the selected edges plus any edge orphaned by a removed node —
  // leaving dangling edges pointing at nothing would break the graph.
  if (nodeIds.size > 0) {
    nodes.value = nodes.value.filter(n => !nodeIds.has(n.id));
    edges.value = edges.value.filter(e => !nodeIds.has(e.source) && !nodeIds.has(e.target));
  }
  if (edgeIds.size > 0) {
    edges.value = edges.value.filter(e => !edgeIds.has(e.id));
  }
  // Clear residual selection state so the UI doesn't point at ghosts.
  if (selectedNodeId.value && nodeIds.has(selectedNodeId.value)) selectedNodeId.value = null;
  if (selectedEdgeId.value && edgeIds.has(selectedEdgeId.value)) selectedEdgeId.value = null;
  deleteConfirm.value = null;
}

const deleteConfirmSummary = computed(() => {
  const t = deleteConfirm.value;
  if (!t) return '';
  const parts: string[] = [];
  if (t.nodeIds.length === 1) parts.push('1 node');
  else if (t.nodeIds.length > 1) parts.push(`${ t.nodeIds.length } nodes`);
  if (t.edgeIds.length === 1) parts.push('1 edge');
  else if (t.edgeIds.length > 1) parts.push(`${ t.edgeIds.length } edges`);
  return parts.join(' + ');
});

watch(locked, (l) => {
  setInteractive(!l);
}, { immediate: true });

function onInteractionChange(active: boolean) {
  // User clicked the lock button in the toolbar — sync edit-mode lock state.
  if (mode.value === 'edit') editLocked.value = !active;
}

function onPaneContextMenu(event: MouseEvent) {
  event.preventDefault();
  const frame = (event.currentTarget as HTMLElement)?.closest('.routines-frame') ??
    (event.target as HTMLElement)?.closest('.routines-frame');
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
  if (mode.value === 'edit') {
    selectedNodeId.value = node.id;
    return;
  }
  // Run mode — only reveal the inspect drawer for cards that have actually
  // executed (or are executing). Idle/queued cards have nothing to show yet
  // and clicking them would pop an empty drawer.
  const target = nodes.value.find(n => n.id === node.id);
  const state = target?.data?.state;
  if (state === 'running' || state === 'done' || state === 'failed') {
    selectedNodeId.value = node.id;
  }
}

function onPaneClick() {
  closeCtxMenu();
  closeNodeCtx();
  closeRunsFlyout();
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
  const frame = (event.currentTarget as HTMLElement)?.closest('.routines-frame') ??
    (event.target as HTMLElement)?.closest('.routines-frame');
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
  if (mode.value !== 'edit') { closeNodeCtx(); return }
  if (nodeCtx.nodeId) selectedNodeId.value = nodeCtx.nodeId;
  closeNodeCtx();
}

function onNodeCtxDuplicate() {
  if (mode.value !== 'edit' || !nodeCtx.nodeId) { closeNodeCtx(); return }
  const src = nodes.value.find(n => n.id === nodeCtx.nodeId);
  if (!src) { closeNodeCtx(); return }
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
  if (mode.value !== 'edit' || !nodeCtx.nodeId) { closeNodeCtx(); return }
  // Route through the same confirmation dialog keyboard delete uses —
  // one code path for every delete so the UX stays consistent.
  const id = nodeCtx.nodeId;
  closeNodeCtx();
  requestDelete({ nodeIds: [id], edgeIds: [] });
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

// Children of the currently-selected node — only populated for loop
// frames (they're the only container type today). The drawers render
// this list at the bottom so the user can confirm which cards are
// nested inside the loop they just selected.
const selectedChildren = computed(() => {
  const id = selectedNodeId.value;
  if (!id) return [];
  return nodes.value
    .filter(n => (n).parentNode === id)
    .map(n => ({
      nodeId:   n.id,
      label:    (n.data)?.title ?? (n.data)?.label ?? n.id,
      kicker:   (n.data)?.kicker ?? '',
      nodeCode: (n.data)?.nodeCode ?? '',
      state:    (n.data)?.state ?? 'idle',
      avatar:   (n.data)?.avatar ?? { type: 'default' },
    }));
});

// ── Edge connections — drag from one handle to another ──
function onConnect(params: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) {
  if (mode.value !== 'edit') return;
  addEdges([{
    ...params,
    id:   `e-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 6) }`,
    type: 'routine',
  }]);
}

// ── Drag-and-drop from the library drawer onto the canvas ──
const frameRef = ref<HTMLElement | null>(null);

/**
 * Convert a screen-space pointer event to world-space coordinates on the
 * VueFlow canvas. Accepts MouseEvent / DragEvent / TouchEvent — for
 * touch events we read the first contact point, since VueFlow's
 * NodeDragEvent is a MouseTouchEvent union.
 */
function pointerToWorld(event: MouseEvent | TouchEvent | DragEvent): { x: number; y: number } {
  const bounds = frameRef.value?.getBoundingClientRect();
  let clientX = 0;
  let clientY = 0;
  if ('touches' in event && event.touches && event.touches.length > 0) {
    clientX = event.touches[0].clientX;
    clientY = event.touches[0].clientY;
  } else if ('clientX' in event) {
    clientX = (event as MouseEvent).clientX;
    clientY = (event as MouseEvent).clientY;
  }
  return project({
    x: clientX - (bounds?.left ?? 0),
    y: clientY - (bounds?.top ?? 0),
  });
}

/**
 * Is this point inside a loop frame? Returns the topmost loop (by
 * iteration order) whose rectangle contains (worldX, worldY). `excludeId`
 * skips a node that's being dragged so a loop can't claim itself as a
 * child of itself. Coordinates for children are parent-local, so the
 * comparison lifts them back to world-space before testing.
 */
function findLoopAt(worldX: number, worldY: number, excludeId?: string) {
  for (const n of nodes.value) {
    if ((n).type !== 'loop-frame') continue;
    if (n.id === excludeId) continue;
    const w = (n).dimensions?.width ?? (n).width ?? 0;
    const h = (n).dimensions?.height ?? (n).height ?? 0;
    if (!w || !h) continue;
    // Lift parent-local position to world coords if this loop were ever
    // itself nested (future-proof for nested loops).
    let absX = n.position.x;
    let absY = n.position.y;
    const parentId = (n).parentNode as string | undefined;
    if (parentId) {
      const parent = nodes.value.find(p => p.id === parentId);
      if (parent) { absX += parent.position.x; absY += parent.position.y }
    }
    if (worldX >= absX && worldX <= absX + w && worldY >= absY && worldY <= absY + h) {
      return { id: n.id, x: absX, y: absY };
    }
  }
  return null;
}

function onDragOver(event: DragEvent) {
  if (mode.value !== 'edit') return;
  const dt = event.dataTransfer;
  if (!dt) return;
  const hasRoutine = dt.types?.includes('application/x-routine-subtype') ||
    dt.types?.includes('application/x-routine-integration') ||
    dt.types?.includes('application/x-routine-function') ||
    dt.types?.includes('application/x-routine-annotation');
  if (!hasRoutine) return;
  dt.dropEffect = 'copy';

  // Highlight a loop that the pointer is currently hovering over so the
  // user can see their drop is going to land as a child of that loop.
  const world = pointerToWorld(event);
  const hit = findLoopAt(world.x, world.y);
  dropTargetLoopId.value = hit?.id ?? null;
}

function onDragLeave() {
  dropTargetLoopId.value = null;
}

function onDrop(event: DragEvent) {
  if (mode.value !== 'edit') return;
  const dt = event.dataTransfer;
  if (!dt) return;

  const world = pointerToWorld(event);
  // Center the card on the cursor — RoutineNode is ~220×120
  let position = { x: world.x - 110, y: world.y - 60 };

  // If the drop lands inside a loop frame, nest the new node: set
  // parentNode and convert position to parent-local coords so VueFlow
  // lays it out correctly inside the frame.
  const hit = findLoopAt(world.x, world.y);
  const parentNode = hit?.id;
  if (hit) {
    position = { x: position.x - hit.x, y: position.y - hit.y };
  }
  dropTargetLoopId.value = null;

  const id = `routine-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 6) }`;

  // Annotation drop — sticky notes (and future callouts). Go through the
  // dedicated `sticky-note` VueFlow type so they render via StickyNoteNode
  // instead of RoutineNode, and sit behind real nodes via negative zIndex.
  // Deliberately bypasses loop-frame nesting: annotations float above the
  // graph as documentation, not as execution children.
  const annotationSubtype = dt.getData('application/x-routine-annotation');
  if (annotationSubtype === 'sticky-note') {
    const stickyId = `sticky-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 6) }`;
    addNodes([{
      id:       stickyId,
      type:     'sticky-note',
      position: { x: world.x - 120, y: world.y - 80 },
      width:    240,
      height:   160,
      zIndex:   -1,
      data:     {
        subtype:  'sticky-note',
        category: 'annotation',
        content:  '',
        bgColor:  '',
      },
    }]);
    return;
  }

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
        ...(parentNode ? { parentNode, extent: 'parent' } : {}),
      }]);
    } catch { /* malformed payload — ignore */ }

    return;
  }

  // Function drop — decodes to a function subtype node with functionSlug pre-set.
  const functionRaw = dt.getData('application/x-routine-function');
  if (functionRaw) {
    try {
      const fn = JSON.parse(functionRaw) as FunctionInfo;
      addNodes([{
        id,
        type: 'routine',
        position,
        data: makeFunctionNodeData(fn),
        ...(parentNode ? { parentNode, extent: 'parent' } : {}),
      }]);
    } catch { /* malformed payload — ignore */ }

    return;
  }

  // Generic library node drop.
  const subtype = dt.getData('application/x-routine-subtype');
  if (!subtype) return;
  const item = findLibraryItem(subtype);
  if (!item) return;

  // Loops render through LoopFrameNode (dashed container) rather than the
  // regular card. VueFlow needs explicit width/height on the group node
  // so children have somewhere to live. 560×220 fits ~2 cards side-by-side
  // with room for padding and the label pills. Loops cannot be dropped
  // into other loops via this path — we clear parentNode for them to
  // avoid nesting confusion on the first iteration of the feature.
  if (subtype === 'loop') {
    addNodes([{
      id,
      type:     'loop-frame',
      position: parentNode ? { x: world.x - 280, y: world.y - 110 } : position,
      data:     makeRoutineNodeData(item),
      width:    560,
      height:   220,
    }]);
    return;
  }

  addNodes([{
    id,
    type: 'routine',
    position,
    data: makeRoutineNodeData(item),
    ...(parentNode ? { parentNode, extent: 'parent' } : {}),
  }]);
}

// ── On-canvas drag: dragging an existing node over a loop ──
// Mirrors the HTML-drag-drop flow above, but for VueFlow-managed nodes
// already on the canvas. Lets users drop an existing card into a loop by
// grabbing it and moving it over the frame. On drop-stop we either
// (a) assign it to a new parent loop if the drop center lands inside one
// or (b) clear its parentNode if it was dragged out of its old parent.
function onNodeDrag(evt: { event: MouseEvent | TouchEvent; node: { id: string; type?: string } }) {
  if (mode.value !== 'edit') return;
  if (evt.node.type === 'loop-frame') {
    // Dragging a loop itself — don't treat it as a candidate child.
    dropTargetLoopId.value = null;
    return;
  }
  const world = pointerToWorld(evt.event);
  const hit = findLoopAt(world.x, world.y, evt.node.id);
  dropTargetLoopId.value = hit?.id ?? null;
}

function onNodeDragStop(evt: { event: MouseEvent | TouchEvent; node: any }) {
  if (mode.value !== 'edit') return;
  dropTargetLoopId.value = null;
  const node = evt.node;
  if (node.type === 'loop-frame') return;

  const world = pointerToWorld(evt.event);
  const hit = findLoopAt(world.x, world.y, node.id);

  const prevParent = node.parentNode as string | undefined;
  const nextParent = hit?.id;

  if (nextParent === prevParent) return;

  // Find the actual mutable node reference.
  const target = nodes.value.find(n => n.id === node.id);
  if (!target) return;

  if (nextParent) {
    // Entering a loop — convert absolute world coords to parent-local.
    (target).parentNode = nextParent;
    (target).extent = 'parent';
    target.position = { x: world.x - hit.x - 110, y: world.y - hit.y - 60 };
  } else {
    // Leaving — lift back to world coords.
    (target).parentNode = undefined;
    (target).extent = undefined;
    target.position = { x: world.x - 110, y: world.y - 60 };
  }
}

function onCtxAddNode() {
  closeCtxMenu();
  if (mode.value !== 'edit') return;
  drawerOpen.value = true;
}

// Spawn a sticky note where the user right-clicked. ctxMenu.{x,y} are
// frame-relative screen coords (see onPaneContextMenu) — project() lifts
// them to world coords so the note lands under the cursor regardless of
// pan/zoom. Width/height default to a comfortable annotation size; the
// user resizes from there via the 8-direction handles on the note itself.
function onCtxAddStickyNote() {
  const spawn = { x: ctxMenu.x, y: ctxMenu.y };
  closeCtxMenu();
  if (mode.value !== 'edit') return;
  const world = project(spawn);
  const id = `sticky-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 6) }`;
  addNodes([{
    id,
    type:     'sticky-note',
    position: { x: world.x - 120, y: world.y - 80 },
    width:    240,
    height:   160,
    // Negative zIndex pushes the note behind real nodes in VueFlow's node
    // layer. Routine/loop-frame nodes stay on top by default (zIndex 0),
    // so annotations act like a backdrop the user can drag freely without
    // ever obscuring the executable graph underneath.
    zIndex:   -1,
    data:     {
      subtype:  'sticky-note',
      category: 'annotation',
      content:  '',
      bgColor:  '',
    },
  }]);
}
function onCtxZoomIn() { closeCtxMenu(); zoomIn() }
function onCtxZoomOut() { closeCtxMenu(); zoomOut() }
function onCtxFitView() { closeCtxMenu(); fitView() }

// ── Screenshot + record ──
// Both reuse the `capture-studio:get-sources` IPC the capture studio
// page already owns; keeping one capturer entry-point avoids diverging
// permission flows or Electron source listings. Selection heuristic is
// "first window whose name matches the app" — falls back to the first
// screen source if nothing matches.

function slugifyRoutineTitle(): string {
  const t = (title.value || 'routine').toString();
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'routine';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to actually pick up the blob before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function acquireWindowStream(): Promise<MediaStream> {
  // `capture-studio:get-sources` is the IPC the capture studio already
  // exposes; reuse it rather than wiring a second capturer endpoint.
  // Matches useMediaSources's `require('electron')` pattern so behavior
  // stays consistent across pages.

  const { ipcRenderer } = require('electron');
  const sources = await ipcRenderer.invoke('capture-studio:get-sources') as {
    id: string; name: string;
  }[];
  if (!sources?.length) throw new Error('No capture sources available');

  // Prefer a Sulla window; fall back to the first screen if none match
  // so the user still gets something to look at.
  const ours = sources.find(s => /sulla|rancher|routines/i.test(s.name));
  const fallback = sources.find(s => /screen/i.test(s.name)) ?? sources[0];
  const sourceId = (ours ?? fallback).id;

  return await (navigator.mediaDevices as any).getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource:   'desktop',
        chromeMediaSourceId: sourceId,
      },
    },
  });
}

async function onCtxScreenshot() {
  closeCtxMenu();
  let stream: MediaStream | null = null;
  try {
    stream = await acquireWindowStream();

    // Pull one frame through an off-DOM <video> element. ImageCapture
    // would be cleaner but isn't universally available in Electron's
    // Chromium channel; the video element + canvas path is battle-tested.
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    // Wait one frame so the video has real dimensions to draw from.
    await new Promise<void>((resolve) => {
      if (video.videoWidth > 0) resolve();
      else video.onloadedmetadata = () => resolve();
    });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Screenshot failed to encode');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(blob, `${ slugifyRoutineTitle() }-${ ts }.png`);
  } catch (err) {
    console.warn('[AgentRoutines] Screenshot failed:', err);
    pushLine('err', `screenshot failed: ${ err instanceof Error ? err.message : String(err) }`);
  } finally {
    stream?.getTracks().forEach(t => t.stop());
  }
}

// ── Recording state ──
// Kept outside reactive objects because MediaRecorder mutates over time
// and we don't want Vue tracking its internals.
const isRecording = ref(false);
let activeRecorder: MediaRecorder | null = null;
let activeRecorderStream: MediaStream | null = null;
let activeRecorderChunks: Blob[] = [];

async function startRecording() {
  const stream = await acquireWindowStream();
  activeRecorderStream = stream;
  activeRecorderChunks = [];

  // webm/vp9 is the most reliable MediaRecorder mime across Chromium
  // versions; fall back to the default if the browser won't accept it.
  const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm'];
  const mimeType = mimeCandidates.find(m => (window as any).MediaRecorder?.isTypeSupported?.(m));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) activeRecorderChunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(activeRecorderChunks, { type: recorder.mimeType || 'video/webm' });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(blob, `${ slugifyRoutineTitle() }-${ ts }.webm`);
    activeRecorderChunks = [];
    activeRecorderStream?.getTracks().forEach(t => t.stop());
    activeRecorderStream = null;
    activeRecorder = null;
    isRecording.value = false;
  };

  // Stop automatically if the user ends the OS-level share from the
  // system UI — otherwise the recording would silently dangle.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (activeRecorder?.state === 'recording') activeRecorder.stop();
  });

  recorder.start(1000); // 1s slices so Blob assembly isn't all at once
  activeRecorder = recorder;
  isRecording.value = true;
  pushLine('dec', 'recording started');
}

function stopRecording() {
  if (!activeRecorder) return;
  if (activeRecorder.state === 'recording') activeRecorder.stop();
  pushLine('dec', 'recording stopped — saving');
}

async function onCtxRecord() {
  closeCtxMenu();
  try {
    if (isRecording.value) {
      stopRecording();
    } else {
      await startRecording();
    }
  } catch (err) {
    console.warn('[AgentRoutines] Recording toggle failed:', err);
    pushLine('err', `recording failed: ${ err instanceof Error ? err.message : String(err) }`);
    isRecording.value = false;
    activeRecorderStream?.getTracks().forEach(t => t.stop());
    activeRecorderStream = null;
    activeRecorder = null;
  }
}

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

  // ⌘Z / Ctrl+Z → undo; ⌘⇧Z / Ctrl+Shift+Z → redo. Ignored when typing
  // in an input so the browser's native text undo still works in name
  // fields, config panels, and the command prompt.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (mode.value !== 'edit') return;
    e.preventDefault();
    if (e.shiftKey) void redo();
    else void undo();

    return;
  }

  if (e.key === 'Escape') {
    if (deleteConfirm.value) cancelDelete();
    else if (promptOpen.value) promptOpen.value = false;
    else if (ctxMenu.visible) closeCtxMenu();
    else if (nodeCtx.visible) closeNodeCtx();
    else if (drawerOpen.value) drawerOpen.value = false;
    else if (selectedNodeId.value) closeConfig();
    else if (selectedEdgeId.value) selectedEdgeId.value = null;
    return;
  }

  // Enter inside the delete confirm dialog confirms. Gated by
  // deleteConfirm so we don't hijack Enter elsewhere on the canvas.
  if (e.key === 'Enter' && deleteConfirm.value) {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    confirmDelete();
    e.preventDefault();
    return;
  }

  // Delete / Backspace — prompt a confirmation, then drop every selected
  // node and/or edge. Multi-select via drag-box is included because we
  // pull from VueFlow's getSelectedNodes/getSelectedEdges in addition to
  // the single-click refs.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    // If the confirm dialog is already open, Delete / Backspace confirms
    // rather than stacking another dialog.
    if (deleteConfirm.value) {
      confirmDelete();
      e.preventDefault();
      return;
    }
    const payload = collectDeletionTarget();
    if (!payload) return;
    deleteConfirm.value = payload;
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
    const [def] = await Promise.all([
      persistence.load(props.workflowId),
      history.load(props.workflowId),
    ]);
    if (def) applyDefinition(def);
    // Wait a tick so the watch registered below sees the post-hydration
    // state as its baseline rather than firing on the initial assignments.
    await nextTick();
    // Snap the viewport to the freshly-loaded graph. fit-view-on-init
    // fired against an empty canvas, so without this the user lands on
    // whatever the default viewport was instead of their nodes.
    fitView();
  }
  hasHydrated.value = true;

  if (props.workflowId) {
    try {
      ipcRenderer.send('app-state:set-routine-context' as any, {
        mode: 'routine',
        id:   props.workflowId,
        name: title.value || 'Routine',
      });
    } catch { /* non-fatal */ }
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKeydown);
  unsubscribeFromExecutionEvents();

  try {
    ipcRenderer.send('app-state:set-routine-context' as any, null);
  } catch { /* non-fatal */ }

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

// ── Live edge styling ──
// An edge is "flowing" when its source is done AND its target is
// running — i.e. data actually traversed this specific edge during
// the current transition. Driving animation off this pair instead of
// "target is running" avoids lighting up edges from dead branches or
// never-fed predecessors: at a convergent join, only the predecessors
// that have actually completed contribute; at a divergent router,
// only the chosen branch (whose target reaches `running`) lights up.
function nodeStateOf(id: string): string | undefined {
  const n = nodes.value.find(x => x.id === id);
  const exec = n?.data?.execution?.status;
  if (exec === 'running') return 'running';
  if (exec === 'completed') return 'done';
  if (exec === 'failed') return 'failed';
  if (exec === 'waiting') return 'queued';
  return (n?.data?.state as string | undefined);
}

function recomputeEdgeFlow() {
  let touched = false;
  for (const edge of edges.value) {
    const src = nodeStateOf(edge.source);
    const tgt = nodeStateOf(edge.target);
    // Light only edges where data actually flowed this turn. `done → running`
    // is the unambiguous transition window. `running → running` covers the
    // brief overlap where source is still wrapping up as target is spun up.
    const shouldFlow = (src === 'done' && tgt === 'running') ||
      (src === 'running' && tgt === 'running');
    const wasFlowing = !!edge.animated;
    if (shouldFlow === wasFlowing) continue;
    edge.animated = shouldFlow;
    const base = 'routine-edge';
    edge.class = shouldFlow ? `${ base } flowing` : base;
    touched = true;
  }
  if (touched) edges.value = [...edges.value];
}

// Deep-watch nodes so any state transition (running/done/failed) on either
// endpoint of any edge re-evaluates the flow set. Runs cheap — O(edges),
// and only fires on actual data mutations thanks to Vue's equality check.
watch(nodes, () => recomputeEdgeFlow(), { deep: true });

// Auto-save on any mutation of the graph or its metadata. Deep watch so
// in-place changes to nodes/edges (position, config, label) are caught
// without requiring every mutation site to call a markDirty helper.
// Declared here — after nodes/edges — so TypeScript's TDZ analysis is
// happy; at runtime Vue would hoist the refs either way.
watch(
  [title, subtitle, nodes, edges],
  () => {
    if (!hasHydrated.value || !props.workflowId) return;
    // Suppress auto-save while we're re-hydrating from a history
    // snapshot — otherwise undo would record a new history row and
    // turn redo into guesswork.
    if (isRestoring.value) return;
    const payload = buildDefinitionForSave();
    if (payload) persistence.scheduleSave(payload);
  },
  { deep: true },
);

// After every real user save, refetch history so the latest row is at
// the top and the cursor is reset to 0. Undo/redo use `saveSilent` and
// don't bump `lastSavedAt`, so restores won't retrigger this.
watch(
  () => persistence.lastSavedAt.value,
  (t) => {
    if (!t || !props.workflowId || isRestoring.value) return;
    void history.load(props.workflowId);
  },
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
  /* Block text-selection by default so dragging across node titles /
     labels / HUD copy doesn't accidentally highlight a bunch of UI
     chrome. Re-enabled below for the specific spots where selection is
     actually wanted (editable title, drawer fields, output <pre>). */
  user-select: none;
  -webkit-user-select: none;
}

/* Selection re-enabled in places the user genuinely wants to copy or
   edit text: the contenteditable routine title/subtitle, any form
   control, and the config/output drawers (node names, output blocks,
   config fields). Everything else on the canvas stays click-through. */
.routines-frame [contenteditable="true"],
.routines-frame input,
.routines-frame textarea,
.routines-frame .config-panel,
.routines-frame .output-panel {
  user-select: text;
  -webkit-user-select: text;
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

/* Mirrors .stream-backdrop for the top-right HUD. Occupies the title
   block's visual footprint (kicker + title + subtitle + breathing room)
   so node cards drifting behind the HUD are occluded instead of
   bleeding through and muddying the headline text. Fades out at the
   edges so no hard rectangle shows against the starfield. */
.title-backdrop {
  position: absolute;
  top: 28px;
  right: 52px;
  z-index: 1;
  width: 36%;
  max-width: 540px;
  height: 140px;
  pointer-events: none;
  background: linear-gradient(135deg, #03060c 0%, #070d1a 60%, #01030a 100%);
  -webkit-mask-image:
    linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.78) 18%, black 40%, black 82%, rgba(0,0,0,0.45) 100%),
    linear-gradient(270deg, black 0%, black 70%, rgba(0,0,0,0.4) 100%);
  -webkit-mask-composite: source-in;
  mask-image:
    linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.78) 18%, black 40%, black 82%, rgba(0,0,0,0.45) 100%),
    linear-gradient(270deg, black 0%, black 70%, rgba(0,0,0,0.4) 100%);
  mask-composite: intersect;
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

/* Opaque panel that occupies the stream's footprint, sitting above the
   VueFlow canvas (z-index 0/auto) but below the ambient overlays
   (glow/stars at z-index 2, brackets/stream at z-index 4). Hides node
   cards behind the stream so the ticker text is legible, while the
   canvas mood layers still read through on top. Solid in the middle,
   mask-faded at top/bottom so no hard rectangle shows. */
.stream-backdrop {
  position: absolute;
  top: 28px;
  left: 52px;
  z-index: 1;
  width: 28%;
  height: 240px;
  pointer-events: none;
  background: linear-gradient(135deg, #03060c 0%, #070d1a 60%, #01030a 100%);
  -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.78) 14%, black 32%, black 86%, rgba(0,0,0,0.55) 100%);
  mask-image: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.78) 14%, black 32%, black 86%, rgba(0,0,0,0.55) 100%);
}

.stream {
  position: absolute;
  top: 28px;
  left: 52px;
  z-index: 4;
  /* Vertical scrolling only — long thinking messages wrap inside the
   * line instead of running off the right edge and summoning a
   * horizontal scrollbar. Vertical scroll is preserved so the user can
   * read older lines before they fade off the top. */
  pointer-events: auto;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.7;
  width: 28%;
  max-height: 240px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(168, 192, 220, 0.25) transparent;
  -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.8) 15%, black 35%);
  mask-image: linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.8) 15%, black 35%);
}
/* Chromium scrollbar — invisible track, soft thumb that darkens on
   hover. Keeps the stream clean at rest. */
.stream::-webkit-scrollbar {
  width: 6px;
}
.stream::-webkit-scrollbar-track {
  background: transparent;
}
.stream::-webkit-scrollbar-thumb {
  background: rgba(168, 192, 220, 0.18);
  border-radius: 3px;
  transition: background 0.15s ease;
}
.stream:hover::-webkit-scrollbar-thumb {
  background: rgba(168, 192, 220, 0.35);
}
.stream::-webkit-scrollbar-thumb:hover {
  background: rgba(196, 212, 230, 0.55);
}
.line {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 1px 0;
  /* Wrap long messages instead of extending the line beyond the stream
     width — that's what would have summoned a horizontal scrollbar. */
  min-width: 0;
}
.line .t {
  color: var(--steel-400);
  flex-shrink: 0;
  font-size: 10px;
  /* Nudge the timestamp down a touch so it aligns optically with the
     first line of a wrapping message. */
  line-height: 1.7;
}
.line .k {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  /* Node names in the badge slot (thinking lines) can be long — clamp so
     a single line name doesn't wrap or blow out the stream column. */
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.line .msg {
  color: var(--steel-200);
  font-size: 11px;
  /* Wrap long thinking strings so they flow inside the stream instead
     of forcing horizontal scroll. `min-width: 0` on the parent flex
     item lets this shrink below its intrinsic content width. */
  min-width: 0;
  flex: 1;
  word-break: break-word;
  overflow-wrap: anywhere;
}
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
/* Live-run center readout — replaces the "Sulla Original" watermark
   while a routine is running, mirroring the design's "Now Producing"
   ribbon. */
.ribbon .center .kicker {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.3em;
  color: var(--violet-300);
  text-transform: uppercase;
}
.ribbon .center .output-now {
  font-family: var(--serif);
  font-size: 16px;
  font-style: italic;
  color: white;
  margin-top: 4px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ribbon .center .output-now::before { content: '« '; color: var(--violet-300); font-style: normal; }
.ribbon .center .output-now::after  { content: ' »'; color: var(--violet-300); font-style: normal; }
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
/* Edge hover — brighten the base path a touch. The routine edge owns
   its full painting (base + pulse) in RoutineEdge.vue; we only override
   the hover state here because scoped styles in the component can't
   see :hover from the VueFlow wrapper. */
.routines-flow :deep(.vue-flow__edge:hover .routine-edge-base:not(.flowing):not(.selected)) {
  stroke: #7dd3fc;
}

/* Runs flyout — anchored above the controls row. Lists recent past
   executions for this workflow; clicking one hydrates the canvas with
   that run's final node state for inspection. */
.runs-flyout {
  position: absolute;
  left: 120px;
  bottom: 150px;
  z-index: 12;
  min-width: 280px;
  max-width: 360px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(24, 36, 62, 0.98), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(168, 192, 220, 0.25);
  border-radius: 8px;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.runs-flyout-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(105, 137, 179, 0.08);
  border-bottom: 1px solid rgba(168, 192, 220, 0.12);
}
.runs-flyout-title {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--violet-300);
}
.runs-flyout-close {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--steel-300);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  border-radius: 4px;
}
.runs-flyout-close:hover { background: rgba(168, 192, 220, 0.1); color: white; }
.runs-flyout-status {
  padding: 14px 12px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--steel-400);
  text-align: center;
}
.runs-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(168, 192, 220, 0.25) transparent;
}
.runs-list::-webkit-scrollbar { width: 6px; }
.runs-list::-webkit-scrollbar-thumb {
  background: rgba(168, 192, 220, 0.25);
  border-radius: 3px;
}
.runs-item {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: start;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--steel-200);
}
.runs-item:hover { background: rgba(139, 92, 246, 0.1); color: white; }
.runs-item.active { background: rgba(139, 92, 246, 0.18); color: white; }
.runs-item-time {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--violet-300);
  letter-spacing: 0.05em;
  padding-top: 2px;
  white-space: nowrap;
}
.runs-item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.runs-item-last {
  font-family: var(--font);
  font-size: 12px;
  font-weight: 500;
  color: white;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runs-item-meta {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--steel-400);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* Delete confirmation — centered modal over the canvas. Backdrop dims
   the canvas and captures outside-click to cancel. Enter confirms via
   the autofocused Delete button; Escape cancels via the keydown
   handler. Kept narrow so it never crowds the viewport. */
.delete-confirm-backdrop {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(3, 6, 12, 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.delete-confirm {
  min-width: 340px;
  max-width: 440px;
  padding: 18px 20px 16px;
  background: linear-gradient(180deg, rgba(24, 36, 62, 0.98), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(244, 63, 94, 0.35);
  border-radius: 10px;
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.6),
    0 0 30px rgba(244, 63, 94, 0.22);
  color: var(--steel-100);
}
.delete-confirm .dc-title {
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 600;
  color: white;
  line-height: 1.25;
  margin-bottom: 8px;
}
.delete-confirm .dc-body {
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  color: var(--steel-300);
  margin-bottom: 16px;
}
.delete-confirm .dc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.delete-confirm .dc-btn {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  padding: 6px 14px;
  border-radius: 5px;
  cursor: pointer;
  border: 1px solid transparent;
}
.delete-confirm .dc-btn.cancel {
  background: transparent;
  border-color: rgba(168, 192, 220, 0.3);
  color: var(--steel-200);
}
.delete-confirm .dc-btn.cancel:hover {
  background: rgba(168, 192, 220, 0.08);
  color: white;
}
.delete-confirm .dc-btn.danger {
  background: linear-gradient(135deg, rgba(244, 63, 94, 0.95), rgba(190, 18, 60, 0.95));
  border-color: rgba(244, 63, 94, 0.6);
  color: white;
  box-shadow: 0 0 0 1px rgba(244, 63, 94, 0.25), 0 0 16px rgba(244, 63, 94, 0.35);
}
.delete-confirm .dc-btn.danger:hover {
  box-shadow: 0 0 0 1px rgba(244, 63, 94, 0.45), 0 0 22px rgba(244, 63, 94, 0.55);
}
.delete-confirm .dc-btn.danger:focus-visible {
  outline: 2px solid rgba(244, 63, 94, 0.55);
  outline-offset: 2px;
}

/* Past-run banner — pinned at the top of the frame during history
   viewing so live and recorded runs can't be confused. */
.past-run-banner {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: linear-gradient(180deg, rgba(24, 36, 62, 0.95), rgba(14, 22, 40, 0.95));
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 999px;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45), 0 0 22px rgba(139, 92, 246, 0.2);
  font-family: var(--font);
  font-size: 12px;
  color: var(--steel-100);
}
.past-run-banner .banner-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--violet-400);
  box-shadow: 0 0 8px rgba(139, 92, 246, 0.7);
}
.past-run-banner .banner-text b { color: white; font-weight: 700; }
.past-run-banner .banner-exit {
  background: transparent;
  border: 1px solid rgba(167, 139, 250, 0.5);
  color: var(--violet-200);
  padding: 3px 10px;
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
}
.past-run-banner .banner-exit:hover {
  background: rgba(139, 92, 246, 0.2);
  color: white;
  border-color: var(--violet-300);
}

/* Drag-to-select marquee (V6 — brackets + soft fill).
   A whisper of steel-blue fill so overlapped cards still feel contained,
   plus four bracket corners that echo the canvas frame chrome. Painted
   entirely via background-image layers so there's no extra DOM. */
.routines-flow :deep(.vue-flow__selection) {
  background: rgba(80, 150, 179, 0.08);
  border: none;
  border-radius: 0;
  --bk: rgba(106, 176, 204, 0.95);
  --bk-size: 16px;
  --bk-thick: 1.5px;
  background-image:
    linear-gradient(rgba(80, 150, 179, 0.08), rgba(80, 150, 179, 0.08)),
    linear-gradient(var(--bk), var(--bk)), linear-gradient(var(--bk), var(--bk)),
    linear-gradient(var(--bk), var(--bk)), linear-gradient(var(--bk), var(--bk)),
    linear-gradient(var(--bk), var(--bk)), linear-gradient(var(--bk), var(--bk)),
    linear-gradient(var(--bk), var(--bk)), linear-gradient(var(--bk), var(--bk));
  background-size:
    100% 100%,
    var(--bk-size) var(--bk-thick), var(--bk-thick) var(--bk-size),
    var(--bk-size) var(--bk-thick), var(--bk-thick) var(--bk-size),
    var(--bk-size) var(--bk-thick), var(--bk-thick) var(--bk-size),
    var(--bk-size) var(--bk-thick), var(--bk-thick) var(--bk-size);
  background-repeat: no-repeat;
  background-position:
    center,
    top    left,  top    left,
    top    right, top    right,
    bottom left,  bottom left,
    bottom right, bottom right;
}

/* Post-select summary rect (around already-selected nodes after the drag
   ends). Quieter than the live marquee so the two don't compete. */
.routines-flow :deep(.vue-flow__nodesselection-rect) {
  background: rgba(80, 150, 179, 0.05);
  border: 1px dashed rgba(106, 176, 204, 0.55);
  border-radius: 4px;
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

/* Draft / Production toggle. Sits in the edit-mode toolbar beside the
   mode switch so publishing is a single click away without leaving the
   canvas. Dot flips green when production; grey while draft. */
.routines-flow :deep(.vue-flow__controls-button.status-toggle) {
  width: auto;
  padding: 0 8px;
  gap: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.routines-flow :deep(.vue-flow__controls-button.status-toggle .status-dot) {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: rgba(168, 192, 220, 0.45);
  box-shadow: 0 0 0 2px rgba(168, 192, 220, 0.08);
}
.routines-flow :deep(.vue-flow__controls-button.status-toggle.is-production .status-dot) {
  background: var(--green, #34d399);
  box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.18);
}
.routines-flow :deep(.vue-flow__controls-button.status-toggle.is-production) {
  color: var(--green, #34d399);
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.08);
}
.routines-flow :deep(.vue-flow__controls-button.status-toggle.is-production:hover) {
  background: rgba(52, 211, 153, 0.18);
}
.routines-flow :deep(.vue-flow__controls-button.status-toggle.disabled) {
  opacity: 0.5;
  cursor: wait;
}

/* Undo / redo — custom ControlButton children render after the built-in
   zoom/fit/interactive buttons by default. Flip their flex order so they
   read first in the toolbar, which matches the "back/forward before
   anything else" muscle memory users have from every other editor.
   Separator after redo keeps the history pair visually distinct from
   zoom/fit. */
.routines-flow :deep(.vue-flow__controls-button.history-btn) {
  order: -10;
}
.routines-flow :deep(.vue-flow__controls-button.history-undo) {
  order: -11;
}
/* Runs button sits just before the mode toggle in run mode. Active
   class flips it violet to echo the open flyout. */
.routines-flow :deep(.vue-flow__controls-button.runs-btn) {
  order: -9;
  margin-right: 6px;
  border-right: 1px solid rgba(168, 192, 220, 0.18);
  padding-right: 0;
}
.routines-flow :deep(.vue-flow__controls-button.runs-btn.active) {
  color: var(--violet-300);
  background: rgba(139, 92, 246, 0.15);
}
.routines-flow :deep(.vue-flow__controls-button.history-redo) {
  order: -10;
  margin-right: 6px;
  border-right: 1px solid rgba(168, 192, 220, 0.18);
  padding-right: 0;
}
.routines-flow :deep(.vue-flow__controls-button.history-btn.disabled),
.routines-flow :deep(.vue-flow__controls-button.history-btn:disabled) {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
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
  /* Stop mode — pulsing rose/red to make "this is interruptible" read
     at a glance. No opacity dim (it's a clickable affordance, not a
     disabled state) and no progress cursor. */
  cursor: pointer;
  background: linear-gradient(135deg, rgba(244, 63, 94, 0.95), rgba(190, 18, 60, 0.95));
  animation: run-fab-stop-pulse 1.3s ease-in-out infinite;
}
.routines-fab.run-fab.busy:hover {
  box-shadow:
    0 12px 32px rgba(244, 63, 94, 0.55),
    0 0 24px rgba(244, 63, 94, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}
.routines-fab.run-fab.busy svg {
  margin-left: 0; /* square icon needs no optical nudge */
}
@keyframes run-fab-stop-pulse {
  0%, 100% { box-shadow: 0 10px 28px rgba(244, 63, 94, 0.4), 0 0 18px rgba(244, 63, 94, 0.35); }
  50%      { box-shadow: 0 10px 28px rgba(244, 63, 94, 0.6),  0 0 32px rgba(244, 63, 94, 0.7); }
}
/* Stalled — the event stream has been quiet for a while but the backend
   might still be working (long agent thinking, remote call, etc). Slow
   the pulse and desaturate so the button reads "still live but quiet"
   without losing its clickability. */
.routines-fab.run-fab.busy.stalled {
  background: linear-gradient(135deg, rgba(180, 90, 110, 0.85), rgba(130, 35, 55, 0.85));
  animation-duration: 2.6s;
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
/* The parent .title-block is pointer-events:none so its empty padding
   doesn't swallow canvas clicks. Re-enable pointer-events on the two
   editable children so the user can actually click to focus them. */
.title-main.editable,
.title-sub.editable {
  cursor: text;
  pointer-events: auto;
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
