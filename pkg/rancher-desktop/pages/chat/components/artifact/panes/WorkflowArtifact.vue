<!--
  Workflow artifact pane.

  Two render paths:
    • payload.id is set → mount the full AgentRoutines editor. Same
      component as the /routines/:id page — identical editor, drawer,
      run controls, history, IPC. We pass `workflow-id` so it skips
      the playbill and drops straight into the editor.
    • payload.id is unset (ad-hoc runtime preview from workflow_execution
      events before a routine is saved) → render the read-only VueFlow
      snapshot below.
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
      class="dark"
      :default-viewport="viewport"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="false"
      :zoom-on-double-click="false"
      fit-view-on-init
    >
      <template #node-workflow="nodeProps">
        <WorkflowCustomNode v-bind="nodeProps" :is-dark="true" />
      </template>

      <Background :variant="BackgroundVariant.Dots" :gap="16" :size="1" />

      <svg width="0" height="0" style="position:absolute">
        <defs>
          <linearGradient id="wf-artifact-edge-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stop-color="rgba(46, 160, 67, 0.6)" />
            <stop offset="50%"  stop-color="rgba(63, 185, 80, 0.9)" />
            <stop offset="100%" stop-color="rgba(46, 160, 67, 0.6)" />
          </linearGradient>
        </defs>
      </svg>
    </VueFlow>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { VueFlow } from '@vue-flow/core';
import { Background, BackgroundVariant } from '@vue-flow/background';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';

import type { Node, Edge } from '@vue-flow/core';
import AgentRoutines from '../../../../AgentRoutines.vue';
import WorkflowCustomNode from '../../../../editor/workflow/WorkflowCustomNode.vue';
import type { WorkflowPayload, WorkflowRuntimeState } from '../../../models/Artifact';

const props = defineProps<{ payload: WorkflowPayload }>();

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
      type:     'workflow',
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
    type:         'smoothstep',
    pathOptions:  { borderRadius: 12, offset: 20 },
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

.wf-artifact.dark :deep(.vue-flow) {
  background: var(--bg-page, #0d1117);
}

.wf-artifact.dark :deep(.vue-flow__edge-path) {
  stroke: url(#wf-artifact-edge-grad);
  stroke-width: 1.8px;
  stroke-dasharray: 5 5;
  animation: wf-artifact-dash 1s linear infinite;
  filter: drop-shadow(0 0 3px rgba(46, 160, 67, 0.3));
}

@keyframes wf-artifact-dash {
  to { stroke-dashoffset: -20; }
}

.wf-artifact.dark :deep(.vue-flow__background) {
  mask-image: radial-gradient(ellipse at center, black 15%, transparent 65%);
  -webkit-mask-image: radial-gradient(ellipse at center, black 15%, transparent 65%);
}

.wf-artifact.dark :deep(.vue-flow__background circle) {
  fill: hsl(0deg 0% 100% / 62%);
}
</style>
