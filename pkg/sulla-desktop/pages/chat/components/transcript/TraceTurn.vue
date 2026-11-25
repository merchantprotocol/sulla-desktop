<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <section class="dtr-turn" aria-label="Detailed trace">
    <div v-if="turn.usage || turn.agentSummary || turn.sourceCount || turn.waitingOnYou" class="dtr-th">
      <code v-if="turn.usage?.model">{{ turn.usage.model }}</code>
      <span v-if="turn.usage?.durationLabel">{{ turn.usage.durationLabel }}</span>
      <span v-if="turn.usage?.totalTokens">{{ turn.usage.totalTokens.toLocaleString() }} tokens</span>
      <span v-if="turn.agentSummary">{{ turn.agentSummary }}</span>
      <span v-if="turn.sourceCount">{{ turn.sourceCount }} {{ turn.sourceCount === 1 ? 'source' : 'sources' }} cited</span>
      <span v-if="turn.waitingOnYou" class="dtr-th-waiting">waiting on you</span>
    </div>
    <ol v-if="turn.rows.length" class="dtr-trace">
      <template v-for="row in turn.rows" :key="row.id">
        <li v-if="row.kind === 'thought'" class="dtr-thought">
          <span class="dtr-thought-ic" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 3.5h10v7H7.5L5 12.8v-2.3H3z" /></svg></span>
          <span class="dtr-thought-text">{{ row.note || row.target }}</span>
        </li>
        <TraceRow v-else :row="row" />
      </template>
    </ol>
  </section>
</template>

<script setup lang="ts">
import TraceRow from './TraceRow.vue';
import type { TraceTurn as TraceTurnModel } from './traceTypes';
defineProps<{ turn: TraceTurnModel }>();
</script>

<style scoped>
/* Approved Detailed trace: header at the 34px text inset, one 1px line through the icon column. */
.dtr-turn { margin: 8px 0; }
.dtr-th { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; padding-left: 34px; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.dtr-th-waiting { color: var(--status-warning); font-weight: 500; }
.dtr-th code { font: 11.5px var(--font-mono, ui-monospace, monospace); }
.dtr-trace { position: relative; margin: 6px 0 0; padding: 0; list-style: none; }
.dtr-trace::before { content: ''; position: absolute; left: 11.5px; top: 14px; bottom: 14px; width: 1px; background: var(--border-muted); }
.dtr-thought { display: grid; grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; align-items: start; margin-top: 6px; padding: 2px 0; }
.dtr-thought:first-child { margin-top: 0; }
.dtr-thought-ic { position: relative; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: var(--bg-page); color: var(--text-muted); }
.dtr-thought-ic svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.dtr-thought-text { padding: 2px 0; color: var(--text-secondary); font: 13px/20px var(--font-body); overflow-wrap: anywhere; }
</style>
