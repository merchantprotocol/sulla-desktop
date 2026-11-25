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
      <DecisionActorMarker :role="row.actorRole" :initials="row.actorInitial" />
      <div>
        <b v-if="row.current">{{ row.actionLabel }}</b>
        <template v-else><b>{{ row.actorLabel }}</b> {{ row.actionLabel }}</template>
        <p v-if="row.note" class="decision-trail__note">Note from {{ row.actorLabel }}: {{ row.note }}</p>
      </div>
    </li>
  </ol>
</template>

<script setup lang="ts">
import type { DecisionRouteTrailRow } from '../../decisions/DecisionRoutePresenter';
import DecisionActorMarker from '../../decisions/DecisionActorMarker.vue';

defineProps<{ rows: readonly DecisionRouteTrailRow[] }>();
</script>

<style scoped>
.decision-trail { list-style: none; margin: 8px 0 0; padding: 0; color: var(--text-secondary); font-size: 12.5px; line-height: 20px; }
.decision-trail li { display: grid; grid-template-columns: 54px 18px minmax(0, 1fr); column-gap: 8px; align-items: start; padding: 1px 0; }
.decision-trail time { color: var(--text-muted); font: 11px/20px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.decision-trail :deep(.decision-actor-marker__agent), .decision-trail :deep(.decision-actor-marker__you) { margin-top: 1px; }
.decision-trail b { color: var(--text-primary); font-weight: 500; }
.decision-trail li[aria-current="step"] { color: var(--text-primary); }
.decision-trail__note { margin: 2px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
@media (max-width: 600px) { .decision-trail li { grid-template-columns: 50px 18px minmax(0, 1fr); column-gap: 6px; } }
</style>
