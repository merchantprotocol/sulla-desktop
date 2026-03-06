<template>
  <div class="workflow-editor" :class="{ dark: isDark }">
    <VueFlow
      v-model:nodes="nodes"
      v-model:edges="edges"
      :class="{ dark: isDark }"
      :default-viewport="{ zoom: 1 }"
      fit-view-on-init
      @nodes-change="onNodesChange"
      @edges-change="onEdgesChange"
      @connect="onConnect"
      @node-click="onNodeClick"
      @pane-click="onPaneClick"
    >
      <Background :variant="BackgroundVariant.Dots" :gap="16" :size="1" />
      <Controls />
      <MiniMap />
    </VueFlow>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { VueFlow, useVueFlow } from '@vue-flow/core';
import { Background, BackgroundVariant } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';

import type { Node, Edge, Connection, NodeChange, EdgeChange } from '@vue-flow/core';

defineProps<{
  isDark: boolean;
}>();

const emit = defineEmits<{
  'node-selected': [node: { id: string; label: string; type?: string } | null];
}>();

const { applyNodeChanges, applyEdgeChanges, addEdges } = useVueFlow();

const nodes = ref<Node[]>([
  {
    id: '1',
    type: 'input',
    label: 'Start',
    position: { x: 250, y: 0 },
  },
  {
    id: '2',
    label: 'Process',
    position: { x: 250, y: 150 },
  },
  {
    id: '3',
    type: 'output',
    label: 'End',
    position: { x: 250, y: 300 },
  },
]);

const edges = ref<Edge[]>([
  { id: 'e1-2', source: '1', target: '2', animated: true },
  { id: 'e2-3', source: '2', target: '3', animated: true },
]);

function onNodesChange(changes: NodeChange[]) {
  applyNodeChanges(changes);
}

function onEdgesChange(changes: EdgeChange[]) {
  applyEdgeChanges(changes);
}

function onConnect(connection: Connection) {
  addEdges([connection]);
}

function onNodeClick({ node }: { node: Node }) {
  emit('node-selected', {
    id:    node.id,
    label: node.label as string,
    type:  node.type,
  });
}

function onPaneClick() {
  emit('node-selected', null);
}

function updateNodeLabel(nodeId: string, label: string) {
  const node = nodes.value.find(n => n.id === nodeId);

  if (node) {
    node.label = label;
  }
}

defineExpose({ updateNodeLabel });
</script>

<style scoped>
.workflow-editor {
  width: 100%;
  height: 100%;
  flex: 1;
  min-height: 0;
}

.workflow-editor :deep(.vue-flow) {
  width: 100%;
  height: 100%;
}

/* Dark theme overrides */
.workflow-editor.dark :deep(.vue-flow) {
  background: #1a1a2e;
}

.workflow-editor.dark :deep(.vue-flow__node) {
  background: #2d2d44;
  color: #e2e8f0;
  border-color: #4a4a6a;
}

.workflow-editor.dark :deep(.vue-flow__node.selected) {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.3);
}

.workflow-editor.dark :deep(.vue-flow__edge-path) {
  stroke: #6366f1;
}

.workflow-editor.dark :deep(.vue-flow__minimap) {
  background: #1e293b;
}

.workflow-editor.dark :deep(.vue-flow__minimap-mask) {
  fill: rgba(99, 102, 241, 0.1);
}

.workflow-editor.dark :deep(.vue-flow__minimap-node) {
  fill: #4a4a6a;
}

.workflow-editor.dark :deep(.vue-flow__controls) {
  background: #2d2d44;
  border-color: #4a4a6a;
}

.workflow-editor.dark :deep(.vue-flow__controls-button) {
  background: #2d2d44;
  border-color: #4a4a6a;
  fill: #e2e8f0;
}

.workflow-editor.dark :deep(.vue-flow__controls-button:hover) {
  background: #3d3d5c;
}

.workflow-editor.dark :deep(.vue-flow__background pattern circle) {
  fill: #4a4a6a;
}
</style>
