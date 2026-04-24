<!--
  Workflow artifact pane.

  Two render paths:
    • payload.id is set → mount the full AgentRoutines editor. Same
      component as the /routines/:id page — identical editor, drawer,
      run controls, history, IPC. We pass `workflow-id` so it skips
      the playbill and drops straight into the editor.
    • payload.id is unset (ad-hoc runtime preview from workflow_execution
      events before a routine is saved) → render a read-only VueFlow
      snapshot using the same node/edge components AgentRoutines uses,
      so the preview is visually indistinguishable from the real editor.
-->
<template>
  <div class="wf-artifact dark">
    <AgentRoutines
      v-if="payload.id"
      :workflow-id="payload.id"
      initial-mode="edit"
    />
    <VueFlow
      v-else
      :nodes="vfNodes"
      :edges="vfEdges"
      class="routines-flow locked dark"
      :default-viewport="viewport"
      :default-edge-options="{ type: 'routine' }"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="false"
      :zoom-on-double-click="false"
      fit-view-on-init
    >
      <template #node-routine="nodeProps">
        <RoutineNode v-bind="nodeProps" />
      </template>
      <template #node-workflow="nodeProps">
        <RoutineNode v-bind="nodeProps" />
      </template>
      <template #node-loop-frame="nodeProps">
        <LoopFrameNode v-bind="nodeProps" />
      </template>
      <template #node-sticky-note="nodeProps">
        <StickyNoteNode v-bind="nodeProps" />
      </template>
      <template #edge-routine="edgeProps">
        <RoutineEdge v-bind="edgeProps" />
      </template>

      <Background
        :variant="BackgroundVariant.Lines"
        :gap="32"
        :size="1"
        pattern-color="rgba(140,172,210,0.045)"
      />
    </VueFlow>
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref } from 'vue';
import { VueFlow } from '@vue-flow/core';
import { Background, BackgroundVariant } from '@vue-flow/background';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';

import type { Node, Edge } from '@vue-flow/core';
import AgentRoutines from '../../../../AgentRoutines.vue';
import RoutineNode from '../../../../routines/RoutineNode.vue';
import LoopFrameNode from '../../../../routines/LoopFrameNode.vue';
import StickyNoteNode from '../../../../routines/StickyNoteNode.vue';
import RoutineEdge from '../../../../routines/RoutineEdge.vue';
import type { WorkflowPayload, WorkflowRuntimeState } from '../../../models/Artifact';

const props = defineProps<{ payload: WorkflowPayload }>();

// RoutineNode reads this injection to hide edit-only affordances. The
// preview pane is read-only, so pin to 'run' for the whole subtree.
provide('routines-mode', ref<'edit' | 'run'>('run'));

function toExecStatus(state?: WorkflowRuntimeState): string | undefined {
  if (state === 'active') return 'running';
  if (state === 'done')   return 'completed';
  if (state === 'error')  return 'failed';
  return undefined;
}

const vfNodes = computed<Node[]>(() =>
  props.payload.nodes.map(n => {
    const status = toExecStatus(n.runtimeState);
    return {
      id:       n.id,
      type:     n.type || 'routine',
      position: n.position,
      data: {
        ...n.data,
        execution: status ? { status } : undefined,
      },
    };
  })
);

const vfEdges = computed<Edge[]>(() =>
  props.payload.edges.map(e => ({
    id:           e.id,
    source:       e.source,
    target:       e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
    type:         'routine',
    animated:     e.runtimeState === 'active',
    label:        e.label,
  }))
);

const viewport = computed(() => props.payload.viewport ?? { x: 0, y: 0, zoom: 1 });
</script>

<style scoped>
.wf-artifact {
  width: 100%;
  height: 100%;
  min-height: 420px;
}

.wf-artifact :deep(.vue-flow) {
  width: 100%;
  height: 100%;
}
</style>
