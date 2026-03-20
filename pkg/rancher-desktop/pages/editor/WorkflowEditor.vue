<template>
  <div
    ref="flowContainer"
    class="workflow-editor"
    :class="{ dark: isDark }"
    tabindex="0"
    @dragover.prevent="onDragOver"
    @drop="onDrop"
    @keydown="onKeyDown"
  >
    <VueFlow
      v-model:nodes="nodes"
      v-model:edges="edges"
      :class="{ dark: isDark }"
      :default-viewport="{ zoom: 1 }"
      :default-edge-options="{ type: 'smoothstep', pathOptions: { borderRadius: 12, offset: 20 } }"
      fit-view-on-init
      @nodes-change="onNodesChange"
      @edges-change="onEdgesChange"
      @connect="onConnect"
      @node-click="onNodeClick"
      @node-context-menu="onNodeContextMenu"
      @pane-click="onPaneClick"
    >
      <template #node-workflow="nodeProps">
        <WorkflowCustomNode
          v-bind="nodeProps"
          :is-dark="isDark"
        />
      </template>
      <Background
        :variant="BackgroundVariant.Dots"
        :gap="16"
        :size="1"
      />
      <Controls />
      <MiniMap />

      <!-- SVG gradient for edge lines -->
      <svg
        width="0"
        height="0"
        style="position:absolute"
      >
        <defs>
          <linearGradient
            id="edge-green-gradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop
              offset="0%"
              stop-color="rgba(46, 160, 67, 0.6)"
            />
            <stop
              offset="50%"
              stop-color="rgba(63, 185, 80, 0.9)"
            />
            <stop
              offset="100%"
              stop-color="rgba(46, 160, 67, 0.6)"
            />
          </linearGradient>
        </defs>
      </svg>
    </VueFlow>

    <!-- Node context menu -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="node-context-menu"
        :class="{ dark: isDark }"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      >
        <button
          class="context-menu-item"
          :class="{ dark: isDark }"
          @click="ctxDuplicate"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><rect
            x="9"
            y="9"
            width="13"
            height="13"
            rx="2"
          /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          Duplicate
        </button>
        <button
          class="context-menu-item"
          :class="{ dark: isDark }"
          @click="ctxDisconnect"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line
            x1="10"
            y1="14"
            x2="21"
            y2="3"
          /></svg>
          Disconnect All
        </button>
        <div
          class="context-menu-divider"
          :class="{ dark: isDark }"
        />
        <button
          class="context-menu-item danger"
          :class="{ dark: isDark }"
          @click="ctxDelete"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
          Delete
        </button>
      </div>
    </Teleport>

    <!-- Delete confirmation dialog -->
    <Teleport to="body">
      <div
        v-if="deleteConfirm.visible"
        class="delete-confirm-overlay"
        @mousedown.self="cancelDelete"
      >
        <div
          class="delete-confirm-dialog"
          :class="{ dark: isDark }"
        >
          <div class="delete-confirm-title">
            Delete Node
          </div>
          <p
            class="delete-confirm-text"
            :class="{ dark: isDark }"
          >
            <strong>{{ deleteConfirm.label }}</strong> has {{ deleteConfirm.edgeCount }}
            connection{{ deleteConfirm.edgeCount === 1 ? '' : 's' }}.
            Are you sure you want to delete it?
          </p>
          <div class="delete-confirm-actions">
            <button
              class="delete-confirm-btn cancel"
              :class="{ dark: isDark }"
              @click="cancelDelete"
            >
              Cancel
            </button>
            <button
              class="delete-confirm-btn confirm"
              @click="confirmDelete"
            >
              Delete
            </button>
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
import type { WorkflowDefinition, WorkflowNodeData, WorkflowNodeSubtype, WorkflowNodeExecutionState, NodeThinkingMessage } from './workflow/types';
import WorkflowCustomNode from './workflow/WorkflowCustomNode.vue';
import { getNodeDefinition } from './workflow/nodeRegistry';

