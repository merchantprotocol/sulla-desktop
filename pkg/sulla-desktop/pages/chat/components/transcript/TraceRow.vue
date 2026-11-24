<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <article class="dtr-row" :class="`dtr-row-${row.kind}`">
    <div class="dtr-rail" aria-hidden="true"><span class="dtr-dot" /></div>
    <div class="dtr-icon" aria-hidden="true">{{ icon }}</div>
    <button v-if="row.rawPayload" class="dtr-main dtr-disclosure" type="button" :aria-expanded="open" @click="toggle" @keydown.enter.prevent="toggle" @keydown.space.prevent="toggle">
      <span class="dtr-summary"><span class="dtr-verb">{{ row.verb }}</span><span class="dtr-target" :class="{ 'dtr-code': row.targetIsCode }">{{ row.target }}</span><span v-if="row.keyArgs" class="dtr-args dtr-code">{{ row.keyArgs }}</span></span>
      <span class="dtr-meta"><span v-if="row.durationLabel" class="dtr-duration">{{ row.durationLabel }}</span><span class="dtr-status" :class="`dtr-status-${row.status}`">{{ row.status }}</span><span class="dtr-chevron" aria-hidden="true">{{ open ? '⌄' : '›' }}</span></span>
      <span v-if="row.note" class="dtr-note">{{ row.note }}</span>
    </button>
    <div v-else class="dtr-main">
      <div class="dtr-summary"><span class="dtr-verb">{{ row.verb }}</span><span class="dtr-target" :class="{ 'dtr-code': row.targetIsCode }">{{ row.target }}</span><span v-if="row.keyArgs" class="dtr-args dtr-code">{{ row.keyArgs }}</span></div>
      <div class="dtr-meta"><span v-if="row.durationLabel" class="dtr-duration">{{ row.durationLabel }}</span><span class="dtr-status" :class="`dtr-status-${row.status}`">{{ row.status }}</span></div>
      <div v-if="row.note" class="dtr-note">{{ row.note }}</div>
    </div>
    <pre v-if="open && row.rawPayload" class="dtr-payload">{{ row.rawPayload }}</pre>
  </article>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue';
import type { TraceRow as TraceRowModel } from './traceTypes';
import { TraceDisclosureController } from './traceDisclosure';

const props = defineProps<{ row: TraceRowModel }>();
const disclosure = inject('chat:trace-disclosure', new TraceDisclosureController());
const open = computed(() => disclosure.isOpen(props.row.id));
const icon = computed(() => ({ thought: '·', tool: '◆', memory: '◈', heartbeat: '◌', activity: '•', handoff: '↗', retry: '↻', approval: '!', usage: '◫', source: '↗' }[props.row.kind] ?? '•'));
function toggle(): void { disclosure.toggle(props.row.id); }
</script>

<style scoped>
.dtr-row { position: relative; display: grid; grid-template-columns: 18px 24px minmax(0, 1fr); gap: 8px; padding: 5px 0; color: var(--text-secondary); font-size: 12px; }
.dtr-rail { position: relative; display: flex; justify-content: center; }
.dtr-rail::before { content: ''; position: absolute; top: -8px; bottom: -8px; width: 1px; background: var(--border-muted); }
.dtr-dot { z-index: 1; width: 6px; height: 6px; margin-top: 5px; border-radius: 50%; background: var(--text-muted); }
.dtr-icon { color: var(--text-muted); text-align: center; font-size: 14px; }
.dtr-main { min-width: 0; border: 0; padding: 0; color: inherit; background: none; text-align: left; font: inherit; }
.dtr-disclosure { cursor: pointer; }
.dtr-summary { display: flex; min-width: 0; gap: 7px; align-items: baseline; }
.dtr-verb { color: var(--text-secondary); font-weight: 600; }
.dtr-target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dtr-code { font-family: var(--font-mono, ui-monospace, monospace); }
.dtr-args { color: var(--text-muted); }
.dtr-meta { display: inline-flex; float: right; gap: 8px; align-items: center; margin-left: 8px; white-space: nowrap; }
.dtr-duration { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.dtr-status { color: var(--text-muted); text-transform: lowercase; }
.dtr-status-failed { color: var(--status-error, #d66); }.dtr-status-waiting { color: var(--status-warning, #b88935); }.dtr-status-approved { color: var(--status-success, #57966a); }
.dtr-chevron { color: var(--text-muted); font-size: 16px; line-height: 12px; }
.dtr-note { margin-top: 3px; color: var(--text-muted); font-size: 11px; }
.dtr-payload { grid-column: 3; max-height: 240px; overflow: auto; margin: 4px 0 0; padding: 8px; color: var(--text-secondary); background: color-mix(in srgb, var(--bg-surface) 80%, var(--text-primary)); font: 11px/1.45 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; }
</style>
