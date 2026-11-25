<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="worker-chart__activity">
    <div class="worker-chart__spark" role="img" aria-label="Activity over the last 2.5 minutes">
      <i
        v-for="(value, index) in values"
        :key="index"
        class="worker-chart__activity-bar"
        :style="{ transform: `scaleY(${buckets.scale(value).toFixed(2)})` }"
      />
    </div>
    <div class="worker-chart__spark-label"><span>Activity</span><span>last 2.5 min</span></div>
  </div>
</template>

<script setup lang="ts">
import { WorkerChartActivityBuckets } from './workerChartModel';

defineProps<{ values: readonly number[] }>();
const buckets = new WorkerChartActivityBuckets();
</script>
