<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <span
    class="worker-chart__marker"
    :class="{ 'worker-chart__marker--ping': pulsedAfterMount }"
    :data-role="role"
    :data-state="visualState"
    aria-hidden="true"
  >
    <svg v-if="state === 'done'" viewBox="0 0 10 10"><path d="M2 5.300 4.200 7.500 8 3" /></svg>
    <svg v-else-if="state === 'failed'" viewBox="0 0 10 10"><path d="M2.500 2.500l5 5M7.500 2.500l-5 5" /></svg>
    <span v-else>{{ state === 'needs-you' ? '!' : initials }}</span>
    <i :key="pulseSequence" class="worker-chart__ring" />
  </span>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import type { WorkerChartRole, WorkerChartState } from './workerChartModel';

const props = withDefaults(defineProps<{
  state: WorkerChartState | null;
  initials: string;
  role: WorkerChartRole;
  pulseSequence?: number;
}>(), { pulseSequence: 0 });

const pulsedAfterMount = ref(false);
let mounted = false;
onMounted(() => { mounted = true; });
watch(() => props.pulseSequence, (sequence, previous) => {
  if (mounted && sequence !== previous) pulsedAfterMount.value = true;
});

const visualState = computed(() => {
  if (!props.state) return undefined;
  if (props.state === 'parked') return 'waiting';
  if (props.state === 'needs-you') return 'blocked';
  return props.state;
});
</script>
