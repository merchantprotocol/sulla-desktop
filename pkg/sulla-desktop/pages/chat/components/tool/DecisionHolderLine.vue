<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="decision-holder" :class="`decision-holder-${presentation.turn}`" :data-compact="compact" :data-tone="presentation.settledTone">
    <span class="decision-holder__identity">
      <DecisionActorMarker :role="presentation.holderRole" :initials="presentation.holderInitial" />
      <span class="decision-holder__primary">{{ compact ? presentation.compactLine : presentation.holderLine }}</span>
    </span>
    <span v-if="compact ? presentation.compactSecondaryLine : presentation.secondaryLine" class="decision-holder__secondary">
      {{ compact ? presentation.compactSecondaryLine : presentation.secondaryLine }}
    </span>
  </div>
</template>

<script setup lang="ts">
import type { DecisionRoutePresentation } from '../../decisions/DecisionRoutePresenter';
import DecisionActorMarker from '../../decisions/DecisionActorMarker.vue';

defineProps<{ presentation: DecisionRoutePresentation; compact?: boolean }>();
</script>

<style scoped>
.decision-holder { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; min-width: 0; font-size: 12.5px; line-height: 20px; }
.decision-holder__identity { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.decision-holder__primary { color: var(--text-primary); font-weight: 600; }
.decision-holder__secondary { color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.decision-holder-yours .decision-holder__primary { color: var(--status-warning); }
.decision-holder-settled .decision-holder__primary { color: var(--text-primary); }
.decision-holder[data-compact="true"] { justify-content: flex-start; gap: 7px; font-size: 12.5px; line-height: 18px; }
.decision-holder[data-compact="true"] .decision-holder__primary { font-weight: 500; }
.decision-holder[data-compact="true"] .decision-holder__secondary { display: block; width: 100%; margin-left: 25px; }
</style>
