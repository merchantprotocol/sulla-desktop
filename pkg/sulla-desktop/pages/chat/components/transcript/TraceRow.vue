<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <article v-if="row.subagent" class="dtr-agent" :data-status="row.status">
    <div class="dtr-agent-head">
      <span class="dtr-agent-marker" :class="{ 'dtr-agent-reviewer': row.subagent.isReviewer }" aria-hidden="true">{{ initial }}</span>
      <div class="dtr-agent-identity">
        <span class="dtr-agent-label">{{ row.target }}</span>
        <span v-if="row.subagent.agentId" class="dtr-agent-id">{{ row.subagent.agentId }}</span>
      </div>
      <span class="dtr-duration">{{ duration }}</span>
      <span class="dtr-status" :class="`dtr-status-${row.status}`">{{ statusLabel }}</span>
      <button
        type="button" class="dtr-agent-chevron" :aria-expanded="open"
        :aria-label="`Brief, check-ins and report for ${row.target}`"
        @click="toggle"
      >{{ open ? '⌄' : '›' }}</button>
    </div>
    <p v-if="row.note" class="dtr-agent-note">
      <time v-if="noteTime" class="dtr-agent-time">{{ noteTime }}</time>{{ row.note }}
    </p>
    <div v-if="agentMeta || row.subagent.conversationId || row.subagent.brief" class="dtr-agent-meta">
      <span v-if="agentMeta">{{ agentMeta }}</span>
      <button v-if="row.subagent.conversationId && openConversation" type="button" @click="openAgent">Open agent</button>
      <button v-if="row.subagent.brief" type="button" :aria-expanded="open" @click="toggle">Brief</button>
    </div>
    <p v-if="open && historyError" class="dtr-agent-note" role="status">Check-in history could not be loaded.</p>
    <pre v-if="open" class="dtr-payload dtr-agent-report" tabindex="0">{{ payloadText }}</pre>
  </article>
  <article v-else class="dtr-row" :class="`dtr-row-${row.kind}`">
    <div class="dtr-icon" aria-hidden="true">{{ icon }}</div>
    <button v-if="row.payload" class="dtr-main dtr-disclosure" type="button" :aria-expanded="open" @click="toggle" @keydown.enter.prevent="toggle" @keydown.space.prevent="toggle">
      <span class="dtr-summary"><span class="dtr-verb">{{ row.verb }}</span><span class="dtr-target" :class="{ 'dtr-code': row.targetIsCode }">{{ row.target }}</span><span v-if="row.keyArgs" class="dtr-args dtr-code">{{ row.keyArgs }}</span></span>
      <span class="dtr-meta"><span v-if="row.durationLabel" class="dtr-duration">{{ row.durationLabel }}</span><span class="dtr-status" :class="`dtr-status-${row.status}`">{{ row.status }}</span><span class="dtr-chevron" aria-hidden="true">{{ open ? '⌄' : '›' }}</span></span>
      <span v-if="row.note" class="dtr-note">{{ row.note }}</span>
    </button>
    <div v-else class="dtr-main">
      <div class="dtr-summary"><span class="dtr-verb">{{ row.verb }}</span><span class="dtr-target" :class="{ 'dtr-code': row.targetIsCode }">{{ row.target }}</span><span v-if="row.keyArgs" class="dtr-args dtr-code">{{ row.keyArgs }}</span></div>
      <div class="dtr-meta"><span v-if="row.durationLabel" class="dtr-duration">{{ row.durationLabel }}</span><span class="dtr-status" :class="`dtr-status-${row.status}`">{{ row.status }}</span></div>
      <div v-if="row.note" class="dtr-note">{{ row.note }}</div>
    </div>
    <pre v-if="open && row.payload" class="dtr-payload">{{ payloadText }}</pre>
  </article>
</template>

