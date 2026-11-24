<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <aside
    v-if="root"
    ref="host"
    class="worker-chart"
    :class="{ 'worker-chart--narrow': isNarrow, 'worker-chart--hidden': pageHidden }"
    aria-label="Worker chart"
  >
    <button
      v-if="isNarrow"
      ref="railTrigger"
      class="worker-chart__rail-trigger"
      type="button"
      aria-label="Open worker chart"
      :aria-expanded="chartOverlayOpen"
      @click="toggleChartOverlay"
    >
      <span class="worker-chart__rail-dots" aria-hidden="true">
        <i
          v-for="row in chart.rows"
          :key="row.key"
          class="worker-chart__rail-dot"
          :class="[
            row.kind === 'agent' ? 'worker-chart__rail-dot--agent' : 'worker-chart__rail-dot--group',
            { 'worker-chart__rail-dot--tick': row.kind === 'agent' && tickedAgentId === row.agent.id },
          ]"
          :data-state="row.kind === 'agent' ? row.agent.state : undefined"
          :style="{ top: `${row.y}px`, left: `${row.x}px` }"
        />
      </span>
    </button>

    <Teleport :disabled="!isNarrow || !chartOverlayOpen" to="body">
      <section
        v-if="!isNarrow || chartOverlayOpen"
        ref="chartSurface"
        class="worker-chart__surface"
        :class="{
          'worker-chart__surface--overlay': isNarrow,
          'worker-chart__surface--hidden': pageHidden,
        }"
        :style="isNarrow ? overlayStyle : undefined"
        :role="isNarrow ? 'dialog' : undefined"
        :aria-modal="isNarrow ? 'false' : undefined"
        :aria-label="isNarrow ? 'Worker chart' : undefined"
        :tabindex="isNarrow ? -1 : undefined"
        @click.self="isNarrow && closeChartOverlay(true)"
      >
        <div
          ref="tree"
          class="worker-chart__tree"
          :class="{ 'worker-chart__tree--overlay': isNarrow }"
          :style="treeStyle"
          @scroll="repositionPopover"
        >
          <TransitionGroup
            name="worker-chart-row"
            tag="ul"
            class="worker-chart__rows"
            role="list"
            aria-label="Agents"
            @before-enter="beforeRowEnter"
            @before-leave="beforeRowLeave"
          >
            <li
              v-for="row in chart.rows"
              :key="row.key"
              :ref="element => setRowElement(row.key, element)"
              class="worker-chart__row"
              :class="row.kind === 'group' ? 'worker-chart__row--group' : 'worker-chart__row--agent'"
              :data-row-key="row.key"
              :data-parent-id="row.parentId ?? ''"
              :style="rowStyle(row)"
            >
              <button
                v-if="row.kind === 'group'"
                class="worker-chart__node worker-chart__node--group"
                type="button"
                :aria-label="groupLabel(row)"
                :aria-expanded="row.expanded"
                @click.stop="toggleGroup(row.parentId)"
              >
                <span class="worker-chart__group-count">{{ row.hiddenCount ? `+${row.hiddenCount}` : 'less' }}</span>
              </button>
              <button
                v-else
                :ref="element => setNodeButton(row.agent.id, element)"
                class="worker-chart__node"
                type="button"
                :data-agent-id="row.agent.id"
                :data-state="row.agent.state"
                :aria-label="agentLabel(row.agent)"
                :aria-describedby="hoveredAgentId === row.agent.id ? popoverId : undefined"
                :aria-controls="selectedAgentId === row.agent.id ? popoverId : undefined"
                :aria-expanded="selectedAgentId === row.agent.id"
                aria-haspopup="dialog"
                @mouseenter="showTooltip(row.agent.id)"
                @mouseleave="scheduleTooltipClose"
                @focus="onNodeFocus(row.agent.id)"
                @blur="onNodeBlur"
                @click.stop="toggleAgentPopover(row.agent.id)"
              >
                <span
                  class="worker-chart__dot"
                  :class="{ 'worker-chart__dot--tick': tickedAgentId === row.agent.id }"
                  :data-state="row.agent.state"
                  aria-hidden="true"
                >
                  <span>{{ stateMark(row.agent) }}</span>
                </span>
                <span class="worker-chart__name">{{ row.agent.name }}</span>
              </button>
            </li>
          </TransitionGroup>
        </div>
      </section>
    </Teleport>

    <Teleport to="body">
      <section
        v-if="activePopoverAgent"
        :id="popoverId"
        ref="popover"
        class="worker-chart__popover"
        :class="{ 'worker-chart__popover--ready': popoverReady, 'worker-chart__popover--hidden': pageHidden }"
        :style="popoverStyle"
        :role="selectedAgentId ? 'dialog' : 'tooltip'"
        :aria-label="selectedAgentId ? `${activePopoverAgent.name} details` : undefined"
        :tabindex="selectedAgentId ? -1 : undefined"
        @mouseenter="cancelTooltipClose"
        @mouseleave="scheduleTooltipClose"
        @pointerdown.stop
      >
        <header class="worker-chart__popover-head">
          <span class="worker-chart__dot worker-chart__dot--popover" :data-state="activePopoverAgent.state" aria-hidden="true">
            <span>{{ stateMark(activePopoverAgent) }}</span>
          </span>
          <div class="worker-chart__popover-title">
            <strong>{{ activePopoverAgent.name }}</strong>
            <span>{{ activePopoverAgent.lane || 'Main agent' }}</span>
          </div>
          <span class="worker-chart__state-label" :data-state="activePopoverAgent.state">{{ stateLabel(activePopoverAgent.state) }}</span>
        </header>

        <dl v-if="selectedAgentId" class="worker-chart__details">
          <dt>Model</dt>
          <dd>{{ activePopoverAgent.model || 'Not reported' }}</dd>
          <dt>Task</dt>
          <dd class="worker-chart__task">{{ activePopoverAgent.task || 'Not reported' }}</dd>
          <dt>Elapsed</dt>
          <dd>{{ elapsed(activePopoverAgent) }}</dd>
          <dt>Last check-in</dt>
          <dd>{{ lastCheckInTime(activePopoverAgent) }}</dd>
          <dd v-if="activePopoverAgent.lastCheckIn" class="worker-chart__check-in">
            {{ activePopoverAgent.lastCheckIn.text }}
          </dd>
        </dl>

        <div v-if="selectedAgentId" class="worker-chart__activity">
          <span>Activity · last 150 seconds</span>
          <svg
            v-if="activitySamples.length"
            viewBox="0 0 208 30"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`Activity over the last 150 seconds, ${activitySamples.length} samples`"
          >
            <polyline v-if="activitySamples.length > 1" :points="sparklinePoints" />
            <circle v-else :cx="sparklinePointX(activitySamples[0])" :cy="sparklinePointY(activitySamples[0])" r="2" />
          </svg>
          <span v-else class="worker-chart__no-activity">No recent activity reported</span>
        </div>

        <button
          v-if="selectedAgentId"
          class="worker-chart__open"
          type="button"
          @click.stop="openAgent(activePopoverAgent.id)"
        >
          Open {{ activePopoverAgent.name }}
          <span v-if="activePopoverAgent.lane">· {{ activePopoverAgent.lane }}</span>
        </button>
      </section>
    </Teleport>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';

