<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <aside
    v-if="rows.length && !collapsed"
    class="sd-agent-rail"
    aria-label="Sub-agents launched by this chat"
  >
    <header class="sd-agent-heading">
      <h2>Sub-agents</h2><span>{{ liveCount ? `${liveCount} live` : `${rows.length} total` }}</span><button
        class="sd-icon-button"
        type="button"
        title="Hide sub-agents"
        aria-label="Hide sub-agents"
        @click="emit('toggle-collapse')"
      >
        <svg viewBox="0 0 24 24"><rect
          x="3.5"
          y="4.5"
          width="17"
          height="15"
          rx="3"
        /><path d="M9.5 4.5v15" /></svg>
      </button>
    </header>
    <div
      class="sd-agent-filters"
      role="tablist"
      aria-label="Filter sub-agents"
    >
      <span
        class="sd-filter-indicator"
        :style="{ transform: `translateX(${filterIndex * 100}%)` }"
      /><button
        v-for="item in filters"
        :key="item.value"
        role="tab"
        :aria-selected="filter === item.value"
        @click="filter = item.value"
      >
        {{ item.label }}
      </button>
    </div>
    <div class="sd-agent-list">
      <button
        v-for="node in visibleRows"
        :key="node.row.key"
        type="button"
        class="sd-agent-row"
        :class="[`is-${node.row.state}`, { 'is-done': node.row.state === 'done' }]"
        :style="{ paddingLeft: `${10 + node.depth * 14}px` }"
        :aria-current="selectedKey === legacyKey(node.row) || undefined"
        @click="emit('select', legacyCard(node.row))"
      >
        <i class="sd-status-dot" /><strong>{{ node.row.label }}</strong><time>{{ elapsed(node.row) }}</time>
        <span><b>{{ agentName(node.row.agentId) }}</b> · {{ node.row.lastCheckinSummary || node.row.stateReason || stateLabel(node.row) }}<template v-if="contractLabel(node.row)"> · {{ contractLabel(node.row) }}</template><template v-if="stopAttribution(node.row)"><br>{{ stopAttribution(node.row) }}</template></span>
        <em
          class="sd-state-chip"
          :title="node.row.stateReason || undefined"
        >{{ stateLabel(node.row) }}</em>
      </button>
      <p
        v-if="!visibleRows.length"
        class="sd-agent-empty"
      >
        No agents in this filter.
      </p>
    </div>
  </aside>
  <button
    v-else-if="rows.length"
    type="button"
    class="sd-agent-rail-tab"
    :class="{ running: liveCount }"
    title="Show sub-agents"
    aria-label="Show sub-agents panel"
    @click="emit('toggle-collapse')"
  >
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    ><rect
      x="3.5"
      y="4.5"
      width="17"
      height="15"
      rx="3"
    /><path d="M9.5 4.5v15" /></svg><b>Sub-agents · {{ liveCount ? `${liveCount} live` : rows.length }}</b>
  </button>
</template>
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { ThreadAgentCard } from '@pkg/main/agentsIpc';
import { StopAttributionFormatter } from '@pkg/agent/app/Formatters/StopAttributionFormatter';
import { AgentStateRowPresenter } from '@pkg/services/agentState/AgentStateRowPresenter';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder, type AgentTreeNode } from '@pkg/services/agentState/AgentTreeBuilder';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ parentThreadId?: string; collapsed?: boolean; selectedKey?: string }>();
const emit = defineEmits<{ select: [card: ThreadAgentCard]; visibility: [visible: boolean]; 'toggle-collapse': [] }>();
const client = inject(AGENT_STATE_CLIENT_KEY);
if (!client) throw new Error('AgentStateClient is not provided');
const now = ref(Date.now());
const rowPresenter = new AgentStateRowPresenter(new StopAttributionFormatter());
const dismissed = ref(new Set<string>());
const legacyCards = ref(new Map<string, ThreadAgentCard>());
const filter = ref<'all' | 'running' | 'finished'>('all');
const filters = [{ value: 'all', label: 'All' }, { value: 'running', label: 'Live' }, { value: 'finished', label: 'Finished' }] as const;
const liveStates = new Set<AgentStateRow['state']>(['queued', 'working', 'parked', 'quiet', 'blocked']);
const tree = computed(() => props.parentThreadId ? new AgentTreeBuilder(client.snapshot.value.rows).forThread(props.parentThreadId) : []);
const rows = computed(() => new AgentTreeBuilder(client.snapshot.value.rows).flatten(tree.value).filter(node => !dismissed.value.has(node.row.key)));
const visibleRows = computed(() => rows.value.filter(node => filter.value === 'all' || (filter.value === 'running') === liveStates.has(node.row.state)));
const liveCount = computed(() => rows.value.filter(node => liveStates.has(node.row.state)).length);
const filterIndex = computed(() => filters.findIndex(item => item.value === filter.value));
let timer: ReturnType<typeof setInterval> | null = null;
let metadataTick = 0;

