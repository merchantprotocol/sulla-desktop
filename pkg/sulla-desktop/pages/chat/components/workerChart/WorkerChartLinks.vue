<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="worker-chart__links" :style="{ height: `${contentHeight}px` }" aria-hidden="true">
    <span
      v-for="link in links"
      :key="link.key"
      class="worker-chart__link"
      :class="`worker-chart__link--${link.kind}`"
      :style="link.kind === 'stem'
        ? { left: `${link.x}px`, top: `${link.y}px`, transform: `scaleY(${link.scaleY})` }
        : { left: `${link.x}px`, top: `${link.y}px` }"
    />
  </div>
</template>

<script setup lang="ts">
import type { WorkerChartLink } from './workerChartModel';

defineProps<{ links: readonly WorkerChartLink[]; contentHeight: number }>();
</script>
