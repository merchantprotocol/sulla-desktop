<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <aside
    v-if="props.root"
    :ref="controller.host"
    class="worker-chart"
    :class="{ 'worker-chart--narrow': controller.isNarrow, 'worker-chart--rail': controller.isRail, 'worker-chart--hidden': controller.hidden }"
    aria-label="Worker chart"
  >
    <button
      v-if="controller.isNarrow"
      :ref="controller.railTrigger"
      class="worker-chart__rail-trigger"
      type="button"
      aria-label="Open worker chart"
      :aria-expanded="controller.overlayOpen"
      @click="controller.toggleOverlay()"
    >
      <span class="worker-chart__rail-dots" aria-hidden="true">
        <WorkerChartMarker
          v-for="row in controller.chart.rows"
          :key="row.key"
          class="worker-chart__rail-dot"
          :class="{ 'worker-chart__marker--chip': row.kind === 'group' }"
          :state="controller.rowState(row)"
          :initials="row.kind === 'agent' ? row.agent.initials : ''"
          :role="row.agent.role ?? (row.depth === 0 ? 'main' : 'wrk')"
          :content="row.kind === 'group' ? (row.hiddenAgents.length ? `+${row.hiddenAgents.length}` : 'less') : undefined"
          :ping="controller.rowPings(row)"
          :ping-delay="controller.pulseDelay(row)"
          :style="{ top: `${row.y}px`, left: '7.5px' }"
        />
      </span>
    </button>

    <Teleport :disabled="!controller.isNarrow || !controller.overlayOpen" to="body">
      <section
        v-if="!controller.isNarrow || controller.overlayOpen"
        :ref="controller.chartSurface"
        class="worker-chart__surface"
        :class="{ 'worker-chart__surface--overlay': controller.isNarrow, 'worker-chart__surface--hidden': controller.hidden }"
        :style="controller.isNarrow ? controller.overlayPosition : undefined"
        :role="controller.isNarrow ? 'dialog' : undefined"
        :aria-modal="controller.isNarrow ? 'false' : undefined"
        :aria-label="controller.isNarrow ? 'Worker chart' : undefined"
        :tabindex="controller.isNarrow ? -1 : undefined"
        @click.self="controller.isNarrow && controller.closeChartOverlay(true)"
      >
        <div
          :ref="controller.tree"
          class="worker-chart__tree"
          :class="{ 'worker-chart__tree--overlay': controller.isNarrow }"
          @scroll="controller.repositionPopover()"
        >
          <WorkerChartLinks :links="controller.links" :content-height="controller.chart.contentHeight" />
          <TransitionGroup
            name="worker-chart-row"
            tag="ul"
            class="worker-chart__rows"
            role="list"
            aria-label="Agents"
            :style="{ height: `${controller.chart.contentHeight}px` }"
            @before-enter="element => controller.beforeRowEnter(element)"
            @before-leave="element => controller.beforeRowLeave(element)"
          >
            <WorkerChartNode
              v-for="row in controller.chart.rows"
              :key="row.key"
              :row="row"
              :style="controller.rowStyle(row)"
              :popover-id="controller.popoverId"
              :selected="row.kind === 'agent' && controller.selectedId === row.agent.id"
              :hovered="controller.hoveredKey === row.key"
              :ping="controller.rowPings(row)"
              :ping-delay="controller.pulseDelay(row)"
              @activate="row => controller.activate(row)"
              @enter="row => controller.onNodeEnter(row)"
              @leave="row => controller.onNodeLeave(row)"
              @focus="row => controller.onNodeFocus(row)"
              @blur="event => controller.onNodeBlur(event)"
              @register-button="(key, element) => controller.registerButton(key, element)"
            />
          </TransitionGroup>
        </div>
      </section>
    </Teleport>

    <Teleport to="body">
      <WorkerChartPopover
        v-if="controller.isPopoverOpen"
        :id="controller.popoverId"
        :agent="controller.activePopoverAgent"
        :group="controller.activePopoverGroup"
        :selected="controller.selected"
        :ready="controller.ready"
        :page-hidden="controller.hidden"
        :style="controller.popoverPosition"
        :elapsed="controller.activePopoverAgent ? controller.elapsed(controller.activePopoverAgent) : ''"
        :last-check-in-time="controller.activePopoverAgent ? controller.lastCheckInTime(controller.activePopoverAgent) : ''"
        :activity-buckets="controller.activityValues"
        @enter="controller.cancelTooltipClose()"
        @leave="controller.scheduleTooltipClose()"
        @open="agentId => controller.openAgent(agentId)"
        @register-element="element => controller.registerPopover(element)"
      />
    </Teleport>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useId } from 'vue';

import './workerChart.css';
import WorkerChartLinks from './WorkerChartLinks.vue';
import WorkerChartMarker from './WorkerChartMarker.vue';
import WorkerChartNode from './WorkerChartNode.vue';
import WorkerChartPopover from './WorkerChartPopover.vue';
import { WorkerChartActivityBuckets, WorkerChartGeometry, WorkerChartLayout } from './workerChartModel';
import { WorkerChartController } from './WorkerChartController';
import { WorkerChartOverlayController } from './WorkerChartOverlayController';
import { WorkerChartTimeFormatter } from './WorkerChartTimeFormatter';
import type { WorkerChartAgent } from './workerChartModel';
import type { WorkerChartControllerSources, WorkerChartSnippetTick } from './WorkerChartController';

const props = defineProps<{
  /** Current chat's real agent tree, mapped by the caller from its live presenter. */
  root: WorkerChartAgent | null;
  /** Measured width of the chat column; below 900 px the chart becomes a compact rail. */
  chatColumnWidth: number;
  snippetTick?: WorkerChartSnippetTick | null;
}>();

const emit = defineEmits<{ 'open-agent': [payload: { agentId: string }] }>();
const sources: WorkerChartControllerSources = {
  root: computed(() => props.root),
  chatColumnWidth: computed(() => props.chatColumnWidth),
  snippetTick: computed(() => props.snippetTick),
  instanceId: useId(),
  openAgent: payload => emit('open-agent', payload),
};
const interaction = new WorkerChartOverlayController(sources);
const controller = new WorkerChartController(
  sources,
  new WorkerChartLayout(),
  new WorkerChartGeometry(),
  new WorkerChartActivityBuckets(),
  new WorkerChartTimeFormatter(),
  interaction,
);

onMounted(() => controller.mount());
onBeforeUnmount(() => controller.unmount());
</script>
