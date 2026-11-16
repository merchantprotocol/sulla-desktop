<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  The right-hand column when the dock is moved to the side: outlined tabs
  (Sulla, Results, Decisions, Files, and Artifacts when the chat has any) with
  the message box pinned at the bottom under every tab. The chat page
  teleports its one Composer into `boxEl`, so the draft, attachments and queue
  survive moving between bottom and side. Files and Artifacts come in as slots
  so they keep their own handlers.
-->
<template>
  <aside
    ref="rootEl"
    class="sdk"
    :class="{ 'sdk-resizing': dragging }"
    aria-label="Sulla, results, decisions and files for this chat"
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
    <div
      class="sdk-tabs"
      role="tablist"
    >
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="sdk-tab"
        :aria-selected="current === tab.id"
        @click="pick(tab.id, $event)"
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
      <span class="sdk-sp" />
      <button
        type="button"
        class="sdk-move"
        title="Move to the bottom"
        aria-label="Move the message box and activity to the bottom"
        @click="setPosition('bottom')"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><rect
          x="3"
          y="4"
          width="18"
          height="16"
          rx="2"
        /><path d="M3 15h18" /></svg>
      </button>
    </div>
    <div
      class="sdk-panel"
      role="tabpanel"
    >
      <AgentLanes v-if="current === 'sulla'" />
      <ResultsPanel v-else-if="current === 'results'" />
      <DecisionsPanel
        v-else-if="current === 'decisions'"
        :decisions="decisions"
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
    <div
      ref="boxEl"
      class="sdk-box"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, type Ref } from 'vue';

import AgentLanes from './AgentLanes.vue';
import DecisionsPanel from './DecisionsPanel.vue';
import ResultsPanel from './ResultsPanel.vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { DockPositions, SIDE_RATIO_DEFAULT } from '../../composables/useDockPosition';
import { useChatController } from '../../controller/useChatController';
import { groupResults } from '../../messages/sideDock';

import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';

type TabId = 'sulla' | 'results' | 'decisions' | 'files' | 'artifacts';

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
const { decisions, openCount } = ChatDecisions.useChatDecisions();
const client = inject(AGENT_STATE_CLIENT_KEY, null);
const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });

const current = ref<TabId>('sulla');
const boxEl = ref<HTMLElement | null>(null);

const needsYou = computed(() => controller.messages.value.filter(msg =>
  (msg.kind === 'tool_question' && msg.status === 'pending') || (msg.kind === 'tool_approval' && msg.decision === 'pending')).length);
const working = computed(() => {
  if (!client || !context.backendThreadId.value) return false;
  const nodes = new AgentTreeBuilder([]).flatten(new AgentTreeBuilder(client.snapshot.value.rows).forThread(context.backendThreadId.value));
  return controller.isRunning.value || nodes.some(node => ['queued', 'working'].includes(node.row.state));
});
const needsAction = computed(() => groupResults(controller.messages.value).needsAction.length);
const artifactCount = computed(() => controller.artifacts.value.list.length);

const tabs = computed(() => [
  { id: 'sulla' as const, label: 'Sulla', badge: needsYou.value ? { text: String(needsYou.value), tone: 'you' } : undefined, pulse: working.value },
  { id: 'results' as const, label: 'Results', badge: needsAction.value ? { text: String(needsAction.value), tone: 'bad' } : undefined },
  { id: 'decisions' as const, label: 'Decisions', badge: openCount.value ? { text: String(openCount.value), tone: 'you' } : undefined },
  { id: 'files' as const, label: 'Files' },
  ...(artifactCount.value ? [{ id: 'artifacts' as const, label: 'Artifacts', badge: { text: String(artifactCount.value), tone: 'n' } }] : []),
] as { id: TabId; label: string; badge?: { text: string; tone: string }; pulse?: boolean }[]);

watch(artifactCount, count => { if (!count && current.value === 'artifacts') current.value = 'sulla'; });

function selectTab(tab: TabId): void { current.value = tab }
/** A clicked tab hands the cursor back to the message box; keyboard users stay on the tabs. */
function pick(tab: TabId, event: MouseEvent): void {
  current.value = tab;
  if (event.detail > 0) boxEl.value?.querySelector('textarea')?.focus();
}
defineExpose({ boxEl, selectTab });
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
.sdk-tabs { display: flex; flex: none; gap: 3px; padding: 10px 8px 0; border-bottom: 1px solid var(--border-strong); background: var(--bg-page); }
.sdk-tab {
  position: relative; display: inline-flex; flex: none; align-items: center; gap: 4px; height: 34px; padding: 0 8px;
  border: 1px solid var(--border-strong); border-bottom: 0; border-radius: 9px 9px 0 0;
  background: color-mix(in srgb, var(--bg-surface) 50%, var(--bg-page)); color: var(--sdk-ink-2);
  font: inherit; font-size: 12.5px; white-space: nowrap; cursor: pointer;
  transition: background-color .15s cubic-bezier(.22, 1, .36, 1), color .15s cubic-bezier(.22, 1, .36, 1);
}
.sdk-tab:hover { background: var(--bg-surface); color: var(--text-primary); }
.sdk-tab[aria-selected="true"] { height: 35px; margin-bottom: -1px; background: var(--bg-surface); color: var(--text-primary); font-weight: 650; }
.sdk-tab[aria-selected="true"]::after { content: ""; position: absolute; top: -1px; left: 8px; right: 8px; height: 2px; border-radius: 0 0 2px 2px; background: var(--accent); }
.sdk-tab:focus-visible, .sdk-move:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
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
.sdk-sp { flex: 1 1 0; min-width: 4px; }
.sdk-move {
  align-self: center; display: grid; place-items: center; width: 28px; height: 28px; margin-bottom: 6px;
  border: 1px solid var(--border-strong); border-radius: 8px; background: none; color: var(--sdk-ink-2); cursor: pointer;
}
.sdk-move:hover { color: var(--text-primary); border-color: var(--accent); }
.sdk-move svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; }
.sdk-panel { flex: 1; min-height: 0; overflow: auto; }
.sdk-embed { height: 100%; }
.sdk-box { flex: none; border-top: 1px solid var(--border-strong); }
@media (prefers-reduced-motion: reduce) { .sdk-pulse { animation: none; } }
</style>
