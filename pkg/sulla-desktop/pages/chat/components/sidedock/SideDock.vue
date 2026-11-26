<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  The right drawer: outlined tabs (Sulla, Decide, AI Team, Files, and
  Artifacts when the chat has any). It holds no chat input: the message box
  stays at the bottom of the chat. Files and Artifacts come in as slots so
  they keep their own handlers.
-->
<template>
  <aside
    ref="rootEl"
    class="sdk"
    :class="{ 'sdk-resizing': dragging }"
    aria-label="Side panel for this chat"
  >
    <!-- Drag the edge to resize; arrow keys nudge it; double-click resets it. -->
    <div
      class="sdk-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side column"
      :aria-valuenow="Math.round(sideRatio * 100)"
      aria-valuemin="18"
      aria-valuemax="70"
      tabindex="0"
      title="Drag to resize · double-click to reset"
      @pointerdown="startDrag"
      @dblclick="setSideRatio(SIDE_RATIO_DEFAULT)"
      @keydown.left.prevent="nudge(0.02)"
      @keydown.right.prevent="nudge(-0.02)"
    />
    <div class="sdk-tabs">
      <div
        class="sdk-tab-scroll"
        role="tablist"
        aria-label="Chat side panel"
      >
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="sdk-tab"
          :class="{ 'sdk-attention': tab.id === 'decisions' && openCount > 0 }"
          :aria-selected="current === tab.id"
          @click="pick(tab.id)"
        >
          {{ tab.label }}<span
            v-if="tab.badge"
            class="sdk-badge"
            :class="`sdk-badge-${tab.badge.tone}`"
          >{{ tab.badge.text }}</span><span
            v-else-if="tab.pulse"
            class="sdk-pulse"
            aria-label="working"
          />
        </button>
      </div>
      <button
        type="button"
        class="sdk-move"
        title="Close the side panel"
        aria-label="Close the side panel"
        @click="setPosition('bottom')"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
    <div
      class="sdk-panel"
      role="tabpanel"
    >
      <AgentLanes
        v-if="current === 'sulla' && !showHistory"
        :outcomes="outcomes.groups.value"
        :outcomes-loading="outcomes.loading.value"
        :outcomes-error="outcomes.error.value"
        :outcome-target="outcomeTarget"
        @show-for-you="selectTab('decisions')"
        @show-history="showHistory = true"
        @retry-outcomes="outcomes.refresh()"
      />
      <div
        v-else-if="current === 'sulla'"
        class="sdk-history"
      >
        <div class="sdk-history-head">
          <button
            type="button"
            @click="showHistory = false"
          >
            ← Current work
          </button>
        </div>
        <WorkflowPanel
          view="activity"
          :outcome-keys="outcomes.reportKeys.value"
          :lead-at="leadAt"
          @show-outcome="showOutcome"
        />
      </div>
      <ResultsPanel v-else-if="current === 'results'" @show-activity="selectTab('sulla')" />
      <ForYouPanel v-else-if="current === 'decisions'" />
      <WorkflowPanel
        v-else-if="current === 'workflow'"
        view="team"
        :outcome-keys="outcomes.reportKeys.value"
        :lead-at="leadAt"
        @show-outcome="showOutcome"
      />
      <div
        v-else-if="current === 'files'"
        class="sdk-embed"
      >
        <slot name="files" />
      </div>
      <div
        v-else-if="current === 'artifacts'"
        class="sdk-embed"
      >
        <slot name="artifacts" />
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, type Ref } from 'vue';

import AgentLanes from './AgentLanes.vue';
import ResultsPanel from './ResultsPanel.vue';
import ForYouPanel from './ForYouPanel.vue';
import WorkflowPanel from './WorkflowPanel.vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatOutcomes } from '../../composables/useChatOutcomes';
import { DockPositions, SIDE_RATIO_DEFAULT } from '../../composables/useDockPosition';
import { useChatController } from '../../controller/useChatController';
import { LineTimes } from '../../messages/lineTime';
import { hasActiveChatWork } from '../../messages/threadActivity';

