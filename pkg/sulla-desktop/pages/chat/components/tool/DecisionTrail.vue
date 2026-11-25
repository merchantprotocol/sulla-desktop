<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <ol class="decision-trail" aria-label="Trail so far">
    <li v-for="row in rows" :key="row.key" :aria-current="row.current ? 'step' : undefined">
      <time :datetime="row.timestamp ? new Date(row.timestamp).toISOString() : undefined">{{ row.time }}</time>
      <span class="decision-trail__avatar" :data-human="row.actorKind === 'human'">{{ row.actorInitial }}</span>
      <div>
        <b>{{ row.actorLabel }}</b> {{ row.actionLabel }}
        <p v-if="row.note" class="decision-trail__note">Note from {{ row.actorLabel }}: {{ row.note }}</p>
      </div>
    </li>
  </ol>
</template>

<script setup lang="ts">
import type { DecisionRouteTrailRow } from '../../decisions/DecisionRoutePresenter';

defineProps<{ rows: readonly DecisionRouteTrailRow[] }>();
</script>

<style scoped>
.decision-trail { list-style: none; margin: 8px 0 0; padding: 0; color: var(--text-secondary); font-size: 12.5px; line-height: 20px; }
.decision-trail li { display: grid; grid-template-columns: 54px 18px minmax(0, 1fr); column-gap: 8px; align-items: start; padding: 1px 0; }
.decision-trail time { color: var(--text-muted); font: 11px/20px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.decision-trail__avatar { display: grid; place-items: center; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface)); color: var(--accent); font-size: 10px; font-weight: 700; }
.decision-trail__avatar[data-human="true"] { background: color-mix(in srgb, var(--status-success) 14%, var(--bg-surface)); color: var(--status-success); }
.decision-trail b { color: var(--text-primary); font-weight: 500; }
.decision-trail li[aria-current="step"] { color: var(--text-primary); }
.decision-trail__note { margin: 2px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
</style>