import {
  WorkerChartActivityWindow,
  WorkerChartLayout,
} from './workerChartModel';
import type {
  WorkerChartAgent,
  WorkerChartAgentRow,
  WorkerChartGroupRow,
  WorkerChartRow,
} from './workerChartModel';

const props = defineProps<{
  /** Current chat's real agent tree, mapped by the caller from its live presenter. */
  root: WorkerChartAgent | null;
  /** Measured width of the chat column; below 900 px the chart becomes an out-of-flow overlay rail. */
  chatColumnWidth: number;
  /** Status-line snippet event; sequence changes retrigger the dot's one-shot tick. */
  snippetTick?: { agentId: string; sequence: number } | null;
}>();

const emit = defineEmits<{
  'open-agent': [payload: { agentId: string }];
}>();

const layout = new WorkerChartLayout();
const activityWindow = new WorkerChartActivityWindow();
const host = ref<HTMLElement | null>(null);
const railTrigger = ref<HTMLButtonElement | null>(null);
const chartSurface = ref<HTMLElement | null>(null);
const tree = ref<HTMLElement | null>(null);
const popover = ref<HTMLElement | null>(null);
const nodeButtons = new Map<string, HTMLButtonElement>();
const rowElements = new Map<string, HTMLElement>();
const expandedParentIds = ref<Set<string>>(new Set());
const collapsedDoneIds = ref<Set<string>>(new Set());
const selectedAgentId = ref<string | null>(null);
const hoveredAgentId = ref<string | null>(null);
const chartOverlayOpen = ref(false);
const now = ref(Date.now());
const pageHidden = ref(false);
const popoverReady = ref(false);
const tickedAgentId = ref<string | null>(null);
const overlayStyle = ref<Record<string, string>>({ right: '0px' });
const popoverStyle = ref<Record<string, string>>({ left: '-10000px', top: '0px' });
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
const instanceId = `worker-chart-${useId()}`;
const popoverId = `${instanceId}-popover`;
const isNarrow = computed(() => props.chatColumnWidth < 900);
const chart = computed(() => layout.layout(
  props.root,
  expandedParentIds.value,
  isNarrow.value && !chartOverlayOpen.value,
  collapsedDoneIds.value,
));
const treeStyle = computed(() => ({
  height: isNarrow.value && chartOverlayOpen.value ? '100%' : `${chart.value.contentHeight}px`,
}));
const activePopoverAgent = computed(() => layout.findAgent(props.root, selectedAgentId.value ?? hoveredAgentId.value));
const doneIds = computed(() => layout.doneChildIds(props.root));
const activitySamples = computed(() => activityWindow.recentSamples(activePopoverAgent.value?.activity, now.value));
const sparklinePoints = computed(() => activitySamples.value.map(sample =>
  `${sparklinePointX(sample)},${sparklinePointY(sample)}`,
).join(' '));
let nowTimer: ReturnType<typeof setInterval> | null = null;
let tooltipCloseTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let suppressTooltipOnFocus = false;

