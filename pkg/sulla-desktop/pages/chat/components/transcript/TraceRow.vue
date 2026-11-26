<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <li v-if="row.kind === 'thought'" class="dtr-row" data-kind="thought">
    <div class="dtr-line">
      <span class="dtr-ic" aria-hidden="true"><svg viewBox="0 0 16 16" v-html="icon" /></span>
      <div class="dtr-what">{{ row.note || row.target }}</div>
    </div>
  </li>
  <li v-else-if="row.subagent && row.kind === 'subagent'" class="dtr-row dtr-agent" data-kind="agent" :data-status="row.status">
    <div class="dtr-line">
      <span class="dtr-ic">
        <span class="dtr-marker" :data-role="row.subagent.isReviewer ? 'rev' : 'wrk'" :data-status="row.status" aria-hidden="true">{{ row.subagent.marker }}</span>
      </span>
      <div class="dtr-what"><span v-if="row.verb" class="dtr-verb">{{ row.verb }}</span><span class="dtr-tg">{{ row.target }}</span><span v-if="row.subagent.agentId" class="dtr-agent-id">{{ row.subagent.agentId }}</span></div>
      <span class="dtr-m"><span class="dtr-dur">{{ duration }}</span><span class="dtr-st" :data-s="row.status">{{ statusLabel }}</span></span>
      <button
        type="button" class="dtr-x" :aria-expanded="open" :aria-controls="payloadId"
        :aria-label="`Brief, check-ins and report for ${row.target}`"
        @click="toggle"
      ><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></button>
    </div>
    <p v-if="row.note || row.subagent.followUpOf" class="dtr-note">
      <time v-if="noteTime" class="dtr-when">{{ noteTime }}</time><span v-if="row.subagent.followUpOf">Follow-up of job {{ row.subagent.followUpOf.jobId }} task {{ row.subagent.followUpOf.taskIndex }}.{{ row.note ? ' ' : '' }}</span>{{ row.note }}
    </p>
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
      <span class="dtr-m"><span class="dtr-dur">{{ row.kind === 'handoff' && row.subagent ? duration : row.durationLabel }}</span><span class="dtr-st" :data-s="row.status">{{ row.status }}</span></span>
      <button
        v-if="row.payload" type="button" class="dtr-x" :aria-expanded="open" :aria-controls="payloadId"
        :aria-label="`Raw payload for ${row.verb} ${row.target}`"
        @click="toggle"
      ><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></button>
    </div>
    <p v-if="row.note" class="dtr-note">{{ row.note }}</p>
    <p v-if="open && toolPayloadLoading" class="dtr-note" role="status">Loading the complete tool result…</p>
    <p v-if="open && toolPayloadError" class="dtr-note" role="status">
      The complete tool result could not be loaded from the conversation log.
      <button type="button" class="dtr-retry" @click="loadToolPayload">Retry</button>
    </p>
    <div v-if="open && payloadImages.length" class="dtr-images">
      <figure v-for="image in payloadImages" :key="image.alt"><img :src="image.src" :alt="image.alt" /></figure>
    </div>
    <pre v-if="open && row.payload" :id="payloadId" class="dtr-raw" tabindex="0">{{ payloadText }}</pre>
    <p v-if="open && row.subagent && historyError" class="dtr-note" role="status">Check-in history could not be loaded.</p>
    <div v-if="open && row.subagent" class="dtr-agent-meta">
      <span v-if="agentMeta">{{ agentMeta }}</span>
      <button v-if="row.subagent.conversationId && openConversation" type="button" @click="openAgent">Open agent</button>
    </div>
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
import { TracePayloadSerializer } from './TracePayloadSerializer';

