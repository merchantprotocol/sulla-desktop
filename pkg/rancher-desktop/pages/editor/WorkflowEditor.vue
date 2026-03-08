<template>
  <div
    ref="flowContainer"
    class="workflow-editor"
    :class="{ dark: isDark }"
    @dragover.prevent="onDragOver"
    @drop="onDrop"
  >
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
      @node-context-menu="onNodeContextMenu"
      @pane-click="onPaneClick"
    >
      <template #node-workflow="nodeProps">
        <WorkflowCustomNode v-bind="nodeProps" :is-dark="isDark" />
      </template>
      <Background :variant="BackgroundVariant.Dots" :gap="16" :size="1" />
      <Controls />
      <MiniMap />
    </VueFlow>

    <!-- Node context menu -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="node-context-menu"
        :class="{ dark: isDark }"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      >
        <button class="context-menu-item" :class="{ dark: isDark }" @click="ctxDuplicate">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Duplicate
        </button>
        <button class="context-menu-item" :class="{ dark: isDark }" @click="ctxDisconnect">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Disconnect All
        </button>
        <div class="context-menu-divider" :class="{ dark: isDark }"></div>
        <button class="context-menu-item danger" :class="{ dark: isDark }" @click="ctxDelete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          Delete
        </button>
      </div>
    </Teleport>

    <!-- Delete confirmation dialog -->
    <Teleport to="body">
      <div v-if="deleteConfirm.visible" class="delete-confirm-overlay" @mousedown.self="cancelDelete">
        <div class="delete-confirm-dialog" :class="{ dark: isDark }">
          <div class="delete-confirm-title">Delete Node</div>
          <p class="delete-confirm-text" :class="{ dark: isDark }">
            <strong>{{ deleteConfirm.label }}</strong> has {{ deleteConfirm.edgeCount }}
            connection{{ deleteConfirm.edgeCount === 1 ? '' : 's' }}.
            Are you sure you want to delete it?
          </p>
          <div class="delete-confirm-actions">
            <button class="delete-confirm-btn cancel" :class="{ dark: isDark }" @click="cancelDelete">Cancel</button>
            <button class="delete-confirm-btn confirm" @click="confirmDelete">Delete</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, nextTick } from 'vue';
import { VueFlow, useVueFlow } from '@vue-flow/core';
import { Background, BackgroundVariant } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';

import type { Node, Edge, Connection, NodeChange, EdgeChange } from '@vue-flow/core';
import type { WorkflowDefinition, WorkflowNodeData } from './workflow/types';
import WorkflowCustomNode from './workflow/WorkflowCustomNode.vue';
import { getNodeDefinition } from './workflow/nodeRegistry';

const props = defineProps<{
  isDark: boolean;
  workflowData?: WorkflowDefinition | null;
}>();

const emit = defineEmits<{
  'node-selected': [node: { id: string; label: string; type?: string; data?: WorkflowNodeData } | null];
  'workflow-changed': [];
}>();

const flowContainer = ref<HTMLElement | null>(null);

const { applyNodeChanges, applyEdgeChanges, addEdges, addNodes, project, getViewport, setNodes, setEdges } = useVueFlow();

const nodes = ref<Node[]>([]);
const edges = ref<Edge[]>([]);

// Load workflow data when a *different* workflow is loaded (id changes).
// Metadata-only changes (name, enabled, description) should NOT reset the canvas.
let currentWorkflowId: string | null = null;

watch(
  () => props.workflowData,
  (wf) => {
    if (wf) {
      // Skip canvas reset if same workflow — metadata-only change
      if (wf.id === currentWorkflowId) return;
      currentWorkflowId = wf.id;

      const newNodes = wf.nodes.map(n => ({
        id:       n.id,
        type:     n.type,
        position: { ...n.position },
        data:     { ...n.data },
      }));
      const newEdges = wf.edges.map(e => ({
        id:           e.id,
        source:       e.source,
        target:       e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        label:        e.label,
        animated:     e.animated ?? true,
      }));
      // Use vue-flow's setNodes/setEdges to properly sync internal state
      nodes.value = newNodes;
      edges.value = newEdges;
      nextTick(() => {
        setNodes(newNodes);
        setEdges(newEdges);
      });
    } else {
      currentWorkflowId = null;
      nodes.value = [];
      edges.value = [];
      nextTick(() => {
        setNodes([]);
        setEdges([]);
      });
    }
  },
  { immediate: true },
);

// ── Delete confirmation state ──

const deleteConfirm = reactive({
  visible:   false,
  nodeId:    '',
  label:     '',
  edgeCount: 0,
  pendingChanges: [] as NodeChange[],
});

function cancelDelete() {
  deleteConfirm.visible = false;
  deleteConfirm.pendingChanges = [];
}