watch(doneIds, ids => {
  const currentIds = new Set(ids);
  for (const [id, timer] of doneTimers) {
    if (!currentIds.has(id)) {
      clearTimeout(timer);
      doneTimers.delete(id);
      collapsedDoneIds.value = new Set([...collapsedDoneIds.value].filter(doneId => doneId !== id));
    }
  }
  for (const id of ids) {
    if (collapsedDoneIds.value.has(id) || doneTimers.has(id)) continue;
    doneTimers.set(id, setTimeout(() => {
      doneTimers.delete(id);
      collapsedDoneIds.value = new Set([...collapsedDoneIds.value, id]);
    }, 620));
  }
}, { immediate: true });

watch(chart, () => {
  if (selectedAgentId.value && !chart.value.rows.some(row => row.kind === 'agent' && row.agent.id === selectedAgentId.value)) {
    dismissPopover(true, true);
  } else if (hoveredAgentId.value && !chart.value.rows.some(row => row.kind === 'agent' && row.agent.id === hoveredAgentId.value)) {
    dismissPopover(false);
  }
  void nextTick(repositionPopover);
});

watch(isNarrow, () => {
  chartOverlayOpen.value = false;
  if (selectedAgentId.value || hoveredAgentId.value) dismissPopover(true, true);
});

watch(() => props.chatColumnWidth, () => {
  void nextTick(() => {
    if (chartOverlayOpen.value) positionChartOverlay();
    repositionPopover();
  });
});

watch([selectedAgentId, hoveredAgentId], () => {
  popoverReady.value = false;
  const id = selectedAgentId.value ?? hoveredAgentId.value;
  if (id) void positionPopover(id);
});