function stateLabel(row: AgentStateRow): string { const label = rowPresenter.statusLabel(row); if (label === 'Killed by human') return label; if (row.state === 'parked') return `parked · waiting on ${ row.waitingOnChildren }`; if (row.state === 'quiet' && row.lastCheckinAt) return `quiet · ${ age(row.lastCheckinAt) }`; return row.state }
function age(value: string): string { const seconds = Math.max(0, Math.floor((now.value - Date.parse(value)) / 1000)); return seconds < 60 ? `${ seconds }s` : `${ Math.floor(seconds / 60) }m` }
function elapsed(row: AgentStateRow): string { const start = row.startedAt ? Date.parse(row.startedAt) : now.value; const end = row.endedAt ? Date.parse(row.endedAt) : now.value; const seconds = Math.max(0, Math.floor((end - start) / 1000)); return seconds < 60 ? `${ seconds }s` : `${ Math.floor(seconds / 60) }m` }
function agentName(id: string | null): string { return (id || 'Agent').split('-').map(part => ({ codex: 'Codex', sol: 'Sol', luna: 'Luna' }[part] || part.charAt(0).toUpperCase() + part.slice(1))).join(' ') }
function contractLabel(row: AgentStateRow): string { const contract = legacyCards.value.get(row.key)?.contract; return contract && contract !== 'result' ? contract : '' }
function stopAttribution(row: AgentStateRow): string { return rowPresenter.stopAttribution(row) }
function legacyKey(row: AgentStateRow): string { return `${ row.visibility === 'tab' ? 'tab' : 'job' }:${ row.jobId }:${ row.taskIndex }` }
function legacyCard(row: AgentStateRow): ThreadAgentCard { const existing = legacyCards.value.get(row.key); const status: ThreadAgentCard['status'] = ['working', 'queued', 'quiet', 'blocked'].includes(row.state) ? 'running' : row.state === 'lost' ? 'failed' : row.state; return { jobId: row.jobId, taskIndex: row.taskIndex, agentId: row.agentId || 'agent', label: row.label, status, createdAt: row.startedAt ? Date.parse(row.startedAt) : now.value, finishedAt: row.endedAt ? Date.parse(row.endedAt) : null, conversationId: row.threadId || undefined, lastActivity: row.lastCheckinSummary || row.stateReason || row.state, lastActivityAt: Date.parse(row.lastActivityAt), kind: row.visibility === 'tab' ? 'tab' : 'job', contract: existing?.contract || 'result', agentTab: row.visibility === 'tab' && row.threadId ? { contractId: row.key, threadId: row.threadId, agentName: row.label, parentAgentId: 'orchestrator', depth: row.depth } : undefined } }
async function refreshMetadata(): Promise<void> {
  if (!props.parentThreadId) { legacyCards.value = new Map(); return }
  try {
    const cards = await ipcRenderer.invoke('agents:thread-jobs' as any, props.parentThreadId) as ThreadAgentCard[];
    legacyCards.value = new Map(cards.map(card => [`${ card.jobId }:${ card.taskIndex }`, card]));
  } catch (error) { ipcRenderer.send('debug:report' as any, 'subagent-rail:metadata-refresh', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '' }); }
}
async function dismiss(card: ThreadAgentCard): Promise<void> {
  if (!props.parentThreadId) return;
  const hidden = new Set(dismissed.value); hidden.add(`${ card.jobId }:${ card.taskIndex }`); dismissed.value = hidden;
  try { await ipcRenderer.invoke('agents:dismiss-thread-job' as any, card.jobId, props.parentThreadId, card.taskIndex) } catch (error) { ipcRenderer.send('debug:report' as any, 'subagent-rail:dismiss', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : '' }); }
}
defineExpose({ dismiss });
watch(() => rows.value.length > 0, visible => emit('visibility', visible), { immediate: true });
watch(() => props.parentThreadId, () => { dismissed.value = new Set(); void refreshMetadata() }, { immediate: true });
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); metadataTick += 1; if (metadataTick % 3 === 0) void refreshMetadata() }, 1000) });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
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
.sd-agent-row{position:relative}.sd-agent-row.is-done{opacity:.72}.sd-state-chip{grid-column:2/4;width:max-content;margin-top:3px;padding:1px 6px;border-radius:999px;background:var(--bg-surface-alt);color:var(--text-muted);font:10px var(--font-mono);font-style:normal}.is-blocked .sd-status-dot,.is-failed .sd-status-dot,.is-lost .sd-status-dot{background:var(--status-error)}.is-quiet .sd-status-dot,.is-parked .sd-status-dot{background:var(--status-warning)}
</style>
