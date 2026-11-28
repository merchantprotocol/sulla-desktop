<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <section
    v-if="agent"
    :ref="root"
    :id="id"
    class="worker-chart__popover"
    :class="{
      'worker-chart__popover--ready': ready,
      'worker-chart__popover--hidden': pageHidden,
      'worker-chart__popover--lite': !selected,
    }"
    :style="style"
    :role="selected ? 'dialog' : 'tooltip'"
    :aria-label="selected && agent ? `${agent.name} details` : undefined"
    :tabindex="selected ? -1 : undefined"
    @mouseenter="$emit('enter')"
    @mouseleave="$emit('leave')"
    @pointerdown.stop
  >
    <header class="worker-chart__popover-head">
      <template v-if="agent">
        <WorkerChartMarker
          class="worker-chart__marker--popover"
          :state="agent.state"
          :initials="agent.initials"
          :role="agent.role ?? 'wrk'"
        />
        <div class="worker-chart__popover-title">
          <strong>{{ agent.name }}</strong>
          <span>{{ agent.lane || 'Main agent' }}</span>
        </div>
        <span class="worker-chart__state-label" :data-state="visualState">{{ stateLabel }}</span>
      </template>
    </header>

    <template v-if="selected && agent">
      <dl class="worker-chart__details">
        <dt>Model</dt><dd>{{ agent.model || 'Not reported' }}</dd>
        <dt>Task</dt><dd class="worker-chart__task" :title="agent.task || 'Not reported'">{{ agent.task || 'Not reported' }}</dd>
        <dt>Elapsed</dt><dd>{{ elapsed }}</dd>
        <dt>Last check-in</dt><dd>{{ lastCheckInTime }}</dd>
        <dd class="worker-chart__check-in">{{ agent.lastCheckIn?.text || '' }}</dd>
      </dl>
      <ActivityBars :values="activityBuckets" />
      <button class="worker-chart__open" type="button" @click.stop="$emit('open', agent.id)">
        Open {{ agent.name }}<span v-if="agent.lane"> · {{ agent.lane }}</span>
      </button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import ActivityBars from './ActivityBars.vue';
import WorkerChartMarker from './WorkerChartMarker.vue';
import { WorkerChartActivityBuckets, type WorkerChartAgent, type WorkerChartState } from './workerChartModel';
import { WorkerChartTimeFormatter } from './WorkerChartTimeFormatter';

const props = defineProps<{
  id: string;
  agent: WorkerChartAgent | null;
  selected: boolean;
  ready: boolean;
  pageHidden: boolean;
  style: Record<string, string>;
  now?: () => number;
  elapsed?: string;
  lastCheckInTime?: string;
  activityBuckets?: readonly number[];
}>();

const emit = defineEmits<{
  enter: [];
  leave: [];
  open: [agentId: string];
  'register-element': [element: HTMLElement | null];
}>();
const root = ref<HTMLElement | null>(null);
const buckets = new WorkerChartActivityBuckets();
const timeFormatter = new WorkerChartTimeFormatter();
const currentNow = (): number => props.now?.() ?? Date.now();
const elapsed = computed(() => props.elapsed ?? (props.agent ? timeFormatter.elapsed(props.agent, currentNow()) : ''));
const lastCheckInTime = computed(() => props.lastCheckInTime ?? (props.agent ? timeFormatter.lastCheckIn(props.agent, currentNow()) : ''));
const activityBuckets = computed(() => props.activityBuckets ?? buckets.values(props.agent?.activity, currentNow()));

const stateLabel = computed(() => {
  const state: WorkerChartState | undefined = props.agent?.state;
  if (!state) return '';
  return { working: 'Working', parked: 'Parked', idle: 'Idle', 'needs-you': 'Needs you', failed: 'Failed', done: 'Done' }[state];
});
const visualState = computed(() => {
  if (props.agent?.state === 'parked') return 'waiting';
  if (props.agent?.state === 'needs-you') return 'blocked';
  return props.agent?.state;
});

onMounted(() => emit('register-element', root.value));
onBeforeUnmount(() => emit('register-element', null));
</script>