watch(() => props.snippetTick?.sequence, sequence => {
  const agentId = props.snippetTick?.agentId;
  if (sequence == null || !agentId) return;
  tickedAgentId.value = null;
  if (tickTimer) clearTimeout(tickTimer);
  void nextTick(() => {
    tickedAgentId.value = agentId;
    tickTimer = setTimeout(() => {
      tickedAgentId.value = null;
      tickTimer = null;
    }, 520);
  });
}, { immediate: true });

onMounted(() => {
  pageHidden.value = document.hidden;
  nowTimer = setInterval(() => {
    if (!document.hidden) now.value = Date.now();
  }, 1_000);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer);
  if (tooltipCloseTimer) clearTimeout(tooltipCloseTimer);
  if (tickTimer) clearTimeout(tickTimer);
  for (const timer of doneTimers.values()) clearTimeout(timer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeyDown, true);
  window.removeEventListener('resize', onWindowResize);
});

function rowStyle(row: WorkerChartRow): Record<string, string> {
  return { top: `${row.y}px`, left: `${row.x}px` };
}

function setNodeButton(id: string, element: unknown): void {
  if (element instanceof HTMLButtonElement) nodeButtons.set(id, element);
  else nodeButtons.delete(id);
}

function setRowElement(id: string, element: unknown): void {
  if (element instanceof HTMLElement) rowElements.set(id, element);
  else rowElements.delete(id);
}

function stateLabel(state: WorkerChartAgent['state']): string {
  switch (state) {
    case 'working': return 'Working';
    case 'parked': return 'Parked';
    case 'needs-you': return 'Needs you';
    case 'failed': return 'Failed';
    case 'done': return 'Done';
  }
}

function stateMark(agent: WorkerChartAgent): string {
  if (agent.state === 'needs-you') return '!';
  if (agent.state === 'failed') return '×';
  if (agent.state === 'done') return '✓';
  return agent.initials;
}

function agentLabel(agent: WorkerChartAgent): string {
  return `${agent.name}${agent.lane ? ` · ${agent.lane}` : ''} · ${stateLabel(agent.state)}`;
}

function groupLabel(row: WorkerChartGroupRow): string {
  const parent = layout.findAgent(props.root, row.parentId);
  if (row.expanded) return `Show fewer agents under ${parent?.name ?? 'this agent'}`;
  return `Show ${row.hiddenCount} more agents under ${parent?.name ?? 'this agent'}`;
}

function toggleGroup(parentId: string): void {
  const next = new Set(expandedParentIds.value);
  if (next.has(parentId)) next.delete(parentId);
  else next.add(parentId);
  expandedParentIds.value = next;
}

function toggleChartOverlay(): void {
  chartOverlayOpen.value = !chartOverlayOpen.value;
  if (chartOverlayOpen.value) {
    void nextTick(() => {
      positionChartOverlay();
      focusWithoutTooltip(tree.value?.querySelector<HTMLButtonElement>('[data-agent-id]') ?? null);
    });
  } else {
    dismissPopover(false);
  }
}

function closeChartOverlay(restoreFocus: boolean): void {
  chartOverlayOpen.value = false;
  dismissPopover(false);
  if (restoreFocus) void nextTick(() => focusWithoutTooltip(railTrigger.value));
}

function showTooltip(id: string): void {
  cancelTooltipClose();
  if (!selectedAgentId.value) hoveredAgentId.value = id;
}

function onNodeFocus(id: string): void {
  if (suppressTooltipOnFocus) return;
  showTooltip(id);
}

function focusWithoutTooltip(element: HTMLElement | null): void {
  if (!element?.isConnected) return;
  suppressTooltipOnFocus = true;
  try {
    element.focus({ preventScroll: true });
  } finally {
    suppressTooltipOnFocus = false;
  }
}

function scheduleTooltipClose(): void {
  if (tooltipCloseTimer) clearTimeout(tooltipCloseTimer);
  tooltipCloseTimer = setTimeout(() => {
    if (selectedAgentId.value) return;
    const focused = document.activeElement;
    if (popover.value?.contains(focused)) return;
    hoveredAgentId.value = null;
  }, 140);
}