function confirmDelete() {
  deleteConfirm.visible = false;
  // Remove the node's edges first, then apply the held-back remove changes
  const nodeId = deleteConfirm.nodeId;
  const connectedEdgeIds = edges.value
    .filter(e => e.source === nodeId || e.target === nodeId)
    .map(e => e.id);
  if (connectedEdgeIds.length > 0) {
    applyEdgeChanges(connectedEdgeIds.map(id => ({ type: 'remove', id })));
  }
  applyNodeChanges(deleteConfirm.pendingChanges);
  deleteConfirm.pendingChanges = [];
  emit('node-selected', null);
  emit('workflow-changed');
}

function getEdgesForNode(nodeId: string): Edge[] {
  return edges.value.filter(e => e.source === nodeId || e.target === nodeId);
}

function onNodesChange(changes: NodeChange[]) {
  // Intercept remove changes to check for connections
  const removeChanges = changes.filter(c => c.type === 'remove');
  const otherChanges = changes.filter(c => c.type !== 'remove');

  // Apply non-remove changes immediately
  if (otherChanges.length > 0) {
    applyNodeChanges(otherChanges);
    emit('workflow-changed');
  }

  if (removeChanges.length === 0) return;

  // Check if any node being removed has connections
  for (const change of removeChanges) {
    if (change.type !== 'remove') continue;
    const nodeId = change.id;
    const connectedEdges = getEdgesForNode(nodeId);
    const node = nodes.value.find(n => n.id === nodeId);
    const label = (node?.data as WorkflowNodeData)?.label || 'This node';

    if (connectedEdges.length > 0) {
      // Show confirmation dialog
      deleteConfirm.nodeId = nodeId;
      deleteConfirm.label = label;
      deleteConfirm.edgeCount = connectedEdges.length;
      deleteConfirm.pendingChanges = removeChanges;
      deleteConfirm.visible = true;
      return; // Don't process any removes until confirmed
    }
  }

  // No connections on any removed node — delete immediately
  applyNodeChanges(removeChanges);
  emit('node-selected', null);
  emit('workflow-changed');
}

function onEdgesChange(changes: EdgeChange[]) {
  applyEdgeChanges(changes);
  emit('workflow-changed');
}

function onConnect(connection: Connection) {
  addEdges([{ ...connection, animated: true }]);
  emit('workflow-changed');
}

function onNodeClick({ node }: { node: Node }) {
  closeContextMenu();
  emit('node-selected', {
    id:    node.id,
    label: (node.data as WorkflowNodeData)?.label ?? (node.label as string),
    type:  node.type,
    data:  node.data as WorkflowNodeData,
  });
}

// ── Context menu ──

const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  nodeId: '',
});

function onNodeContextMenu({ event, node }: { event: MouseEvent; node: Node }) {
  event.preventDefault();
  contextMenu.visible = true;
  contextMenu.x = event.clientX;
  contextMenu.y = event.clientY;
  contextMenu.nodeId = node.id;
}

function closeContextMenu() {
  contextMenu.visible = false;
}

function ctxDuplicate() {
  const node = nodes.value.find(n => n.id === contextMenu.nodeId);
  if (!node) { closeContextMenu(); return; }

  const newNode: Node = {
    id:       `node-${Date.now()}`,
    type:     node.type,
    position: { x: node.position.x + 40, y: node.position.y + 40 },
    data:     JSON.parse(JSON.stringify(node.data)),
  };
  addNodes([newNode]);
  emit('workflow-changed');
  closeContextMenu();
}

function ctxDisconnect() {
  const nodeId = contextMenu.nodeId;
  const connected = edges.value
    .filter(e => e.source === nodeId || e.target === nodeId)
    .map(e => ({ type: 'remove' as const, id: e.id }));
  if (connected.length > 0) {
    applyEdgeChanges(connected);
    emit('workflow-changed');
  }
  closeContextMenu();
}

function ctxDelete() {
  closeContextMenu();
  // Trigger the same flow as keyboard delete
  const nodeId = contextMenu.nodeId;
  const connectedEdges = getEdgesForNode(nodeId);
  const node = nodes.value.find(n => n.id === nodeId);
  const label = (node?.data as WorkflowNodeData)?.label || 'This node';
  const removeChange: NodeChange = { type: 'remove', id: nodeId };

  if (connectedEdges.length > 0) {
    deleteConfirm.nodeId = nodeId;
    deleteConfirm.label = label;
    deleteConfirm.edgeCount = connectedEdges.length;
    deleteConfirm.pendingChanges = [removeChange];
    deleteConfirm.visible = true;
  } else {
    applyNodeChanges([removeChange]);
    emit('node-selected', null);
    emit('workflow-changed');
  }
}

function onPaneClick() {
  closeContextMenu();
  emit('node-selected', null);
}

function updateNodeLabel(nodeId: string, label: string) {
  const node = nodes.value.find(n => n.id === nodeId);
  if (node && node.data) {
    (node.data as WorkflowNodeData).label = label;
  }
}

function updateNodeConfig(nodeId: string, config: Record<string, any>) {
  const node = nodes.value.find(n => n.id === nodeId);
  if (node && node.data) {
    (node.data as WorkflowNodeData).config = { ...config };
  }
  emit('workflow-changed');
}

