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
      :class="{ 'worker-chart__node--group': row.kind === 'group' }"
      type="button"
      :data-agent-id="row.kind === 'agent' ? row.agent.id : undefined"
      :data-state="visualState"
      :data-depth="row.depth"
      :aria-label="ariaLabel"
      :aria-describedby="hovered ? popoverId : undefined"
      :aria-controls="selected && row.kind === 'agent' ? popoverId : undefined"
      :aria-expanded="row.kind === 'agent' ? selected : row.expanded"
      :aria-haspopup="row.kind === 'agent' ? 'dialog' : undefined"
      @mouseenter="$emit('enter', row)"
      @mouseleave="$emit('leave', row)"
      @focus="$emit('focus', row)"
      @blur="$emit('blur', $event)"
      @click.stop="$emit('activate', row)"
    >
      <template v-if="row.kind === 'agent'">
        <WorkerChartMarker
          :state="row.agent.state"
          :initials="row.agent.initials"
          :role="row.agent.role ?? (row.depth === 0 ? 'main' : 'wrk')"
          :ping="ping"
          :ping-delay="pingDelay"
        />
        <span class="worker-chart__name" :data-state="visualState" :data-depth="row.depth">{{ row.agent.name }}</span>
      </template>
      <WorkerChartMarker
        v-else
        class="worker-chart__marker--chip"
        :state="groupState"
        :initials="''"
        :role="row.agent.role ?? 'wrk'"
        :content="groupText"
        :ping="ping"
        :ping-delay="pingDelay"
      />
    </button>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import WorkerChartMarker from './WorkerChartMarker.vue';
import type { WorkerChartAgentRow, WorkerChartGroupRow, WorkerChartRow, WorkerChartState, WorkerChartVisualState } from './workerChartModel';

const props = defineProps<{
  row: WorkerChartRow;
  style: Record<string, string>;
  popoverId: string;
  selected: boolean;
  hovered: boolean;
  ping: boolean;
  pingDelay: string;
}>();

const emit = defineEmits<{
  activate: [row: WorkerChartRow];
  enter: [row: WorkerChartRow];
  leave: [row: WorkerChartRow];
  focus: [row: WorkerChartRow];
  blur: [event: FocusEvent];
  'register-button': [key: string, element: HTMLButtonElement | null];
}>();

const agentRow = computed(() => props.row.kind === 'agent' ? props.row as WorkerChartAgentRow : null);
const groupRow = computed(() => props.row.kind === 'group' ? props.row as WorkerChartGroupRow : null);
const groupState = computed<WorkerChartState | null>(() => {
  if (!groupRow.value || groupRow.value.expanded) return null;
  return groupRow.value.hiddenAgents.some(agent => agent.state === 'working') ? 'working' : 'parked';
});
const visualState = computed<WorkerChartVisualState | undefined>(() => {
  if (groupRow.value?.expanded) return undefined;
  const state = agentRow.value?.agent.state ?? groupState.value;
  if (!state) return undefined;
  if (state === 'parked') return 'waiting';
  if (state === 'needs-you') return 'blocked';
  return state;
});
const groupText = computed(() => groupRow.value?.hiddenAgents.length ? `+${groupRow.value.hiddenAgents.length}` : 'less');
const stateLabel = computed(() => {
  const state = agentRow.value?.agent.state;
  if (!state) return 'Parked';
  return { working: 'Working', parked: 'Parked', 'needs-you': 'Needs you', failed: 'Failed', done: 'Done' }[state];
});
const ariaLabel = computed(() => {
  if (agentRow.value) {
    const { agent } = agentRow.value;
    return `${agent.name}${agent.lane ? ` · ${agent.lane}` : ''} · ${stateLabel.value}`;
  }
  const group = groupRow.value!;
  const count = group.hiddenAgents.length;
  const working = group.hiddenAgents.filter(agent => agent.state === 'working').length;
  return count
    ? `${count} more agents under ${group.agent.name}, ${working} working. Click to expand`
    : `Collapse ${group.agent.name} workers`;
});

function setButton(element: Element | null): void {
  const button = element instanceof HTMLButtonElement ? element : null;
  emit('register-button', props.row.key, button);
}
</script>
