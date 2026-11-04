<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <aside
      v-if="cards.length && !collapsed"
      class="sd-agent-rail"
      aria-label="Sub-agents launched by this chat"
    >
    <header class="sd-agent-heading">
    <h2>Sub-agents</h2>
    <span>{{ runningCount ? `${ runningCount } running` : `${ cards.length } total` }}</span>
    <button
      class="sd-icon-button"
      type="button"
      title="Hide sub-agents"
      aria-label="Hide sub-agents"
      @click="emit('toggle-collapse')"
    >
    <svg viewBox="0 0 24 24">
    <rect
      x="3.5"
      y="4.5"
      width="17"
      height="15"
      rx="3"
    />
    <path d="M9.5 4.5v15"/>
    </svg>
    </button>
    </header>
    <div
      class="sd-agent-filters"
      role="tablist"
      aria-label="Filter sub-agents"
    >
    <span
      class="sd-filter-indicator"
      :style="{ transform: `translateX(${ filterIndex * 100 }%)` }"
    />
    <button
      v-for="item in filters"
      :key="item.value"
      role="tab"
      :aria-selected="filter === item.value"
      @click="filter = item.value"
    >{{ item.label }}</button>
    </div>
    <div class="sd-agent-list">
      <template v-if="visibleRunning.length">
    <div class="sd-agent-group">
    <span>Active</span>
    <span>{{ visibleRunning.length }}</span>
    </div>
    <button
      v-for="card in visibleRunning"
      :key="cardKey(card)"
      type="button"
      class="sd-agent-row"
      :class="`is-${ card.status }`"
      :aria-current="selectedKey === cardKey(card) || undefined"
      @click="emit('select', card)"
    >
    <i class="sd-status-dot"/>
    <strong>{{ card.label }}</strong>
    <time>{{ elapsed(card) }}</time>
    <span>
    <b>{{ agentName(card.agentId) }}</b> · {{ card.lastActivity || card.status }}<template v-if="card.contract && card.contract !== 'result'"> · {{ card.contract }}</template>
    </span>
    </button>
    </template>
      <p
      v-else-if="filter === 'running'"
      class="sd-agent-empty"
    >Nothing running right now.</p>
      <template v-if="visibleFinished.length">
    <div class="sd-agent-group">
    <span>Finished</span>
    <span>{{ visibleFinished.length }}</span>
    </div>
    <button
      v-for="card in visibleFinished"
      :key="cardKey(card)"
      type="button"
      class="sd-agent-row"
      :class="[`is-${ card.status }`, { 'is-dismissing': dismissingKey === cardKey(card) }]"
      :aria-current="selectedKey === cardKey(card) || undefined"
      @click="emit('select', card)"
    >
    <i class="sd-status-dot"/>
    <strong>{{ card.label }}</strong>
    <time>{{ elapsed(card) }}</time>
    <span>
    <b>{{ agentName(card.agentId) }}</b> · {{ card.lastActivity || card.status }}<template v-if="card.contract && card.contract !== 'result'"> · {{ card.contract }}</template>
    </span>
    </button>
    </template>
      <p
      v-else-if="filter === 'finished'"
      class="sd-agent-empty"
    >No finished agents yet.</p>
    </div>
  </aside>
  <button
      v-else-if="cards.length"
      type="button"
      class="sd-agent-rail-tab"
      :class="{ running: runningCount }"
      title="Show sub-agents"
      aria-label="Show sub-agents panel"
      @click="emit('toggle-collapse')"
    >
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
    <rect
      x="3.5"
      y="4.5"
      width="17"
      height="15"
      rx="3"
    />
    <path d="M9.5 4.5v15"/>
    </svg>
    <b>Sub-agents · {{ runningCount ? `${ runningCount } running` : cards.length }}</b>
    </button>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ThreadAgentCard } from '@pkg/main/agentsIpc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ parentThreadId?: string; collapsed?: boolean; selectedKey?: string }>();
const emit = defineEmits<{
  select: [card: ThreadAgentCard];
  visibility: [visible: boolean];
  'toggle-collapse': [];
}>();
const cards = ref<ThreadAgentCard[]>([]);
const now = ref(Date.now());
const filter = ref<'all' | 'running' | 'finished'>('all');
const dismissingKey = ref('');
const filters = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'finished', label: 'Finished' },
] as const;
const filterIndex = computed(() => filters.findIndex(item => item.value === filter.value));
const runningCount = computed(() => cards.value.filter(card => card.status === 'running' || card.status === 'parked').length);
const visibleRunning = computed(() => filter.value === 'finished' ? [] : cards.value.filter(card => card.status === 'running' || card.status === 'parked'));
const visibleFinished = computed(() => filter.value === 'running' ? [] : cards.value.filter(card => card.status !== 'running' && card.status !== 'parked'));
let timer: ReturnType<typeof setInterval> | null = null;
let request = 0;
let tick = 0;

const cardKey = (card: ThreadAgentCard) => `${card.kind}:${card.jobId}:${card.taskIndex}`;