import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';

type TabId = 'results' | 'sulla' | 'decisions' | 'workflow' | 'files' | 'artifacts';

const controller = useChatController();
const { setPosition, sideRatio, setSideRatio } = DockPositions.use();
const rootEl = ref<HTMLElement | null>(null);
const dragging = ref(false);

/** The share of the chat area the column takes, from where the pointer is. */
function ratioAt(clientX: number): number {
  const area = rootEl.value?.offsetParent?.getBoundingClientRect();
  if (!area?.width) return sideRatio.value;
  return (area.right - clientX) / area.width;
}
function startDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture?.(event.pointerId);
  dragging.value = true;
  const move = (e: PointerEvent) => setSideRatio(ratioAt(e.clientX), false);
  const end = (e: PointerEvent) => {
    if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    dragging.value = false;
    setSideRatio(sideRatio.value);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
function nudge(delta: number): void { setSideRatio(sideRatio.value + delta) }
const decisionStore = ChatDecisions.useChatDecisions();
const { openCount } = decisionStore;
const client = inject(AGENT_STATE_CLIENT_KEY, null);
const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });

const current = ref<TabId>('sulla');
const showHistory = ref(false);
const outcomes = useChatOutcomes(context.backendThreadId);
const outcomeTarget = ref<string>();
watch(context.backendThreadId, () => {
  outcomeTarget.value = undefined;
  showHistory.value = false;
});
function showOutcome(key: string): void {
  outcomeTarget.value = key;
  showHistory.value = false;
  current.value = 'sulla';
}

const working = computed(() => {
  const tree = new AgentTreeBuilder(client?.snapshot.value.rows ?? []);
  const agents = context.backendThreadId.value ? tree.flatten(tree.forThread(context.backendThreadId.value)) : [];
  return hasActiveChatWork(controller.isRunning.value, agents.map(node => node.row));
});
const leadAt = computed(() => {
  const response = controller.messages.value.findLast(message => message.kind === 'sulla');
  return response ? LineTimes.idTime(response.id) ?? response.createdAt : undefined;
});
const artifactCount = computed(() => controller.artifacts.value.list.length);

const tabs = computed(() => [
  { id: 'sulla' as const, label: 'Sulla', pulse: working.value },
  { id: 'results' as const, label: 'Results' },
  { id: 'decisions' as const, label: 'Decide', badge: openCount.value ? { text: String(openCount.value), tone: 'you' } : undefined },
  { id: 'workflow' as const, label: 'AI Team' },
  { id: 'files' as const, label: 'Files' },
  ...(artifactCount.value ? [{ id: 'artifacts' as const, label: 'Artifacts', badge: { text: String(artifactCount.value), tone: 'n' } }] : []),
] as { id: TabId; label: string; badge?: { text: string; tone: string }; pulse?: boolean }[]);

watch(artifactCount, count => {
  if (!count && current.value === 'artifacts') current.value = 'sulla';
});

function selectTab(tab: TabId): void {
  outcomeTarget.value = undefined;
  showHistory.value = false;
  current.value = tab;
}
function pick(tab: TabId): void { selectTab(tab) }
defineExpose({ selectTab });
</script>