const props = defineProps<{ row: TraceRowModel }>();
const disclosure = inject('chat:trace-disclosure', new TraceDisclosureController());
const open = computed(() => disclosure.isOpen(props.row.id));
// Static icon paths from the approved mockup; never built from row data.
const icons = {
  thought: '<path d="M3 3.5h10v7H7.5L5 12.8v-2.3H3z"/>',
  browser: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.8 1.6 1.8 9.4 0 11M8 2.5c-1.8 1.6-1.8 9.4 0 11"/>',
  shell: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5 7 8 5 9.5M8.5 10H11"/>',
  file: '<path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3"/>',
  edit: '<path d="M3 13l.6-2.8L10.8 3l2.2 2.2-7.2 7.2zM9.5 4.3l2.2 2.2"/>',
  memory: '<path d="M4.5 2.5h7v11L8 11l-3.5 2.5z"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
  read: '<path d="M8 4.2C6.5 3.2 4.5 3 2.5 3.4v8.4c2-.4 4-.2 5.5.8 1.5-1 3.5-1.2 5.5-.8V3.4c-2-.4-4-.2-5.5.8zM8 4.2v8.4"/>',
  handoff: '<path d="M2.5 8h9M8.5 4.5 12 8l-3.5 3.5M13.5 3.5v9"/>',
  result: '<path d="M13.5 8h-9M7.5 4.5 4 8l3.5 3.5M2.5 3.5v9"/>',
  retry: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 3v2.6h-2.6"/>',
  approval: '<path d="M8 2.5 3 4.3v3.6c0 2.7 2 4.8 5 5.6 3-.8 5-2.9 5-5.6V4.3zM8 6v2.5M8 10.4v.1"/>',
  dot: '<circle cx="8" cy="8" r="2"/>',
} as const;
const icon = computed(() => icons[props.row.icon]);
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
// A pointer-backed payload supplements the card's own arguments; its loader only supplies the stored result.
const payloadSerializer = new TracePayloadSerializer();
const loadedPresentation = shallowRef<ReturnType<TracePayloadSerializer['present']> | null>(null);
const toolPayloadLoading = ref(false);
const toolPayloadError = ref(false);
let loadGeneration = 0;
async function loadToolPayload(): Promise<void> {
  const payload = props.row.payload;
  if (!payload?.load) return;
  const generation = ++loadGeneration;
  toolPayloadLoading.value = true;
  toolPayloadError.value = false;
  try {
    const value = await payload.load();
    if (generation === loadGeneration && open.value && props.row.payload === payload) {
      loadedPresentation.value = payloadSerializer.present(value);
    }
  } catch {
    if (generation === loadGeneration) toolPayloadError.value = true;
  } finally {
    if (generation === loadGeneration) toolPayloadLoading.value = false;
  }
}
watch([open, () => props.row.payload], ([expanded, payload], _, onCleanup) => {
  loadedPresentation.value = null;
  toolPayloadError.value = false;
  toolPayloadLoading.value = false;
  if (!expanded || !payload?.load) { loadGeneration++; return; }
  onCleanup(() => { loadGeneration++; });
  void loadToolPayload();
}, { immediate: true });
const payloadPresentation = computed(() => loadedPresentation.value ?? payloadSerializer.present(
  payloadSource.value.payload?.serialize(history.value?.checkins, history.value?.messages) ?? '',
));
const payloadImages = computed(() => payloadPresentation.value.images);
const payloadText = computed(() => payloadPresentation.value.text);
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
  return (props.row.kind === 'subagent' || props.row.kind === 'handoff') && agent?.startedAt !== undefined && agent.endedAt === undefined &&
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
.dtr-row { position: relative; padding: 2px 0; list-style: none; scroll-margin-top: 16px; }
.dtr-row:target .dtr-line, .dtr-row.dtr-flash .dtr-line { background: color-mix(in oklab, var(--accent) 8%, transparent); }
.dtr-row[data-kind="thought"] { margin-top: 6px; }
.dtr-row[data-kind="thought"]:first-child { margin-top: 0; }
.dtr-line { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto 24px; column-gap: 10px; align-items: start; border-radius: 6px; transition: background .24s cubic-bezier(.22, 1, .36, 1); }
.dtr-ic { position: relative; z-index: 1; grid-column: 1; grid-row: 1; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: var(--bg-page); color: var(--text-muted); }
.dtr-ic svg, .dtr-x svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.dtr-what { grid-column: 2; grid-row: 1; min-width: 0; padding: 2px 0; color: var(--text-secondary); font: 13px/20px var(--font-body); overflow-wrap: anywhere; }
.dtr-row[data-kind="thought"] .dtr-what { grid-column: 2 / -1; }
.dtr-verb { color: var(--text-primary); font-weight: 500; }
.dtr-tg { color: var(--text-primary); }
code.dtr-tg { padding: 1px 5px; border-radius: 5px; background: var(--bg-surface); font: 12.5px var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
.dtr-args { display: inline-block; max-width: 100%; margin-left: 6px; color: var(--text-muted); font: 11.5px var(--font-mono, ui-monospace, monospace); overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; white-space: nowrap; }
.dtr-cite { margin-right: 6px; color: var(--primary-color-text-override, var(--accent)); font: 11.5px var(--font-mono, ui-monospace, monospace); }
.dtr-m { grid-column: 3; grid-row: 1; display: flex; gap: 10px; font-size: 12px; line-height: 24px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dtr-dur { width: 54px; text-align: right; color: var(--text-muted); }
.dtr-st { width: 60px; color: var(--text-muted); }
.dtr-st[data-s="failed"] { color: var(--status-error); font-weight: 500; }
.dtr-st[data-s="waiting"], .dtr-st[data-s="blocked"], .dtr-st[data-s="quiet"] { color: var(--status-warning); font-weight: 500; }
.dtr-st[data-s="returned"], .dtr-st[data-s="approved"] { color: var(--status-success); font-weight: 500; }
.dtr-st[data-s="working"] { color: var(--primary-color-text-override, var(--accent)); font-weight: 500; }
.dtr-st[data-s="working"]::before { content: ''; display: inline-block; width: 6px; height: 6px; margin: 0 6px 1px 0; border-radius: 50%; background: currentColor; vertical-align: middle; animation: dtr-breath 1.9s cubic-bezier(.45, 0, .55, 1) infinite; }
@keyframes dtr-breath { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
.dtr-row[data-status="failed"] .dtr-ic { color: var(--status-error); }
.dtr-row[data-status="waiting"] .dtr-ic { color: var(--status-warning); }
.dtr-x { grid-column: 4; grid-row: 1; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer; }
.dtr-x:hover { background: var(--bg-surface); color: var(--text-primary); }
.dtr-x svg { width: 14px; height: 14px; transition: transform .16s cubic-bezier(.22, 1, .36, 1); }
.dtr-x[aria-expanded="true"] svg { transform: rotate(90deg); }
.dtr-note { margin: 0 34px 2px; color: var(--text-secondary); font: 13px/19px var(--font-body); white-space: pre-wrap; overflow-wrap: anywhere; }
.dtr-row[data-status="failed"] .dtr-note, .dtr-row[data-status="blocked"] .dtr-note { color: var(--text-primary); }
.dtr-raw { margin: 4px 34px 8px; padding: 10px 12px; border-radius: 8px; background: var(--bg-surface); color: var(--text-primary); font: 12px/1.6 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
/* Sub-agent row: marker is the worker chart's agent marker; row spacing follows the shared rail grammar. */
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
.dtr-retry { margin-left: 8px; border: 0; padding: 0; background: none; color: var(--primary-color-text-override, var(--accent)); font: inherit; text-decoration: underline; cursor: pointer; }
.dtr-images { display: grid; gap: 8px; margin: 4px 34px 8px; }
.dtr-images figure { margin: 0; }
.dtr-images img { max-width: 100%; height: auto; }
@media (max-width: 600px) {
  .dtr-line { grid-template-columns: 24px minmax(0, 1fr) 24px; }
  .dtr-m { grid-column: 2; grid-row: 2; line-height: 18px; padding-bottom: 2px; }
  .dtr-dur { width: auto; text-align: left; } .dtr-st { width: auto; }
  .dtr-x { grid-column: 3; }
  .dtr-note, .dtr-raw, .dtr-agent-meta { margin-right: 0; }
}
@media (prefers-reduced-motion: reduce) { .dtr-st[data-s="working"]::before { animation: none; } .dtr-x svg { transition: none; } }
</style>