function elapsed(card: ThreadAgentCard): string {
  const seconds = Math.max(0, Math.floor(((card.finishedAt ?? now.value) - card.createdAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

function agentName(id: string): string {
  return id.split('-').map(part => ({ codex: 'Codex', sol: 'Sol', luna: 'Luna' })[part] || part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

async function refresh(): Promise<void> {
  const id = props.parentThreadId;
  const current = ++request;
  now.value = Date.now();
  if (!id) {
    cards.value = [];
    return;
  }
  try {
    const next = await ipcRenderer.invoke('agents:thread-jobs' as any, id) as ThreadAgentCard[];
    if (current === request) {
      cards.value = Array.isArray(next) ? next : [];
      const selected = cards.value.find(card => cardKey(card) === props.selectedKey);
      if (selected) emit('select', selected);
    }
  } catch {
    if (current === request) cards.value = [];
  }
}

async function dismiss(card: ThreadAgentCard): Promise<void> {
  if (!props.parentThreadId) return;
  dismissingKey.value = cardKey(card);
  const ok = await ipcRenderer.invoke('agents:dismiss-thread-job' as any, card.jobId, props.parentThreadId, card.taskIndex);
  setTimeout(() => {
    if (ok) cards.value = cards.value.filter(item => cardKey(item) !== cardKey(card));
    dismissingKey.value = '';
  }, 240);
}

defineExpose({ dismiss });
watch(() => props.parentThreadId, refresh, { immediate: true });
watch(() => cards.value.length > 0, value => emit('visibility', value), { immediate: true });
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
    tick += 1;
    if (tick % 3 === 0) void refresh();
  }, 1000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>
<style scoped>
.sd-agent-rail {
  line-height: 1.4;
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 8;
  width: 272px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding-top: 4px;
  background: color-mix(in srgb,var(--bg-surface) 82%,transparent);
  backdrop-filter: blur(12px);
  color: var(--text-primary);
}
.sd-agent-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 10px 12px;
}
.sd-agent-heading h2 {
  margin: 0;
  font: 500 13px/1 var(--font-mono);
}
.sd-agent-heading>span {
  color: var(--text-muted);
  font: 11px var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.sd-icon-button {
  margin-left: auto;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.sd-icon-button:hover {
  background: var(--bg-surface-alt);
  color: var(--text-primary);
}
.sd-icon-button svg {
  width: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.sd-agent-filters {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3,1fr);
  margin: 0 8px 8px;
  padding: 3px;
  border-radius: 10px;
  background: var(--bg-surface-alt);
}
.sd-agent-filters button {
  font: inherit;
  position: relative;
  z-index: 1;
  height: 28px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  cursor: pointer;
}
.sd-agent-filters button[aria-selected=true] {
  color: var(--text-primary);
  font-weight: 500;
}
.sd-filter-indicator {
  position: absolute;
  top: 3px;
  left: 3px;
  width: calc((100% - 6px)/3);
  height: 28px;
  border-radius: 8px;
  background: var(--bg-surface);
  box-shadow: var(--elev-rest);
  transition: transform 580ms linear(0,.006,.025 2.8%,.101 6.1%,.539 18.9%,.849 31.5%,.968 41.8%,1.006 50.1%,1.017 63.9%,1);
}
.sd-agent-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 4px 12px 8px;
}
.sd-agent-group {
  display: flex;
  justify-content: space-between;
  margin: 10px 0 4px;
  padding: 0 8px;
  color: var(--text-muted);
  font: 11px var(--font-mono);
  letter-spacing: .06em;
  text-transform: uppercase;
}
.sd-agent-row {
  font: inherit;
  display: grid;
  grid-template-columns: 14px minmax(0,1fr) auto;
  gap: 2px 8px;
  align-items: start;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: background 120ms,opacity 240ms,transform 240ms;
}
.sd-agent-row:hover {
  background: var(--bg-surface-alt);
}
.sd-agent-row[aria-current=true] {
  background: var(--bg-surface);
  box-shadow: var(--elev-rest), inset 0 0 0 1px var(--accent-border);
}
.sd-agent-row.is-dismissing {
  opacity: 0;
  transform: translateX(-8px);
}
.sd-agent-row strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 500;
}
.sd-agent-row time {
  padding-top: 2px;
  color: var(--text-muted);
  font: 11.5px var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.sd-agent-row>span {
  grid-column: 2/4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 12.5px;
}
.sd-agent-row>span b {
  color: var(--accent-primary);
  font: 500 11.5px var(--font-mono);
}
.sd-status-dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--border-muted);
}
.is-running .sd-status-dot {
  background: var(--accent-primary);
  animation: chat-pulse 1.8s ease infinite;
}
.is-parked .sd-status-dot {
  background: var(--status-warning);
}
.is-done .sd-status-dot {
  background: var(--status-success);
}
.is-failed .sd-status-dot {
  background: var(--status-error);
}
.is-stopped .sd-status-dot {
  background: var(--status-warning);
}
.sd-agent-empty {
  padding: 24px 12px;
  color: var(--text-muted);
  font-size: 13px;
}
.sd-agent-rail-tab {
  position: absolute;
  top: 50%;
  left: 0;
  z-index: 8;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 5px;
  border: 1px solid var(--border-default);
  border-left: 0;
  border-radius: 0 9px 9px 0;
  background: var(--bg-surface);
  color: var(--text-muted);
  cursor: pointer;
}
.sd-agent-rail-tab svg {
  width: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.sd-agent-rail-tab b {
  writing-mode: vertical-rl;
  font: 600 10px var(--font-mono);
  letter-spacing: .12em;
  text-transform: uppercase;
}
@media(prefers-reduced-motion:reduce) {
  .sd-filter-indicator,.sd-agent-row{transition-duration:1ms !important;
}
}
</style>