/**
 * Node subtypes that cannot be placed downstream of a parallel node.
 * These require orchestrator attention, user interaction, or temporal pauses
 * and would break true parallel execution.
 */
const NON_PARALLELIZABLE_SUBTYPES: ReadonlySet<WorkflowNodeSubtype> = new Set([
  'router',
  'condition',
  'user-input',
  'wait',
]);

const props = defineProps<{
  isDark:        boolean;
  workflowData?: WorkflowDefinition | null;
}>();

const emit = defineEmits<{
  'node-selected':    [node: { id: string; label: string; type?: string; data?: WorkflowNodeData } | null];
  'workflow-changed': [];
}>();

const flowContainer = ref<HTMLElement | null>(null);

const { applyNodeChanges, applyEdgeChanges, addEdges, addNodes, project, getViewport, setNodes, setEdges } = useVueFlow();

const nodes = ref<Node[]>([]);
const edges = ref<Edge[]>([]);
const selectedNodeId = ref<string | null>(null);

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
  visible:        false,
  nodeId:         '',
  label:          '',
  edgeCount:      0,
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
  selectedNodeId.value = null;
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
  selectedNodeId.value = null;
  emit('node-selected', null);
  emit('workflow-changed');
}

function onEdgesChange(changes: EdgeChange[]) {
  applyEdgeChanges(changes);
  emit('workflow-changed');
}

/**
 * Check whether a node sits inside a parallel branch — i.e. it is reachable
 * from a 'parallel' node without crossing a 'merge' node first.
 */
function isInsideParallelBranch(nodeId: string): boolean {
  // Walk backwards from nodeId. If we hit a 'parallel' node before hitting
  // a 'merge' node (or running out of graph), the node is inside a parallel branch.
  const visited = new Set<string>();
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const node = nodes.value.find(n => n.id === current);
    if (!node) continue;

    const data = node.data as WorkflowNodeData | undefined;
    if (!data) continue;

    // If we reached a parallel node, this nodeId is inside a parallel branch
    if (data.subtype === 'parallel') return true;
    // If we reached a merge node, this branch is past the parallel block — stop
    if (data.subtype === 'merge') continue;

    // Walk upstream
    for (const edge of edges.value) {
      if (edge.target === current && !visited.has(edge.source)) {
        queue.push(edge.source);
      }
    }
  }

  return false;
}

