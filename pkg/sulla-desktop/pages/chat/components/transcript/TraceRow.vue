<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <li class="trace-row" :data-kind="row.kind" :data-status="row.status">
    <div class="trace-row__line">
      <span class="trace-row__icon" aria-hidden="true">{{ icon }}</span>
      <div class="trace-row__what">
        <span class="trace-row__verb">{{ row.verb }}</span>
        <code class="trace-row__target">{{ row.target }}</code>
        <code v-if="row.args" class="trace-row__args">{{ row.args }}</code>
      </div>
      <span class="trace-row__meta">
        <span v-if="row.durationMs !== undefined" class="trace-row__duration">{{ durationLabel }}</span>
        <span v-if="row.status" class="trace-row__status" :data-status="row.status">{{ statusLabel }}</span>
      </span>
      <button
        v-if="row.rawPayload"
        class="trace-row__expand"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="payloadId"
        :aria-label="`${expanded ? 'Hide' : 'Show'} raw payload for ${row.verb} ${row.target}`"
        @click="expanded = !expanded"
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
    <p v-if="row.note" class="trace-row__note">{{ row.note }}</p>
    <pre v-if="row.rawPayload" :id="payloadId" class="trace-row__payload" :hidden="!expanded" tabindex="0">{{ row.rawPayload }}</pre>
  </li>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { DetailedTraceRow } from './DetailedTraceProjection';

const props = defineProps<{ row: DetailedTraceRow }>();
const expanded = ref(false);
const payloadId = computed(() => `trace-payload-${props.row.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
const icons: Record<DetailedTraceRow['kind'], string> = {
  thought: '·', tool: '›', file: '□', read: '⌕', search: '⌕', memory: '◈', handoff: '↗',
  result: '↙', approval: '✓', question: '?', agent: '↳', error: '!', notice: 'i', heartbeat: '♥',
};
const icon = computed(() => icons[props.row.kind]);
const statusLabel = computed(() => ({
  ok: 'ok', running: 'running', failed: 'failed', waiting: 'waiting', approved: 'approved',
  denied: 'denied', stopped: 'stopped', cancelled: 'cancelled',
}[props.row.status ?? 'ok']));
const durationLabel = computed(() => {
  const duration = props.row.durationMs ?? 0;
  if (duration < 1_000) return `${Math.round(duration)}ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(duration / 60_000);
  const seconds = Math.round((duration % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
});
</script>

<style scoped>
.trace-row { position: relative; min-width: 0; padding: 2px 0; scroll-margin-top: 16px; }
.trace-row__line {
  display: grid; grid-template-columns: 24px minmax(0, 1fr) auto 24px; column-gap: 10px;
  align-items: start; border-radius: 6px; min-width: 0;
}
.trace-row__icon {
  grid-column: 1; grid-row: 1; width: 24px; height: 24px; display: grid; place-items: center;
  border-radius: 50%; background: var(--bg-primary, var(--bg-page)); color: var(--text-muted); font-size: 14px;
}
.trace-row__what {
  grid-column: 2; grid-row: 1; min-width: 0; padding: 2px 0; font-size: 13px; line-height: 20px;
  overflow-wrap: anywhere;
}
.trace-row__verb { color: var(--text-primary); font-weight: 500; }
.trace-row__target {
  margin-inline-start: 5px; color: var(--text-primary); font: inherit; overflow-wrap: anywhere;
}
.trace-row__args {
  display: inline; margin-inline-start: 6px; color: var(--text-muted); font: 11.5px var(--font-mono);
  overflow-wrap: anywhere;
}
.trace-row__meta {
  grid-column: 3; grid-row: 1; display: flex; gap: 10px; white-space: nowrap; font-size: 12px;
  line-height: 24px; font-variant-numeric: tabular-nums; color: var(--text-muted);
}
.trace-row__duration { min-width: 54px; text-align: right; }
.trace-row__status { min-width: 60px; }
.trace-row__status[data-status="failed"] { color: var(--text-error); font-weight: 500; }
.trace-row__status[data-status="waiting"], .trace-row__status[data-status="denied"] { color: var(--text-warning); font-weight: 500; }
.trace-row__status[data-status="approved"] { color: var(--text-success); font-weight: 500; }
.trace-row__expand {
  grid-column: 4; grid-row: 1; width: 24px; height: 24px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text-muted); cursor: pointer; font: 20px/20px var(--font-body);
}
.trace-row__expand:hover { background: var(--bg-surface); color: var(--text-primary); }
.trace-row__expand:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.trace-row__expand[aria-expanded="true"] span { display: inline-block; transform: rotate(90deg); }
.trace-row__note {
  margin: 0 34px 2px; min-width: 0; color: var(--text-secondary); font-size: 13px; line-height: 19px;
  overflow-wrap: anywhere;
}
.trace-row[data-status="failed"] .trace-row__note { color: var(--text-primary); }
.trace-row__payload {
  margin: 4px 34px 8px; min-width: 0; max-width: calc(100% - 34px); padding: 10px 12px;
  border-radius: 8px; background: var(--bg-surface); color: var(--text-primary);
  font: 12px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
.trace-row__payload[hidden] { display: none; }
@media (max-width: 600px) {
  .trace-row__line { grid-template-columns: 24px minmax(0, 1fr) 24px; }
  .trace-row__meta { grid-column: 2; grid-row: 2; line-height: 18px; padding-bottom: 2px; }
  .trace-row__duration { min-width: 0; text-align: left; }
  .trace-row__status { min-width: 0; }
  .trace-row__expand { grid-column: 3; }
  .trace-row__note, .trace-row__payload { margin-right: 0; }
  .trace-row__payload { max-width: 100%; }
}
</style>