<script setup lang="ts">
import { computed, inject, shallowRef, ref, watch, type Ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { AgentTraceHistoryData } from '@pkg/agent/app/Services/AgentTraceHistory';
import type { OpenSubAgentConversation } from '../subagent/subAgentConversation';
import { SubAgentTraceProjection } from './SubAgentTraceProjection';
import type { TraceRow as TraceRowModel } from './traceTypes';
import { TraceDisclosureController } from './traceDisclosure';

const props = defineProps<{ row: TraceRowModel }>();
const disclosure = inject('chat:trace-disclosure', new TraceDisclosureController());
const open = computed(() => disclosure.isOpen(props.row.id));
const icon = computed(() => ({ thought: '·', tool: '◆', memory: '◈', heartbeat: '◌', activity: '•', handoff: '↗', retry: '↻', approval: '!', usage: '◫', source: '↗', subagent: '•' }[props.row.kind] ?? '•'));
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
const initial = computed(() => (props.row.subagent?.agentId || props.row.target || '?')[0].toUpperCase());
const statusLabel = computed(() => props.row.status === 'quiet' ? 'no check-in' : props.row.status);
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
  return agent?.startedAt !== undefined && agent.endedAt === undefined &&
    (props.row.status === 'working' || props.row.status === 'running');
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
.dtr-row { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr) 88px 58px 20px; gap: 8px; padding: 5px 0; color: var(--text-secondary); font-size: 12px; }
.dtr-icon { color: var(--text-muted); text-align: center; font-size: 14px; }
.dtr-main { min-width: 0; border: 0; padding: 0; color: inherit; background: none; text-align: left; font: inherit; }
.dtr-disclosure { cursor: pointer; }
.dtr-summary { display: flex; min-width: 0; gap: 7px; align-items: baseline; }
.dtr-verb { color: var(--text-secondary); font-weight: 600; }
.dtr-target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dtr-code { font-family: var(--font-mono, ui-monospace, monospace); }
.dtr-args { color: var(--text-muted); }
.dtr-meta { display: grid; grid-template-columns: 88px 58px 20px; gap: 8px; align-items: center; white-space: nowrap; }
.dtr-duration { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.dtr-status { color: var(--text-muted); text-transform: lowercase; }
.dtr-status-failed { color: var(--status-error, #d66); }.dtr-status-waiting { color: var(--status-warning, #b88935); }.dtr-status-approved { color: var(--status-success, #57966a); }
.dtr-chevron { color: var(--text-muted); font-size: 16px; line-height: 12px; }
.dtr-note { margin-top: 3px; color: var(--text-muted); font-size: 11px; }
.dtr-payload { grid-column: 2 / -1; max-height: 240px; overflow: auto; margin: 4px 0 0; padding: 8px; color: var(--text-secondary); background: color-mix(in srgb, var(--bg-surface) 80%, var(--text-primary)); font: 11px/1.45 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; }
.dtr-agent { margin-top: 4px; padding: 5px 0; color: var(--text-secondary); }
.dtr-agent-head { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto minmax(68px, auto) 20px; gap: 8px; align-items: baseline; font-size: 13px; }
.dtr-agent-marker { justify-self: center; display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--border-default); color: var(--text-secondary); font: 600 10px/1 var(--font-body); }
.dtr-agent-reviewer { background: var(--bg-page); box-shadow: inset 0 0 0 1px var(--border-strong); }
.dtr-agent[data-status="starting"] .dtr-agent-marker, .dtr-agent[data-status="stopped"] .dtr-agent-marker { opacity: .55; }
.dtr-agent[data-status="failed"] .dtr-agent-marker { background: var(--status-error); color: var(--bg-page); box-shadow: none; }
.dtr-agent[data-status="blocked"] .dtr-agent-marker, .dtr-agent[data-status="quiet"] .dtr-agent-marker { background: var(--status-warning); color: var(--bg-page); box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-warning) 26%, transparent); }
.dtr-agent-identity { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.dtr-agent-label { color: var(--text-primary); font-weight: 500; }
.dtr-agent-id, .dtr-agent-time, .dtr-agent .dtr-duration { color: var(--text-muted); font: 11.5px var(--font-mono); }
.dtr-agent .dtr-status { white-space: nowrap; }
.dtr-status-working { color: var(--primary-color-text-override, var(--accent)); }
.dtr-status-working::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin: 0 6px 1px 0; animation: dtr-agent-breath 1.9s ease-in-out infinite; }
.dtr-status-blocked, .dtr-status-quiet { color: var(--status-warning); }
.dtr-status-returned { color: var(--status-success); }
@keyframes dtr-agent-breath { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dtr-status-working::before { animation: none; } }
.dtr-agent-note, .dtr-agent-meta, .dtr-agent-report { margin-left: 32px; }
.dtr-agent-note { margin-block: 2px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.45 var(--font-body); }
.dtr-agent-time { margin-right: 6px; }
.dtr-agent-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin-block: 2px 4px; color: var(--text-muted); font: 11.5px/18px var(--font-mono); overflow-wrap: anywhere; }
.dtr-agent button { padding: 0; border: 0; color: var(--text-secondary); background: none; cursor: pointer; }
.dtr-agent-meta button { font: 12.5px var(--font-body); text-decoration: underline; text-underline-offset: 3px; }
.dtr-agent button:hover { color: var(--text-primary); }
.dtr-agent button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.dtr-agent-chevron { line-height: 1; font-size: 17px; }
.dtr-agent-report { overflow-wrap: anywhere; }
</style>
