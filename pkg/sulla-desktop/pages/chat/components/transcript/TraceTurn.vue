<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <section class="dtr-turn" aria-label="Detailed trace">
    <div v-if="turn.usage" class="dtr-header">
      <span class="dtr-header-label">Trace</span>
      <span v-if="turn.usage.model">{{ turn.usage.model }}</span>
      <span v-if="turn.usage.totalTokens">{{ turn.usage.totalTokens }} tokens</span>
      <span v-if="turn.usage.durationLabel">{{ turn.usage.durationLabel }}</span>
    </div>
    <div v-for="row in turn.rows" :key="row.id" :class="{ 'dtr-thought': row.kind === 'thought' }">
      <p v-if="row.kind === 'thought'" class="dtr-thought-text">{{ row.note || row.target }}</p>
      <TraceRow v-else :row="row" />
    </div>
  </section>
</template>

<script setup lang="ts">
import TraceRow from './TraceRow.vue';
import type { TraceTurn as TraceTurnModel } from './traceTypes';
defineProps<{ turn: TraceTurnModel }>();
</script>

<style scoped>
.dtr-turn { margin: 3px 0 8px; padding: 0 0 0 4px; border-left: 1px solid var(--border-muted); }
.dtr-header { display: flex; gap: 10px; align-items: baseline; padding: 4px 0 4px 42px; color: var(--text-muted); font: 10px var(--font-mono, ui-monospace, monospace); }
.dtr-header-label { color: var(--text-secondary); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
.dtr-thought-text { margin: 4px 0; padding-left: 42px; color: var(--text-muted); font-size: 12px; }
</style>
