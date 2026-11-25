<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <li v-if="row.subagent" class="dtr-row dtr-agent" data-kind="agent" :data-status="row.status">
    <div class="dtr-line">
      <span class="dtr-ic">
        <span class="dtr-marker" :data-role="row.subagent.isReviewer ? 'rev' : 'wrk'" :data-status="row.status" aria-hidden="true">{{ row.subagent.marker }}</span>
      </span>
      <div class="dtr-what"><span class="dtr-verb">{{ row.target }}</span><span v-if="row.subagent.agentId" class="dtr-agent-id">{{ row.subagent.agentId }}</span></div>
      <span class="dtr-m"><span class="dtr-dur">{{ duration }}</span><span class="dtr-st" :data-s="row.status">{{ statusLabel }}</span></span>
      <button
        type="button" class="dtr-x" :aria-expanded="open" :aria-controls="payloadId"
        :aria-label="`Brief, check-ins and report for ${row.target}`"
        @click="toggle"
      ><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></button>
    </div>
    <p v-if="row.note" class="dtr-note"><time v-if="noteTime" class="dtr-when">{{ noteTime }}</time>{{ row.note }}</p>
    <div class="dtr-agent-meta">
      <span v-if="agentMeta">{{ agentMeta }}</span>
      <button v-if="row.subagent.conversationId && openConversation" type="button" @click="openAgent">Open agent</button>
      <button type="button" :aria-expanded="open" :aria-controls="payloadId" @click="toggle">Brief</button>
    </div>
    <p v-if="open && historyError" class="dtr-note" role="status">Check-in history could not be loaded.</p>
    <pre v-if="open" :id="payloadId" class="dtr-raw" tabindex="0">{{ payloadText }}</pre>
  </li>
  <li v-else class="dtr-row" :data-kind="row.kind" :data-status="row.status">
    <div class="dtr-line">
      <span class="dtr-ic" aria-hidden="true"><svg viewBox="0 0 16 16" v-html="icon" /></span>
      <div class="dtr-what">
        <span v-if="row.cite !== undefined" class="dtr-cite">[{{ row.cite }}]</span><span class="dtr-verb">{{ row.verb }}</span>
        <code v-if="row.targetIsCode" class="dtr-tg">{{ row.target }}</code><span v-else class="dtr-tg">{{ row.target }}</span>
        <span v-if="row.keyArgs" class="dtr-args">{{ row.keyArgs }}</span>
      </div>
      <span class="dtr-m"><span class="dtr-dur">{{ row.durationLabel }}</span><span class="dtr-st" :data-s="row.status">{{ row.status }}</span></span>
      <button
        v-if="row.payload" type="button" class="dtr-x" :aria-expanded="open" :aria-controls="payloadId"
        :aria-label="`Raw payload for ${row.verb} ${row.target}`"
        @click="toggle"
      ><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></button>
    </div>
    <p v-if="row.note" class="dtr-note">{{ row.note }}</p>
    <pre v-if="open && row.payload" :id="payloadId" class="dtr-raw" tabindex="0">{{ payloadText }}</pre>
  </li>
</template>

