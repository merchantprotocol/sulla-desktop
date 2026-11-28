<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <li
    class="worker-chart__row"
    :style="style"
    :data-row-key="row.key"
    :data-parent-id="row.parentId ?? ''"
  >
    <button
      :ref="setButton"
      class="worker-chart__node"
      type="button"
      :data-agent-id="row.agent.id"
      :data-state="visualState"
      :data-depth="row.depth"
      :aria-label="ariaLabel"
      :aria-describedby="hovered ? popoverId : undefined"
      :aria-controls="selected ? popoverId : undefined"
      :aria-expanded="selected"
      aria-haspopup="dialog"
      @mouseenter="$emit('enter', row)"
      @mouseleave="$emit('leave', row)"
      @focus="$emit('focus', row)"
      @blur="$emit('blur', $event)"
      @click.stop="$emit('activate', row)"
    >
      <WorkerChartMarker
        :state="row.agent.state"
        :initials="row.agent.initials"
        :role="row.agent.role ?? (row.depth === 0 ? 'main' : 'wrk')"
        :pulse-sequence="pulseSequence"
      />
      <span class="worker-chart__name" :data-state="visualState" :data-depth="row.depth">{{ row.agent.name }}</span>
    </button>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import WorkerChartMarker from './WorkerChartMarker.vue';
import type { WorkerChartAgentRow, WorkerChartState, WorkerChartVisualState } from './workerChartModel';

const props = defineProps<{
  row: WorkerChartAgentRow;
  style: Record<string, string>;
  popoverId: string;
  selected: boolean;
  hovered: boolean;
  pulseSequence: number;
}>();

const emit = defineEmits<{
  activate: [row: WorkerChartAgentRow];
  enter: [row: WorkerChartAgentRow];
  leave: [row: WorkerChartAgentRow];
  focus: [row: WorkerChartAgentRow];
  blur: [event: FocusEvent];
  'register-button': [key: string, element: HTMLButtonElement | null];
}>();

const stateLabel = computed(() => {
  const state: WorkerChartState = props.row.agent.state;
  return { working: 'Working', parked: 'Parked', idle: 'Idle', 'needs-you': 'Needs you', failed: 'Failed', done: 'Done' }[state];
});
const visualState = computed<WorkerChartVisualState>(() => {
  if (props.row.agent.state === 'parked') return 'waiting';
  if (props.row.agent.state === 'needs-you') return 'blocked';
  return props.row.agent.state;
});
const ariaLabel = computed(() => `${props.row.agent.name}${props.row.agent.lane ? ` · ${props.row.agent.lane}` : ''} · ${stateLabel.value}`);

function setButton(element: Element | null): void {
  emit('register-button', props.row.key, element instanceof HTMLButtonElement ? element : null);
}
</script>