function onConnect(connection: Connection) {
  const sourceNode = nodes.value.find(n => n.id === connection.source);
  const targetNode = nodes.value.find(n => n.id === connection.target);
  const sourceData = sourceNode?.data as WorkflowNodeData | undefined;
  const targetData = targetNode?.data as WorkflowNodeData | undefined;

  // ── Loop handle connection rules ──
  // Validate connections involving loop node handles
  if (targetData?.subtype === 'loop') {
    const targetHandle = connection.targetHandle;

    // Block self-connections: no handle on a loop node should connect to another handle on the same loop node
    if (connection.source === connection.target) {
      console.warn('[WorkflowEditor] Cannot connect a loop node to itself.');
      return;
    }

    // loop-entry (In): only accepts connections from upstream workflow nodes (not loop body nodes)
    if (targetHandle === 'loop-entry') {
      // Prevent loop body nodes from connecting to loop-entry
      if (sourceData && isLoopBodyNode(connection.target, connection.source)) {
        console.warn('[WorkflowEditor] Cannot connect a loop body node to the loop entry. Use the "Back" handle instead.');
        return;
      }
    }

    // loop-back (Back): only accepts connections from nodes downstream of loop-start (loop body)
    if (targetHandle === 'loop-back') {
      // Prevent upstream/external nodes from connecting to loop-back
      if (sourceData && !isLoopBodyNode(connection.target, connection.source)) {
        console.warn('[WorkflowEditor] Only loop body nodes (downstream of "Start") can connect to the "Back" handle.');
        return;
      }
    }

    // loop-exit (Exit): should not accept any incoming connections (it's a source handle)
    // Vue Flow already handles this via handle type (source vs target), but double-check
    if (targetHandle === 'loop-exit') {
      console.warn('[WorkflowEditor] Cannot connect to the loop "Exit" handle — it is an output.');
      return;
    }

    // loop-start (Start): should not accept incoming connections (it's a source handle)
    if (targetHandle === 'loop-start') {
      console.warn('[WorkflowEditor] Cannot connect to the loop "Start" handle — it is an output.');
      return;
    }
  }

  if (sourceData?.subtype === 'loop') {
    const sourceHandle = connection.sourceHandle;

    // loop-exit (Exit): should not connect back to the loop's own body nodes
    if (sourceHandle === 'loop-exit') {
      if (targetData && isLoopBodyNode(connection.source, connection.target)) {
        console.warn('[WorkflowEditor] The loop "Exit" handle should connect to downstream nodes outside the loop body.');
        return;
      }
    }

    // loop-start (Start): should only connect to loop body nodes, not to external downstream
    // (This is a soft guideline — not strictly enforced, but warn)
  }

  // ── Block nested loops ──
  // A loop node cannot be placed inside another loop's body
  if (targetData?.subtype === 'loop' && sourceData?.subtype !== 'loop') {
    // Check if any existing loop node has the source in its body — that would make the target loop nested
    const loopNodes = nodes.value.filter(n => (n.data as WorkflowNodeData).subtype === 'loop' && n.id !== connection.target);
    for (const ln of loopNodes) {
      if (isLoopBodyNode(ln.id, connection.source)) {
        console.warn('[WorkflowEditor] Cannot place a loop node inside another loop body. Nested loops are not supported.');
        return;
      }
    }
  }

  // A loop's Start handle cannot connect to another loop node
  if (sourceData?.subtype === 'loop' && connection.sourceHandle === 'loop-start' && targetData?.subtype === 'loop') {
    console.warn('[WorkflowEditor] Cannot place a loop node inside another loop body. Nested loops are not supported.');
    return;
  }

  if (targetData && NON_PARALLELIZABLE_SUBTYPES.has(targetData.subtype)) {
    // Block direct connection from a parallel node
    if (sourceData?.subtype === 'parallel') {
      console.warn(
        `[WorkflowEditor] Cannot connect "${ targetData.subtype }" node directly to a parallel node. ` +
        `Router, condition, user-input, and wait nodes cannot run in parallel branches.`,
      );

      return;
    }

    // Block connection if the source is already inside a parallel branch
    if (connection.source && isInsideParallelBranch(connection.source)) {
      console.warn(
        `[WorkflowEditor] Cannot place "${ targetData.subtype }" node inside a parallel branch. ` +
        `Router, condition, user-input, and wait nodes cannot run in parallel branches.`,
      );

      return;
    }
  }

  addEdges([{ ...connection, animated: true }]);
  emit('workflow-changed');
}

/**
 * Check whether a node is (or would be) inside a loop body — i.e. it is reachable
 * from the loop node's loop-start handle via forward edges, without leaving the loop.
 */