function cancelTooltipClose(): void {
  if (tooltipCloseTimer) clearTimeout(tooltipCloseTimer);
  tooltipCloseTimer = null;
}

function onNodeBlur(event: FocusEvent): void {
  if (selectedAgentId.value) return;
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && popover.value?.contains(nextTarget)) return;
  scheduleTooltipClose();
}

function toggleAgentPopover(id: string): void {
  if (selectedAgentId.value === id) {
    dismissPopover(true);
    return;
  }
  selectedAgentId.value = id;
  hoveredAgentId.value = null;
  void nextTick(() => popover.value?.focus({ preventScroll: true }));
}

function dismissPopover(restoreFocus: boolean, fallback = false): void {
  const oldId = selectedAgentId.value ?? hoveredAgentId.value;
  selectedAgentId.value = null;
  hoveredAgentId.value = null;
  popoverReady.value = false;
  if (!restoreFocus) return;
  void nextTick(() => {
    const trigger = oldId ? nodeButtons.get(oldId) : null;
    if (trigger?.isConnected && !fallback) {
      focusWithoutTooltip(trigger);
      return;
    }
    if (isNarrow.value && railTrigger.value?.isConnected) {
      focusWithoutTooltip(railTrigger.value);
      return;
    }
    const firstVisible = chart.value.rows.find((row): row is WorkerChartAgentRow => row.kind === 'agent');
    const firstButton = firstVisible ? nodeButtons.get(firstVisible.agent.id) : null;
    if (firstButton?.isConnected) focusWithoutTooltip(firstButton);
    else if (host.value) {
      host.value.tabIndex = -1;
      focusWithoutTooltip(host.value);
    }
  });
}

function openAgent(agentId: string): void {
  emit('open-agent', { agentId });
  dismissPopover(true);
}

async function positionPopover(id: string): Promise<void> {
  await nextTick();
  const trigger = nodeButtons.get(id);
  const content = popover.value;
  if (!trigger || !content || !trigger.isConnected) return;
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = content.getBoundingClientRect();
  const gap = 8;
  const margin = 8;
  let left = triggerRect.left - popoverRect.width - gap;
  if (left < margin) left = Math.min(window.innerWidth - popoverRect.width - margin, triggerRect.right + gap);
  const top = Math.max(margin, Math.min(triggerRect.top - 8, window.innerHeight - popoverRect.height - margin));
  popoverStyle.value = { left: `${Math.max(margin, left)}px`, top: `${top}px` };
  popoverReady.value = true;
}

function repositionPopover(): void {
  const id = selectedAgentId.value ?? hoveredAgentId.value;
  if (id) void positionPopover(id);
}

function positionChartOverlay(): void {
  const bounds = host.value?.getBoundingClientRect();
  if (!bounds) return;
  overlayStyle.value = { right: `${Math.max(0, window.innerWidth - bounds.right)}px` };
}

function onWindowResize(): void {
  positionChartOverlay();
  repositionPopover();
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (host.value?.contains(target) || chartSurface.value?.contains(target) || popover.value?.contains(target)) return;
  if (selectedAgentId.value || hoveredAgentId.value) dismissPopover(false);
  if (chartOverlayOpen.value && !chartSurface.value?.contains(target)) closeChartOverlay(false);
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (selectedAgentId.value || hoveredAgentId.value) {
    event.stopPropagation();
    dismissPopover(true);
    return;
  }
  if (chartOverlayOpen.value) {
    event.stopPropagation();
    closeChartOverlay(true);
  }
}

function onVisibilityChange(): void {
  pageHidden.value = document.hidden;
  if (!document.hidden) now.value = Date.now();
}

