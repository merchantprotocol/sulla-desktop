<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <WorkerChartMarker
    v-if="role !== 'you'"
    :state="null"
    :initials="initials"
    :role="role"
    class="decision-actor-marker__agent"
  />
  <span v-else class="decision-actor-marker__you" aria-hidden="true">{{ initials }}</span>
</template>

<script setup lang="ts">
import type { DecisionRouteActorRole } from './DecisionRoutePresenter';
import WorkerChartMarker from '../components/workerChart/WorkerChartMarker.vue';

defineProps<{ role: DecisionRouteActorRole; initials: string }>();
</script>

<style scoped>
.decision-actor-marker__agent, .decision-actor-marker__you { display: inline-grid; place-items: center; width: 18px; height: 18px; flex: none; border-radius: 50%; font: 600 10px/1 ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif; letter-spacing: 0; }
.decision-actor-marker__agent[data-role="main"] { background: var(--accent); color: var(--text-on-accent, #fff); }
.decision-actor-marker__agent[data-role="mgr"] { background: color-mix(in srgb, var(--accent) 18%, var(--bg-surface)); color: var(--accent); }
.decision-actor-marker__agent[data-role="wrk"] { background: var(--border-default); color: var(--text-secondary); }
.decision-actor-marker__agent[data-role="rev"] { box-shadow: inset 0 0 0 1px var(--border-strong); color: var(--text-secondary); background: var(--bg-surface); }
.decision-actor-marker__you { box-shadow: inset 0 0 0 1.5px var(--text-primary); color: var(--text-primary); }
.decision-actor-marker__agent :deep(.worker-chart__ring) { display: none; }
</style>
