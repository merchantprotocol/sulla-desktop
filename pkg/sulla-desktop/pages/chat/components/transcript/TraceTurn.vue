<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <section class="trace-turn" :aria-label="`${turn.metadata.agent ?? 'Agent'} detailed trace`">
    <div class="trace-turn__metadata">
      <strong v-if="turn.metadata.agent">{{ turn.metadata.agent }}</strong>
      <time v-if="startedAt" :datetime="startedAt.iso">{{ startedAt.label }}</time>
      <code v-if="turn.metadata.model">{{ turn.metadata.model }}</code>
      <span v-if="durationLabel">{{ durationLabel }}</span>
      <span v-if="tokenLabel">{{ tokenLabel }}</span>
      <span v-if="turn.metadata.steps !== undefined">{{ turn.metadata.steps }} {{ turn.metadata.steps === 1 ? 'step' : 'steps' }}</span>
      <span v-if="turn.metadata.files !== undefined">{{ turn.metadata.files }} {{ turn.metadata.files === 1 ? 'file' : 'files' }}</span>
      <span v-if="turn.metadata.failures" class="trace-turn__failure">{{ turn.metadata.failures }} {{ turn.metadata.failures === 1 ? 'failed' : 'failures' }}</span>
    </div>
    <ol class="trace-turn__rail">
      <TraceRow v-for="row in turn.rows" :key="row.id" :row="row" :expand-all="expandAll" />
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import TraceRow from './TraceRow.vue';
import type { DetailedTraceTurn } from './DetailedTraceProjection';

const props = withDefaults(defineProps<{ turn: DetailedTraceTurn; expandAll?: boolean }>(), { expandAll: false });
const startedAt = computed(() => {
  const value = props.turn.metadata.startedAt;
  const date = new Date(value ?? Number.NaN);
  return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), label: date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } : undefined;
});
const durationLabel = computed(() => {
  const duration = props.turn.metadata.durationMs;
  if (duration === undefined || !Number.isFinite(duration)) return undefined;
  if (duration < 1_000) return `${Math.round(duration)}ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(1)}s`;
  return `${Math.floor(duration / 60_000)}m ${Math.round((duration % 60_000) / 1_000)}s`;
});
const tokenLabel = computed(() => {
  const input = props.turn.metadata.inputTokens;
  const output = props.turn.metadata.outputTokens;
  if (input === undefined && output === undefined) return undefined;
  const count = (value: number | undefined) => value === undefined ? undefined : new Intl.NumberFormat().format(value);
  if (input !== undefined && output !== undefined) return `${count(input)} in · ${count(output)} out tokens`;
  return input !== undefined ? `${count(input)} input tokens` : `${count(output)} output tokens`;
});
</script>

<style scoped>
.trace-turn { min-width: 0; margin: 8px 0 14px; }
.trace-turn__metadata {
  display: flex; min-width: 0; flex-wrap: wrap; align-items: baseline; gap: 2px 14px;
  padding-inline-start: 34px; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.trace-turn__metadata strong { color: var(--text-primary); font-size: 13px; font-weight: 600; }
.trace-turn__metadata code { font: 11.5px var(--font-mono); overflow-wrap: anywhere; }
.trace-turn__failure { color: var(--text-error); }
.trace-turn__rail { position: relative; list-style: none; min-width: 0; margin: 6px 0 0; padding: 0; }
.trace-turn__rail::before {
  position: absolute; top: 14px; bottom: 14px; inset-inline-start: 11.5px; width: 1px;
  background: var(--border-default); content: '';
}
</style>