function beforeRowEnter(element: Element): void {
  const row = element as HTMLElement;
  const parent = layout.findAgent(props.root, row.dataset.parentId || null);
  const parentRow = parent ? chart.value.rows.find(candidate => candidate.kind === 'agent' && candidate.agent.id === parent.id) : null;
  const key = row.dataset.rowKey;
  const thisRow = chart.value.rows.find(candidate => candidate.key === key);
  if (!thisRow) return;
  const parentX = parentRow?.x ?? thisRow.x;
  const parentY = parentRow?.y ?? thisRow.y;
  row.style.setProperty('--worker-chart-enter-x', `${parentX - thisRow.x}px`);
  row.style.setProperty('--worker-chart-enter-y', `${parentY - thisRow.y}px`);
}

function beforeRowLeave(element: Element): void {
  const row = element as HTMLElement;
  const parentId = row.dataset.parentId;
  const parentRow = chart.value.rows.find(candidate => candidate.kind === 'agent' && candidate.agent.id === parentId);
  const leavingRow = rowElements.get(row.dataset.rowKey ?? '');
  const bounds = leavingRow?.getBoundingClientRect();
  const parentButton = parentId ? nodeButtons.get(parentId) : null;
  const parentBounds = parentButton?.getBoundingClientRect();
  if (bounds && parentBounds) {
    row.style.setProperty('--worker-chart-leave-x', `${parentBounds.left - bounds.left}px`);
    row.style.setProperty('--worker-chart-leave-y', `${parentBounds.top - bounds.top}px`);
  } else if (parentRow) {
    row.style.setProperty('--worker-chart-leave-x', `${parentRow.x - (Number.parseFloat(row.style.left) || 0)}px`);
    row.style.setProperty('--worker-chart-leave-y', `${parentRow.y - (Number.parseFloat(row.style.top) || 0)}px`);
  }
  if (row.dataset.rowKey && !row.dataset.rowKey.startsWith('group:')) {
    const leavingAgent = layout.findAgent(props.root, row.dataset.rowKey);
    if (leavingAgent?.state === 'done') {
      row.querySelector('.worker-chart__dot')?.setAttribute('data-state', 'done');
      const mark = row.querySelector('.worker-chart__dot span');
      if (mark) mark.textContent = '✓';
    }
  }
}