<style scoped>
/* Component-prefixed classes: themes restyle generic names. */
.sdk {
  --sdk-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  --sdk-ink-3: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface));
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 7; width: var(--side-dock-w, 440px);
  display: flex; flex-direction: column; min-height: 0;
  border-left: 1px solid var(--border-default); background: var(--bg-surface); color: var(--text-primary); font-family: var(--font-body);
}
/* The edge: a wide invisible grip over the 1px border, lit while hovered or dragged. */
.sdk-resize { position: absolute; top: 0; bottom: 0; left: -4px; z-index: 2; width: 8px; cursor: col-resize; touch-action: none; }
.sdk-resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; transition: background-color .15s cubic-bezier(.22, 1, .36, 1); }
.sdk-resize:hover::after, .sdk-resize:focus-visible::after, .sdk-resizing .sdk-resize::after { background: var(--accent); }
.sdk-resize:focus-visible { outline: none; }
/* While dragging, text in the transcript and panels must not get selected. */
.sdk-resizing, .sdk-resizing * { user-select: none; }
.sdk-tabs {
  container-type: inline-size;
  display: flex; flex: none; align-items: center; gap: 6px;
  height: var(--chat-header-height, 52px); padding: 0 8px;
  border-bottom: 1px solid var(--border-default); background: var(--bg-chrome-active);
}
.sdk-tab-scroll { min-width: 0; flex: 1; display: flex; gap: 3px; overflow-x: auto; scrollbar-width: none; }
.sdk-tab {
  position: relative; display: inline-flex; flex: none; align-items: center; gap: 4px; height: 32px; padding: 0 8px;
  border: 1px solid var(--border-default); border-radius: 7px;
  background: color-mix(in srgb, var(--bg-surface) 50%, var(--bg-page)); color: var(--sdk-ink-2);
  font: 600 12.5px/1 var(--font-body); white-space: nowrap; cursor: pointer;
  transition: background-color .15s cubic-bezier(.22, 1, .36, 1), color .15s cubic-bezier(.22, 1, .36, 1);
}
.sdk-tab:hover { background: var(--bg-surface); color: var(--text-primary); }
.sdk-tab[aria-selected="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, var(--bg-surface)); color: var(--text-primary); }
.sdk-tab[aria-selected="true"]::after { content: ""; position: absolute; bottom: 2px; left: 8px; right: 8px; height: 2px; border-radius: 2px; background: var(--accent); }
.sdk-tab.sdk-attention { color: var(--status-warning); border-color: color-mix(in srgb, var(--status-warning) 65%, var(--border-strong)); background: color-mix(in srgb, var(--status-warning) 9%, var(--bg-page)); }
.sdk-tab.sdk-attention::after { background: var(--status-warning); }
.sdk-tab.sdk-attention[aria-selected="true"] { background: color-mix(in srgb, var(--status-warning) 16%, var(--bg-surface)); color: var(--text-primary); }
.sdk-tab:focus-visible, .sdk-move:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
@container (max-width: 335px) {
  .sdk-tab-scroll { gap: 2px; }
  .sdk-tab { padding-inline: 4px; font-size: 12px; }
}
.sdk-badge { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; font: 700 10.5px/1 var(--font-body); }
.sdk-badge-you { background: var(--status-warning); color: var(--bg-page); }
.sdk-badge-bad { background: color-mix(in srgb, var(--status-error) 22%, transparent); color: var(--status-error); }
.sdk-badge-n { background: color-mix(in srgb, var(--text-primary) 12%, transparent); color: var(--sdk-ink-2); }
.sdk-pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: sdk-pulse 1.6s cubic-bezier(.22, 1, .36, 1) infinite; }
@keyframes sdk-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.sdk-move {
  flex:none;
  display: grid; place-items: center; width: 32px; height: 32px;
  border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-page); color: var(--sdk-ink-2); cursor: pointer;
}
.sdk-move:hover { color: var(--text-primary); border-color: var(--accent); }
.sdk-move svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; }
.sdk-panel { flex: 1; min-height: 0; overflow: auto; }
.sdk-embed { position: relative; height: 100%; }
.sdk-embed :deep(.chat-files-drawer) {
  position: relative; inset: auto; z-index: auto; width: 100%; height: 100%;
  border: 0; background: transparent; backdrop-filter: none;
}
.sdk-embed :deep(.sd-artifact-panel) {
  width: calc(100% - 20px); height: calc(100% - 20px); margin: 10px;
  border-radius: 10px; background: var(--bg-page); backdrop-filter: none;
  box-shadow: inset 0 0 0 1px var(--border-default);
}
.sdk-history-head { padding: 10px 14px 0; }
.sdk-history-head button {
  padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer;
  font: 600 12px/1.4 var(--font-body);
}
.sdk-history-head button:hover { text-decoration: underline; text-underline-offset: 2px; }
.sdk-history-head button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { .sdk-pulse { animation: none; } }
</style>