<script setup lang="ts">
import { computed, inject, shallowRef, ref, watch, type Ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { AgentTraceHistoryData } from '@pkg/agent/app/Services/AgentTraceHistory';
import type { OpenSubAgentConversation } from '../subagent/subAgentConversation';
import { SubAgentTraceProjection } from './SubAgentTraceProjection';
import type { SubAgentTraceStatus, TraceRow as TraceRowModel } from './traceTypes';
import { TraceDisclosureController } from './traceDisclosure';

const props = defineProps<{ row: TraceRowModel }>();
const disclosure = inject('chat:trace-disclosure', new TraceDisclosureController());
const open = computed(() => disclosure.isOpen(props.row.id));
// Static icon paths from the approved mockup; never built from row data.
const icons = {
  shell: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5 7 8 5 9.5M8.5 10H11"/>',
  file: '<path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3"/>',
  read: '<path d="M8 4.2C6.5 3.2 4.5 3 2.5 3.4v8.4c2-.4 4-.2 5.5.8 1.5-1 3.5-1.2 5.5-.8V3.4c-2-.4-4-.2-5.5.8zM8 4.2v8.4"/>',
  thought: '<path d="M3 3.5h10v7H7.5L5 12.8v-2.3H3z"/>',
  dot: '<circle cx="8" cy="8" r="2"/>',
} as const;
const icon = computed(() => {
  switch (props.row.kind) {
    case 'tool': return icons.shell;
    case 'source': return icons.read;
    case 'memory': case 'heartbeat': case 'approval': return icons.file;
    case 'thought': return icons.thought;
    default: return icons.dot;
  }
});
const payloadId = computed(() => `dtr-raw-${props.row.id.replace(/[^\w-]/g, '_')}`);
const openConversation = inject<OpenSubAgentConversation | undefined>('chat:open-subagent-conversation', undefined);
const agentProjection = new SubAgentTraceProjection();
const context = inject<{ backendThreadId: Ref<string | undefined> } | undefined>('chat:activity-context', undefined);
const history = shallowRef<AgentTraceHistoryData | null>(null);
const historyError = ref(false);
watch([() => context?.backendThreadId.value, () => props.row.subagent?.jobId, () => props.row.subagent?.taskIndex ?? 0], () => {
  history.value = null;
  historyError.value = false;
}, { flush: 'sync' });
watch([
  open,
  () => context?.backendThreadId.value,
  () => props.row.subagent?.jobId,
  () => props.row.subagent?.taskIndex ?? 0,
  () => props.row.subagent?.checkinAt,
  () => props.row.subagent?.endedAt,
], async([expanded, parent, jobId, taskIndex], _, onCleanup) => {
  if (!expanded || !parent || !jobId) return;
  let current = true;
  onCleanup(() => { current = false; });
  historyError.value = false;
  try {
    const data = await ipcRenderer.invoke('agents:trace-history', parent, jobId, taskIndex);
    if (current) history.value = data;
  } catch {
    if (current) historyError.value = true;
  }
}, { immediate: true });
// Do not reserialize unchanged data when the surrounding trace is reprojected.
const payloadSource = computed<{ id: string; payload?: TraceRowModel['payload'] }>(previous => {
  const { id, payload } = props.row;
  if (previous?.id === id && (previous.payload === payload || (payload && previous.payload?.matches(payload)))) return previous;
  return { id, payload };
});
// Only the open disclosure reads this computed.
const payloadText = computed(() => payloadSource.value.payload?.serialize(history.value?.checkins));
const statusLabel = computed(() => SubAgentTraceProjection.statusLabel(props.row.status as SubAgentTraceStatus));
const agentMeta = computed(() => {
  const agent = props.row.subagent;
  if (!agent) return '';
  return [agent.model, agent.runLocation ?? history.value?.runLocation, agent.jobId ? `job ${agent.jobId}` : undefined,
    agent.taskIndex !== undefined ? `task ${agent.taskIndex}` : undefined].filter(Boolean).join(' · ');
});
const noteTime = computed(() => props.row.subagent?.noteAt !== undefined
  ? new Date(props.row.subagent.noteAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
const rowNow = ref(Date.now());
const ticking = computed(() => {
  const agent = props.row.subagent;
  // Time since launch for every unsettled state; total run time once it ends.
  return agent?.startedAt !== undefined && agent.endedAt === undefined &&
    !['returned', 'failed', 'stopped'].includes(props.row.status);
});
watch(ticking, (active, _, onCleanup) => {
  rowNow.value = Date.now();
  if (!active) return;
  const timer = setInterval(() => { rowNow.value = Date.now(); }, 1_000);
  onCleanup(() => clearInterval(timer));
}, { immediate: true });
const duration = computed(() => {
  const agent = props.row.subagent;
  if (props.row.durationLabel) return props.row.durationLabel;
  if (agent?.startedAt === undefined) return '';
  return agentProjection.duration((agent.endedAt ?? rowNow.value) - agent.startedAt);
});
function openAgent(): void {
  const agent = props.row.subagent;
  if (agent?.conversationId) openConversation?.({ conversationId: agent.conversationId, agentId: agent.agentId ?? '', label: props.row.target });
}
function toggle(): void { disclosure.toggle(props.row.id); }
</script>

<style scoped>
/* Approved Detailed row format (chat-subagent-items.html / chat-detailed-clean.html). */
.dtr-row { position: relative; padding: 2px 0; list-style: none; }
.dtr-line { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto 24px; column-gap: 10px; align-items: start; border-radius: 6px; }
.dtr-ic { grid-column: 1; grid-row: 1; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: var(--bg-page); color: var(--text-muted); }
.dtr-ic svg, .dtr-x svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.dtr-what { grid-column: 2; grid-row: 1; min-width: 0; padding: 2px 0; color: var(--text-secondary); font: 13px/20px var(--font-body); overflow-wrap: anywhere; }
.dtr-verb { color: var(--text-primary); font-weight: 500; margin-right: 4px; }
.dtr-tg { color: var(--text-primary); }
code.dtr-tg { padding: 1px 5px; border-radius: 5px; background: var(--bg-surface); font: 12.5px var(--font-mono, ui-monospace, monospace); }
.dtr-args { margin-left: 6px; color: var(--text-muted); font: 11.5px var(--font-mono, ui-monospace, monospace); }
.dtr-cite { margin-right: 6px; color: var(--primary-color-text-override, var(--accent)); font: 11.5px var(--font-mono, ui-monospace, monospace); }
.dtr-m { grid-column: 3; grid-row: 1; display: flex; gap: 10px; font-size: 12px; line-height: 24px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dtr-dur { width: 54px; text-align: right; color: var(--text-muted); }
.dtr-st { width: 68px; color: var(--text-muted); }
.dtr-st[data-s="failed"] { color: var(--status-error); font-weight: 500; }
.dtr-st[data-s="waiting"], .dtr-st[data-s="blocked"], .dtr-st[data-s="quiet"] { color: var(--status-warning); font-weight: 500; }
.dtr-st[data-s="returned"] { color: var(--status-success); font-weight: 500; }
.dtr-st[data-s="working"] { color: var(--primary-color-text-override, var(--accent)); font-weight: 500; }
.dtr-st[data-s="working"]::before { content: ''; display: inline-block; width: 6px; height: 6px; margin: 0 6px 1px 0; border-radius: 50%; background: currentColor; vertical-align: middle; animation: dtr-breath 1.9s cubic-bezier(.45, 0, .55, 1) infinite; }
@keyframes dtr-breath { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
.dtr-row[data-status="failed"] .dtr-ic { color: var(--status-error); }
.dtr-x { grid-column: 4; grid-row: 1; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer; }
.dtr-x:hover { background: var(--bg-surface); color: var(--text-primary); }
.dtr-x svg { width: 14px; height: 14px; transition: transform .16s cubic-bezier(.22, 1, .36, 1); }
.dtr-x[aria-expanded="true"] svg { transform: rotate(90deg); }
.dtr-note { margin: 0 34px 2px; color: var(--text-secondary); font: 13px/19px var(--font-body); white-space: pre-wrap; overflow-wrap: anywhere; }
.dtr-row[data-status="failed"] .dtr-note, .dtr-row[data-status="blocked"] .dtr-note { color: var(--text-primary); }
.dtr-raw { margin: 4px 34px 8px; padding: 10px 12px; border-radius: 8px; background: var(--bg-surface); color: var(--text-primary); font: 12px/1.6 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
/* Sub-agent row: marker is the worker chart's agent marker. */
.dtr-agent { margin-top: 4px; }
.dtr-marker { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; font: 600 10px/1 var(--font-body); }
.dtr-marker[data-role="wrk"] { background: var(--border-muted); color: var(--text-secondary); }
.dtr-marker[data-role="rev"] { background: var(--bg-page); color: var(--text-secondary); box-shadow: inset 0 0 0 1px var(--border-default); }
.dtr-marker[data-status="starting"], .dtr-marker[data-status="stopped"] { opacity: .45; }
.dtr-marker[data-status="blocked"], .dtr-marker[data-status="quiet"] { background: var(--status-warning); color: var(--bg-page); box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-warning) 26%, transparent); }
.dtr-marker[data-status="failed"] { background: var(--status-error); color: var(--bg-page); box-shadow: none; }
.dtr-agent-id { margin-left: 6px; color: var(--text-secondary); font: 11.5px var(--font-mono, ui-monospace, monospace); white-space: nowrap; }
.dtr-when { margin-right: 6px; color: var(--text-muted); font: 11px var(--font-mono, ui-monospace, monospace); }
.dtr-agent-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin: 2px 34px 4px; color: var(--text-muted); font: 11.5px/18px var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.dtr-agent-meta button { padding: 0; border: 0; background: none; color: var(--primary-color-text-override, var(--accent)); font: 12.5px var(--font-body); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.dtr-row button:focus-visible { outline: 0; border-radius: 6px; box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 28%, transparent); }
@media (max-width: 600px) {
  .dtr-line { grid-template-columns: 24px minmax(0, 1fr) 24px; }
  .dtr-m { grid-column: 2; grid-row: 2; line-height: 18px; padding-bottom: 2px; }
  .dtr-dur { width: auto; text-align: left; } .dtr-st { width: auto; }
  .dtr-x { grid-column: 3; }
  .dtr-note, .dtr-raw, .dtr-agent-meta { margin-right: 0; }
}
@media (prefers-reduced-motion: reduce) { .dtr-st[data-s="working"]::before { animation: none; } .dtr-x svg { transition: none; } }
</style>