// ── Drag and drop from palette ──

function onDragOver(event: DragEvent) {
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
}

function onDrop(event: DragEvent) {
  const raw = event.dataTransfer?.getData('application/vueflow');
  if (!raw) return;

  const { subtype, category } = JSON.parse(raw);
  const definition = getNodeDefinition(subtype);
  if (!definition) return;

  const bounds = flowContainer.value?.getBoundingClientRect();
  const position = project({
    x: event.clientX - (bounds?.left ?? 0),
    y: event.clientY - (bounds?.top ?? 0),
  });

  const newNode: Node = {
    id:   `node-${ Date.now() }`,
    type: 'workflow',
    position,
    data: {
      subtype,
      category,
      label:  definition.defaultLabel,
      config: definition.defaultConfig(),
    } as WorkflowNodeData,
  };

  addNodes([newNode]);
  emit('workflow-changed');
}

// ── Serialization ──

function serialize(): { nodes: any[]; edges: any[]; viewport: any } {
  const vp = getViewport();

  return {
    nodes: nodes.value.map(n => ({
      id:       n.id,
      type:     n.type,
      position: { x: n.position.x, y: n.position.y },
      data:     JSON.parse(JSON.stringify(n.data)),
    })),
    edges: edges.value.map(e => ({
      id:           e.id,
      source:       e.source,
      target:       e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      label:        e.label,
      animated:     e.animated,
    })),
    viewport: { x: vp.x, y: vp.y, zoom: vp.zoom },
  };
}

import type { WorkflowNodeExecutionState, NodeThinkingMessage } from './workflow/types';

function updateNodeExecution(nodeId: string, execution: WorkflowNodeExecutionState | undefined) {
  const node = nodes.value.find(n => n.id === nodeId);
  if (node && node.data) {
    (node.data as WorkflowNodeData).execution = execution;
  }
}

function clearAllExecution() {
  for (const node of nodes.value) {
    if (node.data) {
      (node.data as WorkflowNodeData).execution = undefined;
    }
  }
  // Animate edges back to static
  for (const edge of edges.value) {
    edge.animated = false;
  }
}

function setEdgeAnimated(sourceId: string, targetId: string, animated: boolean) {
  const edge = edges.value.find(e => e.source === sourceId && e.target === targetId);
  if (edge) {
    edge.animated = animated;
  }
}

function pushNodeThinking(nodeId: string, message: NodeThinkingMessage) {
  const node = nodes.value.find(n => n.id === nodeId);
  if (!node?.data) return;
  const data = node.data as WorkflowNodeData;
  if (!data.execution) return;
  if (!data.execution.thinkingMessages) {
    data.execution.thinkingMessages = [];
  }
  data.execution.thinkingMessages.push(message);
}

defineExpose({ updateNodeLabel, updateNodeConfig, serialize, updateNodeExecution, clearAllExecution, setEdgeAnimated, pushNodeThinking, getNodes: () => nodes.value, getEdges: () => edges.value });
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

/* ── Context menu ── */
.node-context-menu {
  position: fixed;
  z-index: 10001;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 4px;
  min-width: 160px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.node-context-menu.dark {
  background: #1e293b;
  border-color: #3c3c5c;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: #334155;
  font-size: 12px;
  border-radius: 5px;
  cursor: pointer;
  text-align: left;
}

.context-menu-item:hover {
  background: #f1f5f9;
}

.context-menu-item.dark {
  color: #e2e8f0;
}

.context-menu-item.dark:hover {
  background: #334155;
}

.context-menu-item.danger {
  color: #ef4444;
}

.context-menu-item.danger:hover {
  background: #fef2f2;
}

.context-menu-item.danger.dark:hover {
  background: rgba(239, 68, 68, 0.15);
}

.context-menu-divider {
  height: 1px;
  background: #e2e8f0;
  margin: 4px 6px;
}

.context-menu-divider.dark {
  background: #3c3c5c;
}

/* ── Delete confirm dialog ── */
.delete-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.delete-confirm-dialog {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  width: 320px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.delete-confirm-dialog.dark {
  background: #1e293b;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.delete-confirm-title {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
}

.delete-confirm-dialog.dark .delete-confirm-title {
  color: #e2e8f0;
}

.delete-confirm-text {
  font-size: 13px;
  color: #475569;
  margin: 0;
  line-height: 1.4;
}

.delete-confirm-text.dark {
  color: #94a3b8;
}

.delete-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.delete-confirm-btn {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.delete-confirm-btn.cancel {
  background: #f1f5f9;
  color: #64748b;
}

.delete-confirm-btn.cancel:hover {
  background: #e2e8f0;
}

.delete-confirm-btn.cancel.dark {
  background: #334155;
  color: #94a3b8;
}

.delete-confirm-btn.cancel.dark:hover {
  background: #475569;
}

.delete-confirm-btn.confirm {
  background: #ef4444;
  color: #fff;
}

.delete-confirm-btn.confirm:hover {
  background: #dc2626;
}
</style>