function elapsed(agent: WorkerChartAgent): string {
  if (agent.startedAt == null) return 'Not reported';
  const end = agent.finishedAt ?? now.value;
  const seconds = Math.max(0, Math.floor((end - agent.startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function lastCheckInTime(agent: WorkerChartAgent): string {
  return agent.lastCheckIn ? new Date(agent.lastCheckIn.timestamp).toLocaleString() : 'None reported';
}

function sparklinePointX(sample: NonNullable<WorkerChartAgent['activity']>[number]): number {
  const start = now.value - WorkerChartActivityWindow.durationMs;
  return Math.max(0, Math.min(208, ((sample.timestamp - start) / WorkerChartActivityWindow.durationMs) * 208));
}

function sparklinePointY(sample: NonNullable<WorkerChartAgent['activity']>[number]): number {
  const samples = activitySamples.value;
  const peak = Math.max(1, ...samples.map(item => Math.max(0, item.value)));
  return 28 - (Math.max(0, sample.value) / peak) * 26;
}
</script>

<style scoped>
.worker-chart {
  position: sticky;
  top: var(--chat-header-height, 52px);
  z-index: 2;
  display: block;
  flex: 0 0 100px;
  width: 100px;
  min-width: 100px;
  height: 100%;
  min-height: 0;
  color: var(--text-primary);
}
.worker-chart--narrow {
  position: absolute;
  top: var(--chat-header-height, 52px);
  right: 0;
  bottom: 0;
  z-index: 20;
  width: 24px;
  min-width: 24px;
  height: auto;
  flex: none;
  pointer-events: none;
}
.worker-chart__tree {
  position: relative;
  width: 100px;
  min-height: 100%;
  max-height: calc(100vh - var(--chat-header-height, 52px));
  margin: 0;
  padding: 0;
  overflow: hidden auto;
  list-style: none;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
  overscroll-behavior: contain;
}
.worker-chart__rows { position: absolute; inset: 0; display: block; min-height: 100%; margin: 0; padding: 0; list-style: none; }
.worker-chart__row {
  position: absolute;
  display: block;
  width: 100px;
  height: 26px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.worker-chart__node {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  height: 26px;
  padding: 0 4px 0 0;
  overflow: hidden;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.worker-chart__node:hover { background: color-mix(in srgb, var(--text-primary) 6%, transparent); }
.worker-chart__node:focus-visible, .worker-chart__rail-trigger:focus-visible, .worker-chart__open:focus-visible {
  outline: 2px solid var(--accent-primary, var(--accent));
  outline-offset: 2px;
}
.worker-chart__dot {
  position: relative;
  display: inline-flex;
  flex: 0 0 18px;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent-primary, var(--accent)) 15%, var(--bg-surface));
  color: var(--accent-primary, var(--accent));
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}
.worker-chart__dot[data-state="working"] { background: var(--accent-primary, var(--accent)); color: var(--text-on-accent); }
.worker-chart__dot[data-state="working"]::after {
  position: absolute;
  inset: -3px;
  border: 1px solid color-mix(in srgb, var(--accent-primary, var(--accent)) 46%, transparent);
  border-radius: 50%;
  content: "";
  animation: worker-chart-pulse 1.8s ease-in-out infinite;
}
.worker-chart__dot[data-state="parked"] { opacity: .48; }
.worker-chart__dot[data-state="needs-you"] { background: var(--status-warning); color: var(--text-on-accent); }
.worker-chart__dot[data-state="failed"] { background: var(--status-error); color: var(--text-on-accent); font-size: 14px; }
.worker-chart__dot[data-state="done"] { background: color-mix(in srgb, var(--text-secondary) 14%, var(--bg-surface)); color: var(--text-secondary); }
.worker-chart__dot--tick, .worker-chart__rail-dot--tick { animation: worker-chart-snippet-tick 480ms cubic-bezier(.16, 1, .3, 1) both !important; }
.worker-chart__name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
}
.worker-chart__row--agent[data-parent-id=""] .worker-chart__name,
.worker-chart__row--agent[data-parent-id]:not([data-parent-id=""]) .worker-chart__name { font-weight: 500; }
.worker-chart__node--group { width: auto; max-width: 84px; padding: 0 6px; }
.worker-chart__group-count {
  min-width: 26px;
  padding: 3px 5px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-primary) 7%, var(--bg-surface));
  color: var(--text-secondary);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.worker-chart__surface--overlay {
  position: fixed;
  top: var(--chat-header-height, 52px);
  right: 0;
  bottom: 0;
  z-index: 30;
  width: 100px;
  overflow: hidden;
  background: var(--bg-surface);
  color: var(--text-primary);
}
.worker-chart__tree--overlay { height: 100%; max-height: none; }
.worker-chart__rail-trigger {
  position: absolute;
  inset: 0 0 0 auto;
  width: 24px;
  min-height: 100%;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
}
.worker-chart__rail-dots { position: absolute; inset: 0; display: block; }
.worker-chart__rail-dot {
  position: absolute;
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-secondary) 45%, transparent);
}
.worker-chart__rail-dot[data-state="working"] { background: var(--accent-primary, var(--accent)); animation: worker-chart-pulse 1.8s ease-in-out infinite; }
.worker-chart__rail-dot[data-state="parked"], .worker-chart__rail-dot[data-state="done"] { opacity: .4; }
.worker-chart__rail-dot[data-state="needs-you"] { background: var(--status-warning); }
.worker-chart__rail-dot[data-state="failed"] { background: var(--status-error); }
.worker-chart__rail-dot--group { background: color-mix(in srgb, var(--text-secondary) 24%, transparent); }
.worker-chart--hidden *, .worker-chart__surface--hidden *, .worker-chart__popover--hidden {
  animation-play-state: paused !important;
  transition: none !important;
}
.worker-chart__popover {
  position: fixed;
  z-index: 60;
  width: min(236px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  overflow: auto;
  scrollbar-width: thin;
  padding: 12px;
  border-radius: 12px;
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: 0 14px 36px color-mix(in srgb, var(--text-primary) 18%, transparent);
  opacity: 0;
  transform: translateY(3px);
  transition: opacity 140ms ease, transform 140ms ease;
  visibility: hidden;
}
.worker-chart__popover--ready { opacity: 1; transform: none; visibility: visible; }
.worker-chart__popover--hidden { transition: none; }
.worker-chart__popover:focus { outline: none; }
.worker-chart__popover-head { display: flex; align-items: center; gap: 8px; min-width: 0; margin-bottom: 10px; }
.worker-chart__dot--popover { flex-basis: 20px; width: 20px; height: 20px; }
.worker-chart__popover-title { flex: 1; min-width: 0; line-height: 1.25; }
.worker-chart__popover-title strong, .worker-chart__popover-title span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.worker-chart__popover-title strong { font-size: 13px; font-weight: 600; }
.worker-chart__popover-title span { color: var(--text-muted); font-size: 11px; }
.worker-chart__state-label { flex: none; padding: 3px 6px; border-radius: 99px; background: color-mix(in srgb, var(--text-secondary) 9%, transparent); color: var(--text-secondary); font-size: 10px; }
.worker-chart__state-label[data-state="working"] { color: var(--accent-primary, var(--accent)); }
.worker-chart__state-label[data-state="needs-you"] { color: var(--status-warning); }
.worker-chart__state-label[data-state="failed"] { color: var(--status-error); }
.worker-chart__details { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 12px; margin: 0 0 10px; font-size: 11px; }
.worker-chart__details dt { color: var(--text-muted); }
.worker-chart__details dd { min-width: 0; margin: 0; overflow: hidden; font-variant-numeric: tabular-nums; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.worker-chart__details .worker-chart__task, .worker-chart__details .worker-chart__check-in { grid-column: 1 / -1; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.worker-chart__details .worker-chart__task { color: var(--text-primary); }
.worker-chart__details .worker-chart__check-in { color: var(--text-secondary); line-height: 1.35; }
.worker-chart__activity { margin: 10px 0 12px; color: var(--text-muted); font-size: 10px; }
.worker-chart__activity > span:first-child { display: block; margin-bottom: 5px; }
.worker-chart__activity svg { display: block; width: 100%; height: 30px; overflow: visible; background: color-mix(in srgb, var(--accent-primary, var(--accent)) 6%, transparent); }
.worker-chart__activity polyline { fill: none; stroke: color-mix(in srgb, var(--accent-primary, var(--accent)) 60%, transparent); stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
.worker-chart__activity circle { fill: var(--accent-primary, var(--accent)); }
.worker-chart__no-activity { color: var(--text-muted); }
.worker-chart__open {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 32px;
  padding: 4px 7px;
  overflow: hidden;
  border: 0;
  border-radius: 8px;
  background: var(--accent-primary, var(--accent));
  color: var(--text-on-accent);
  font: inherit;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.worker-chart-row-move { transition: transform 380ms cubic-bezier(.16, 1, .3, 1); }
.worker-chart-row-enter-active, .worker-chart-row-leave-active { transition: transform 380ms cubic-bezier(.16, 1, .3, 1), opacity 220ms ease; }
.worker-chart-row-enter-from { opacity: 0; transform: translate(var(--worker-chart-enter-x, 0), var(--worker-chart-enter-y, 0)) scale(.65); }
.worker-chart-row-leave-to { opacity: 0; transform: translate(var(--worker-chart-leave-x, 0), var(--worker-chart-leave-y, -8px)) scale(.5); }
@keyframes worker-chart-pulse { 0%, 100% { opacity: .36; transform: scale(.9); } 50% { opacity: 0; transform: scale(1.45); } }
@keyframes worker-chart-snippet-tick { 0% { opacity: .5; transform: scale(.84); } 38% { opacity: 1; transform: scale(1.3); } 100% { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) {
  .worker-chart *, .worker-chart__surface *, .worker-chart__popover { animation: none !important; transition-duration: 0.01ms !important; }
  .worker-chart__dot[data-state="working"]::after { opacity: .4; transform: none; }
}
</style>