function isLoopBodyNode(loopNodeId: string, candidateNodeId: string): boolean {
  // BFS forward from the loop node's loop-start edges
  const visited = new Set<string>();
  const queue: string[] = [];

  // Find edges going out from the loop node's loop-start handle
  for (const edge of edges.value) {
    if (edge.source === loopNodeId && edge.sourceHandle === 'loop-start') {
      queue.push(edge.target);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current) || current === loopNodeId) continue;
    visited.add(current);

    if (current === candidateNodeId) return true;

    // Follow forward edges (but stop at the loop node to avoid escaping)
    for (const edge of edges.value) {
      if (edge.source === current && !visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return false;
}

function onNodeClick({ node }: { node: Node }) {
  closeContextMenu();
  selectedNodeId.value = node.id;
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
  x:       0,
  y:       0,
  nodeId:  '',
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
  if (!node) { closeContextMenu(); return }

  const newNode: Node = {
    id:       `node-${ Date.now() }`,
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
  deleteNodeById(contextMenu.nodeId);
}

function onPaneClick() {
  closeContextMenu();
  selectedNodeId.value = null;
  emit('node-selected', null);
}

function deleteNodeById(nodeId: string) {
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
    selectedNodeId.value = null;
    emit('node-selected', null);
    emit('workflow-changed');
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Delete' || event.key === 'Backspace') {
    // Don't intercept if user is typing in an input field
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (selectedNodeId.value) {
      event.preventDefault();
      deleteNodeById(selectedNodeId.value);
    }
  }
}

function updateNodeLabel(nodeId: string, label: string) {
  const node = nodes.value.find(n => n.id === nodeId);
  if (node?.data) {
    (node.data as WorkflowNodeData).label = label;
  }
}

function updateNodeConfig(nodeId: string, config: Record<string, any>) {
  const node = nodes.value.find(n => n.id === nodeId);
  if (node?.data) {
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
    nodes: nodes.value.map(n => {
      // Deep-copy node data but strip runtime execution state —
      // execution state belongs in PostgreSQL (workflow_checkpoints),
      // not in the YAML definition file.
      const { execution, ...configData } = n.data as Record<string, unknown>;

      return {
        id:       n.id,
        type:     n.type,
        position: { x: n.position.x, y: n.position.y },
        data:     JSON.parse(JSON.stringify(configData)),
      };
    }),
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

/**
 * Update the execution state of a single workflow node on the vue-flow canvas.
 *
 * Called by `AgentEditor.vue` in response to `node_started`, `node_completed`,
 * and `node_failed` events from `EditorChatInterface.onWorkflowEvent()`.
 *
 * The execution object controls the node's visual status indicator (color, icon)
 * and stores runtime data (output, error, threadId, timestamps) that the node
 * detail panel can display.
 *
 * **Event flow:** Graph.emitPlaybookEvent() → WebSocket → EditorChatInterface
 * → AgentEditor.vue → this method
 *
 * @param nodeId    ID of the workflow node to update
 * @param execution New execution state, or `undefined` to clear it
 */
function updateNodeExecution(nodeId: string, execution: WorkflowNodeExecutionState | undefined) {
  const node = nodes.value.find(n => n.id === nodeId);
  if (node?.data) {
    (node.data as WorkflowNodeData).execution = execution;
  }
}

/**
 * Reset all nodes and edges to their pre-execution visual state.
 *
 * Called by `AgentEditor.vue` in response to `workflow_started` events, so that
 * a fresh workflow run begins with a clean canvas. Also called when a new
 * workflow is activated via `onWorkflowActivated`.
 *
 * Clears `execution` data from every node and sets `animated = false` on every
 * edge, removing any leftover running/completed indicators from a prior run.
 *
 * **Event flow:** Graph.emitPlaybookEvent('workflow_started') → WebSocket →
 * EditorChatInterface → AgentEditor.vue → this method
 */
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

/**
 * Toggle the animated state of a single edge on the vue-flow canvas.
 *
 * Called by `AgentEditor.vue` in response to `edge_activated` events, which are
 * canvas-only (the chat path in AgentPersonaModel explicitly skips them).
 *
 * Note: Edges are only de-animated when `clearAllExecution()` is called on
 * the next `workflow_started`. There is no explicit de-animation event.
 *
 * **Event flow:** Graph.emitEdgeActivations() → emitPlaybookEvent('edge_activated')
 * → WebSocket → EditorChatInterface → AgentEditor.vue → this method
 *
 * @param sourceId Source node ID of the edge
 * @param targetId Target node ID of the edge
 * @param animated Whether to animate (`true`) or de-animate (`false`) the edge
 */
function setEdgeAnimated(sourceId: string, targetId: string, animated: boolean) {
  const edge = edges.value.find(e => e.source === sourceId && e.target === targetId);
  if (edge) {
    edge.animated = animated;
  }
}

/**
 * Append a thinking/progress message to a node's execution state on the canvas.
 *
 * Called by `AgentEditor.vue` in response to `node_thinking` events, which are
 * canvas-only (the chat path in AgentPersonaModel does not handle them).
 *
 * Requires that `updateNodeExecution` has already been called for this node
 * (i.e. `data.execution` must exist), since thinking messages are only
 * meaningful while a node is actively running.
 *
 * **Event flow:** Graph.emitPlaybookEvent('node_thinking') → WebSocket →
 * EditorChatInterface → AgentEditor.vue → this method
 *
 * @param nodeId  ID of the node to append the thinking message to
 * @param message The thinking message (content, role, kind, timestamp)
 */
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
  outline: none;
}

.workflow-editor :deep(.vue-flow) {
  width: 100%;
  height: 100%;
}

/* Dark theme overrides */
.workflow-editor.dark :deep(.vue-flow) {
  background: var(--bg-page);
}

.workflow-editor.dark :deep(.vue-flow__edge-path) {
  stroke: url(#edge-green-gradient);
  stroke-width: 1.8px;
  stroke-dasharray: 5 5;
  animation: wf-dash 1s linear infinite;
  filter: drop-shadow(0 0 3px rgba(46, 160, 67, 0.3));
}

@keyframes wf-dash {
  to { stroke-dashoffset: -20; }
}

.workflow-editor.dark :deep(.vue-flow__minimap) {
  background: var(--bg-surface, #1e293b);
}

.workflow-editor.dark :deep(.vue-flow__minimap-mask) {
  fill: var(--bg-accent);
}

.workflow-editor.dark :deep(.vue-flow__minimap-node) {
  fill: var(--bg-surface-hover);
}

.workflow-editor.dark :deep(.vue-flow__controls) {
  background: var(--bg-surface-alt);
  border-color: var(--border-strong);
}

.workflow-editor.dark :deep(.vue-flow__controls-button) {
  background: var(--bg-surface-alt);
  border-color: var(--border-strong);
  fill: var(--text-muted);
}

.workflow-editor.dark :deep(.vue-flow__controls-button:hover) {
  background: var(--bg-surface-hover);
}

.workflow-editor.dark :deep(.vue-flow__edge-textbg) {
  fill: var(--bg-surface-alt);
  stroke: var(--border-strong);
  stroke-width: 1;
  rx: 4;
  ry: 4;
}

.workflow-editor.dark :deep(.vue-flow__edge-text) {
  fill: var(--text-muted);
  font-size: var(--fs-code);
  font-family: inherit;
}

.workflow-editor.dark :deep(.vue-flow__background) {
  mask-image: radial-gradient(ellipse at center, black 15%, transparent 65%);
  -webkit-mask-image: radial-gradient(ellipse at center, black 15%, transparent 65%);
}

.workflow-editor.dark :deep(.vue-flow__background pattern circle) {
  fill: hsl(0deg 0% 100% / 62%);
}

/* ── Context menu ── */
.node-context-menu {
  position: fixed;
  z-index: 10001;
  background: var(--bg-surface);
  border: 1px solid var(--bg-surface-hover);
  border-radius: 8px;
  padding: 4px;
  min-width: 160px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.node-context-menu.dark {
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
  color: var(--text-secondary);
  font-size: var(--fs-code);
  border-radius: 5px;
  cursor: pointer;
  text-align: left;
}

.context-menu-item:hover {
  background: var(--bg-surface-alt);
}

.context-menu-item.danger {
  color: var(--text-error);
}

.context-menu-item.danger:hover {
  background: var(--bg-error);
}

.context-menu-divider {
  height: 1px;
  background: var(--bg-surface-hover);
  margin: 4px 6px;
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
  background: var(--bg-surface);
  border-radius: 8px;
  padding: 16px;
  width: 320px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.delete-confirm-title {
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.delete-confirm-text {
  font-size: var(--fs-code);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.delete-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.delete-confirm-btn {
  padding: 6px 14px;
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.delete-confirm-btn.cancel {
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
}

.delete-confirm-btn.cancel:hover {
  background: var(--bg-surface-hover);
}

.delete-confirm-btn.confirm {
  background: var(--status-error);
  color: var(--text-on-accent);
}

.delete-confirm-btn.confirm:hover {
  background: var(--status-error);
}
</style>
