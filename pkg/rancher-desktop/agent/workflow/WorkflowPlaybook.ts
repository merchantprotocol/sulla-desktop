/**
 * WorkflowPlaybook — stateless DAG walker for agent-orchestrated workflows.
 *
 * The playbook integrates into the orchestrating agent's graph loop. The agent
 * remains in control at all times and can stop/switch workflows freely.
 *
 * The playbook:
 * 1. Determines which nodes are ready to execute next
 * 2. For structural nodes (trigger, wait, parallel, merge) — processes them mechanically
 * 3. For sub-agent nodes — spawns independent graphs, returns results to orchestrator
 * 4. For router/condition nodes — builds a prompt so the orchestrating agent decides
 * 5. For response/IO nodes — handles output/transfer
 *
 * All functions are pure — they read/write WorkflowPlaybookState on the agent's
 * state.metadata.activeWorkflow. No live objects are stored.
 */

import type {
  WorkflowDefinition,
  WorkflowNodeSerialized,
  WorkflowEdgeSerialized, WorkflowNodeSubtype,
} from '@pkg/pages/editor/workflow/types';

import type {
  WorkflowPlaybookState,
  PlaybookNodeOutput,
  LoopIterationState,
} from './types';

// Completion contract is now handled exclusively by AgentNode.ts system prompt.
// No duplicate contract appended here — single source of truth.

// ── Playbook initialization ──

/**
 * Create a fresh WorkflowPlaybookState from a workflow definition.
 * Called when the agent activates a workflow (e.g. via execute_workflow tool).
 */
export function createPlaybookState(
  definition: WorkflowDefinition,
  triggerPayload: unknown,
): WorkflowPlaybookState {
  const executionId = `wfp-${ Date.now() }-${ Math.random().toString(36).slice(2, 8) }`;

  // Find trigger nodes — they are the starting frontier
  const triggerNodeIds = definition.nodes
    .filter(n => n.data.category === 'trigger')
    .map(n => n.id);

  if (triggerNodeIds.length === 0) {
    throw new Error(`Workflow "${ definition.id }" has no trigger nodes`);
  }

  // Auto-complete trigger nodes (they just pass through the payload)
  const nodeOutputs: Record<string, PlaybookNodeOutput> = {};
  const now = new Date().toISOString();

  for (const triggerId of triggerNodeIds) {
    const node = definition.nodes.find(n => n.id === triggerId)!;
    nodeOutputs[triggerId] = {
      nodeId:      triggerId,
      label:       node.data.label,
      subtype:     node.data.subtype,
      category:    node.data.category,
      result:      triggerPayload,
      completedAt: now,
    };
  }

  // The initial frontier is the nodes downstream of triggers
  const nextNodeIds = getDownstreamNodes(definition, triggerNodeIds);

  console.log(`[Playbook:createPlaybookState] triggers=[${ triggerNodeIds.join(', ') }], downstream=[${ nextNodeIds.join(', ') }], defNodes=${ definition.nodes.length }, defEdges=${ definition.edges.length }`);
  if (nextNodeIds.length === 0) {
    console.error(`[Playbook:createPlaybookState] WARNING: No downstream nodes from triggers! Workflow will complete immediately.`);
  }

  return {
    workflowId:       definition.id,
    executionId,
    definition,
    currentNodeIds:   nextNodeIds,
    completedNodeIds: [...triggerNodeIds],
    nodeOutputs,
    status:           'running',
    startedAt:        now,
  };
}

// ── DAG helpers ──

function buildForwardEdges(definition: WorkflowDefinition): Map<string, WorkflowEdgeSerialized[]> {
  const map = new Map<string, WorkflowEdgeSerialized[]>();
  for (const node of definition.nodes) {
    map.set(node.id, []);
  }
  for (const edge of definition.edges) {
    map.get(edge.source)?.push(edge);
  }
  return map;
}

function buildReverseEdges(definition: WorkflowDefinition): Map<string, WorkflowEdgeSerialized[]> {
  const map = new Map<string, WorkflowEdgeSerialized[]>();
  for (const node of definition.nodes) {
    map.set(node.id, []);
  }
  for (const edge of definition.edges) {
    map.get(edge.target)?.push(edge);
  }
  return map;
}

function getNode(definition: WorkflowDefinition, nodeId: string): WorkflowNodeSerialized | undefined {
  return definition.nodes.find(n => n.id === nodeId);
}

/**
 * Get downstream node IDs from a set of source nodes (follows all outgoing edges).
 */
function getDownstreamNodes(
  definition: WorkflowDefinition,
  sourceNodeIds: string[],
  selectedHandle?: string,
): string[] {
  const forward = buildForwardEdges(definition);
  const targets = new Set<string>();

  for (const sourceId of sourceNodeIds) {
    const edges = forward.get(sourceId) || [];
    for (const edge of edges) {
      if (selectedHandle && edge.sourceHandle && edge.sourceHandle !== selectedHandle) {
        continue;
      }
      targets.add(edge.target);
    }
  }

  return Array.from(targets);
}

/**
 * Get upstream node outputs for a given node.
 */
function getUpstreamOutputs(
  definition: WorkflowDefinition,
  nodeId: string,
  nodeOutputs: Record<string, PlaybookNodeOutput>,
): PlaybookNodeOutput[] {
  const reverse = buildReverseEdges(definition);
  const incomingEdges = reverse.get(nodeId) || [];
  const outputs: PlaybookNodeOutput[] = [];

  for (const edge of incomingEdges) {
    const output = nodeOutputs[edge.source];
    if (output) outputs.push(output);
  }

  return outputs;
}

/**
 * Detect whether `sourceId` is reachable from `targetId` via forward edges.
 * If so, the edge from sourceId→targetId is a back/feedback edge (e.g. a
 * quality gate's condition-false looping back to the writer).
 */
function isBackEdge(
  definition: WorkflowDefinition,
  sourceId: string,
  targetId: string,
): boolean {
  const forward = buildForwardEdges(definition);
  const visited = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === sourceId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of forward.get(current) || []) {
      queue.push(edge.target);
    }
  }

  return false;
}

/**
 * Check if all upstream dependencies of a node are completed.
 * For loop nodes, handle-aware filtering ensures the loop-back edge
 * doesn't block initial entry, and the loop-entry edge doesn't block re-entry.
 * Back/feedback edges (where the source is downstream of the target) are
 * ignored on first entry — they only gate re-entry after the source has run.
 */
function areUpstreamComplete(
  definition: WorkflowDefinition,
  nodeId: string,
  completedNodeIds: string[],
  loopState?: Record<string, LoopIterationState>,
): boolean {
  const reverse = buildReverseEdges(definition);
  const incomingEdges = reverse.get(nodeId) || [];

  if (incomingEdges.length === 0) return true;

  const completedSet = new Set(completedNodeIds);
  const node = getNode(definition, nodeId);

  // Loop nodes: filter edges based on whether the loop has started iterating
  if (node?.data.subtype === 'loop') {
    const hasStarted = loopState?.[nodeId] !== undefined;
    const relevantEdges = incomingEdges.filter(edge => {
      if (!hasStarted && edge.targetHandle === 'loop-back') return false;
      if (hasStarted && edge.targetHandle === 'loop-entry') return false;
      return true;
    });
    return relevantEdges.length === 0 || relevantEdges.every(edge => completedSet.has(edge.source));
  }

  // Multi-trigger support: when ALL upstream nodes are triggers, require only
  // ONE to be completed (a workflow starts when any trigger fires, not all).
  const allUpstreamAreTriggers = incomingEdges.every(edge => {
    const sourceNode = getNode(definition, edge.source);

    return sourceNode?.data.category === 'trigger';
  });

  if (allUpstreamAreTriggers) {
    return incomingEdges.some(edge => completedSet.has(edge.source));
  }

  // Filter out back/feedback edges — edges where the source is downstream
  // of the current node (e.g. condition-false edges from quality gates back
  // to the writer). These only matter on re-entry, not initial entry.
  const forwardEdges = incomingEdges.filter(edge => {
    if (completedSet.has(edge.source)) return true; // Already completed — always include
    return !isBackEdge(definition, edge.source, nodeId);
  });

  return forwardEdges.length === 0 || forwardEdges.every(edge => completedSet.has(edge.source));
}

// ── Parallel branch detection ──

/**
 * Check if a node is inside a parallel branch — i.e. it's reachable from a
 * parallel node without first passing through a merge node.
 * Uses reverse BFS from the target node back toward the sources.
 */
function isInsideParallelBranch(definition: WorkflowDefinition, nodeId: string): boolean {
  const reverse = buildReverseEdges(definition);
  const visited = new Set<string>();
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const node = getNode(definition, current);
    if (!node) continue;

    // If we hit a parallel node, this node is inside a parallel branch
    if (node.data.subtype === 'parallel') return true;
    // If we hit a merge node, stop traversing this path — it's outside the parallel scope
    if (node.data.subtype === 'merge') continue;

    const incomingEdges = reverse.get(current) || [];
    for (const edge of incomingEdges) {
      if (!visited.has(edge.source)) {
        queue.push(edge.source);
      }
    }
  }

  return false;
}

// ── Loop body helpers ──

/**
 * Get the node ID that connects into a loop node's loop-back handle.
 * This is the "last" node in the loop body.
 */
function getLoopBackSource(definition: WorkflowDefinition, loopNodeId: string): string | undefined {
  const reverse = buildReverseEdges(definition);
  const incomingEdges = reverse.get(loopNodeId) || [];
  const backEdge = incomingEdges.find(e => e.targetHandle === 'loop-back');
  return backEdge?.source;
}

/**
 * Collect all node IDs that form the loop body — the subgraph between
 * the loop-start downstream nodes and the loop-back source node.
 * Uses BFS from bodyStartNodes, stopping at loopNodeId (to avoid escaping the body).
 */
function collectLoopBodyNodes(
  definition: WorkflowDefinition,
  bodyStartNodeIds: string[],
  loopNodeId: string,
): string[] {
  const forward = buildForwardEdges(definition);
  const visited = new Set<string>();
  const queue = [...bodyStartNodeIds];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current) || current === loopNodeId) continue;
    visited.add(current);

    const edges = forward.get(current) || [];
    for (const edge of edges) {
      if (!visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return Array.from(visited);
}

// ── Step result types ──

/** A single node's spawn info used inside a parallel batch. */
export interface ParallelNodeSpawn {
  nodeId:  string;
  agentId: string;
  prompt:  string;
  config:  Record<string, unknown>;
}

export type PlaybookStepResult =
  | { action: 'prompt_agent'; prompt: string; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'prompt_orchestrator'; nodeId: string; prompt: string; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'node_completed'; nodeId: string; result: unknown; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'spawn_sub_agent'; nodeId: string; agentId: string; prompt: string; config: Record<string, unknown>; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'spawn_parallel_agents'; nodes: ParallelNodeSpawn[]; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'spawn_sub_workflow'; nodeId: string; workflowId: string; agentId: string | null; orchestratorPrompt: string; payload: unknown; awaitResponse: boolean; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'workflow_completed'; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'workflow_failed'; error: string; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'wait'; nodeId: string; durationMs: number; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'await_user_input'; nodeId: string; promptText: string; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'execute_tool_call'; nodeId: string; toolName: string; params: Record<string, string>; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'execute_function'; nodeId: string; functionRef: string; inputs: Record<string, string>; integrationAccounts: Record<string, string | null>; timeoutOverride: string | null; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'transfer_workflow'; nodeId: string; targetWorkflowId: string; payload: unknown; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'waiting_for_sub_agents'; blockedNodeIds: string[]; missingUpstream: string[]; updatedPlaybook: WorkflowPlaybookState };

// ── Template resolution ──

interface LoopTemplateContext {
  index:       number;
  currentItem: { nodeId: string; label: string; result: unknown } | null;
}

function resolveTemplate(
  template: string,
  triggerPayload: unknown,
  nodeOutputs: Record<string, PlaybookNodeOutput>,
  upstreamOutputs: PlaybookNodeOutput[],
  loopContext?: LoopTemplateContext,
): string {
  return template.replace(/\{\{(\s*[\w\-. ]+\s*)\}\}/g, (_match, expr: string) => {
    const parts = expr.trim().split('.');
    const name = parts[0];
    const field = parts[1] || 'result';

    if (name === 'trigger') {
      return typeof triggerPayload === 'string' ? triggerPayload : JSON.stringify(triggerPayload ?? '');
    }

    // Handle loop.* variables (for-each mode)
    if (name === 'loop' && loopContext) {
      if (field === 'index') {
        return String(loopContext.index);
      }
      if (field === 'currentItem') {
        const subField = parts[2];
        if (!loopContext.currentItem) return _match;
        if (!subField || subField === 'result') {
          const r = loopContext.currentItem.result;
          return typeof r === 'string' ? r : JSON.stringify(r ?? '');
        }
        if (subField === 'label') return loopContext.currentItem.label;
        if (subField === 'nodeId') return loopContext.currentItem.nodeId;
        return _match;
      }
      return _match;
    }

    // Find by label or nodeId
    const output = upstreamOutputs.find(o => o.label === name || o.nodeId === name) ??
      Object.values(nodeOutputs).find(o => o.label === name || o.nodeId === name);

    if (!output) return _match;
    if (field === 'threadId') return output.threadId ?? '';
    if (field === 'result') {
      return typeof output.result === 'string' ? output.result : JSON.stringify(output.result ?? '');
    }
    return _match;
  });
}

/**
 * Build a LoopTemplateContext for a node if it is inside an active for-each loop.
 */
function getLoopContextForNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
): LoopTemplateContext | undefined {
  if (!playbook.loopState) return undefined;

  for (const iterState of Object.values(playbook.loopState)) {
    if (iterState.bodyNodeIds.includes(nodeId) && iterState.currentItem) {
      return {
        index:       iterState.currentIteration,
        currentItem: iterState.currentItem,
      };
    }
  }
  return undefined;
}

// ── Parallelization ──

/**
 * Node subtypes that cannot run in parallel — they require orchestrator
 * attention, user interaction, or impose temporal constraints.
 * Used to prevent these subtypes from being added downstream of a parallel node.
 */
export const NON_PARALLELIZABLE_SUBTYPES: ReadonlySet<WorkflowNodeSubtype> = new Set([
  'router',
  'condition',
  'user-input',
  'wait',
]);

/**
 * Node subtypes that are safe to execute concurrently via Promise.allSettled.
 */
export function isParallelizable(subtype: WorkflowNodeSubtype): boolean {
  return !NON_PARALLELIZABLE_SUBTYPES.has(subtype);
}

// ── Core: process the next step ──

/**
 * Process the next step(s) in the workflow playbook.
 * Called by the agent's graph loop after each cycle.
 *
 * Returns what action the agent loop should take:
 * - prompt_agent: inject a prompt into agent messages (for router/condition decisions)
 * - node_completed: a node finished mechanically, advance the DAG
 * - spawn_sub_agent: launch an independent agent graph
 * - spawn_parallel_agents: launch multiple independent agent/integration-call graphs concurrently
 * - workflow_completed: all nodes done
 * - workflow_failed: error
 * - wait: pause for a duration
 */
export function processNextStep(playbook: WorkflowPlaybookState): PlaybookStepResult {
  const { definition, currentNodeIds, completedNodeIds, nodeOutputs } = playbook;

  if (playbook.status !== 'running') {
    return {
      action:          'workflow_completed',
      updatedPlaybook: playbook,
    };
  }

  // If there's a pending decision that the agent hasn't resolved yet, re-prompt
  if (playbook.pendingDecision) {
    return {
      action:          'prompt_agent',
      prompt:          playbook.pendingDecision.prompt,
      updatedPlaybook: playbook,
    };
  }

  // Filter to nodes whose upstream dependencies are all complete
  const readyNodes = currentNodeIds.filter(id =>
    areUpstreamComplete(definition, id, completedNodeIds, playbook.loopState),
  );

  console.log(`[Playbook:processNextStep] currentNodeIds=[${ currentNodeIds.join(', ') }], readyNodes=[${ readyNodes.join(', ') }], completedCount=${ completedNodeIds.length }`);

  if (readyNodes.length === 0) {
    if (currentNodeIds.length > 0) {
      // Frontier nodes exist but aren't ready — check WHY
      const reverseEdges = buildReverseEdges(definition);
      const completedSet = new Set(completedNodeIds);
      const allMissing: string[] = [];
      const diagnostics = currentNodeIds.map(id => {
        const incoming = reverseEdges.get(id) || [];
        const missing = incoming.filter(e => !completedSet.has(e.source)).map(e => e.source);
        allMissing.push(...missing);

        return `  ${ id }: ${ incoming.length } incoming, missing=[${ missing.join(', ') }]`;
      });

      // If there are missing upstream nodes, the workflow is NOT done —
      // it's waiting for in-flight sub-agents to complete.
      if (allMissing.length > 0) {
        console.log(`[Playbook:processNextStep] Frontier nodes waiting for upstream:\n${ diagnostics.join('\n') }`);
        return {
          action:          'waiting_for_sub_agents',
          blockedNodeIds:  [...currentNodeIds],
          missingUpstream: [...new Set(allMissing)],
          updatedPlaybook: playbook,
        };
      }

      // All upstream complete but still not ready — something is wrong
      console.error(`[Playbook:processNextStep] Frontier nodes blocked with no missing upstream!\n${ diagnostics.join('\n') }`);
    }

    // Genuinely no more nodes to process — workflow is done
    const now = new Date().toISOString();
    return {
      action:          'workflow_completed',
      updatedPlaybook: {
        ...playbook,
        status:         'completed',
        completedAt:    now,
        currentNodeIds: [],
      },
    };
  }

  // ── Parallel batch detection ──
  // Batching ONLY happens when ready nodes are direct children of an explicit
  // `parallel` node.  All other sibling branches run sequentially.
  if (readyNodes.length > 1) {
    const reverse = buildReverseEdges(definition);

    // Check if all ready nodes share a common parent that is a `parallel` node
    const parallelParentChildren: { nodeId: string; node: WorkflowNodeSerialized }[] = [];

    for (const id of readyNodes) {
      const incoming = reverse.get(id) || [];
      const hasParallelParent = incoming.some((edge) => {
        const parent = getNode(definition, edge.source);

        return parent?.data.subtype === 'parallel';
      });

      if (hasParallelParent) {
        const n = getNode(definition, id);

        if (n && (n.data.subtype === 'agent' || n.data.subtype === 'integration-call' || n.data.subtype === 'tool-call')) {
          parallelParentChildren.push({ nodeId: id, node: n });
        }
      }
    }

    // Only batch if we have 2+ nodes from a parallel parent
    if (parallelParentChildren.length > 1) {
      const triggerPayload = Object.values(nodeOutputs).find(o => o.category === 'trigger')?.result;
      const spawns: ParallelNodeSpawn[] = [];

      for (const { nodeId: pNodeId, node: pNode } of parallelParentChildren) {
        const subtype = pNode.data.subtype;
        const config = pNode.data.config || {};
        const upstreamOutputs = getUpstreamOutputs(definition, pNodeId, nodeOutputs);

        // Build the spawn result for this node (reuse existing handlers)
        const singleResult = processNode(playbook, pNode, subtype, config, upstreamOutputs, triggerPayload);

        // Only batch spawn_sub_agent actions; anything else falls through to sequential
        if (singleResult.action === 'spawn_sub_agent') {
          spawns.push({
            nodeId:  singleResult.nodeId,
            agentId: singleResult.agentId,
            prompt:  singleResult.prompt,
            config:  singleResult.config,
          });
        }
      }

      if (spawns.length > 1) {
        return {
          action:          'spawn_parallel_agents',
          nodes:           spawns,
          updatedPlaybook: playbook,
        };
      }
    }
  }

  // ── Sequential fallback — process the first ready node ──
  const nodeId = readyNodes[0];
  const node = getNode(definition, nodeId);

  if (!node) {
    return {
      action:          'workflow_failed',
      error:           `Node "${ nodeId }" not found in workflow definition`,
      updatedPlaybook: { ...playbook, status: 'failed', error: `Node "${ nodeId }" not found` },
    };
  }

  const subtype = node.data.subtype;
  const config = node.data.config || {};
  const upstreamOutputs = getUpstreamOutputs(definition, nodeId, nodeOutputs);
  const triggerPayload = Object.values(nodeOutputs).find(o => o.category === 'trigger')?.result;

  return processNode(playbook, node, subtype, config, upstreamOutputs, triggerPayload);
}

/**
 * Process a single node based on its subtype.
 */
function processNode(
  playbook: WorkflowPlaybookState,
  node: WorkflowNodeSerialized,
  subtype: WorkflowNodeSubtype,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const nodeId = node.id;

  switch (subtype) {
  // ── Agent nodes — spawn independent graph ──
  case 'agent':
    return handleAgentNode(playbook, nodeId, node, config, upstreamOutputs, triggerPayload);

    // ── Tool call — execute a native tool directly ──
  case 'tool-call':
    return handleNativeToolCallNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Desktop notification — preset tool-call targeting notify_user ──
  case 'desktop-notification':
    return handleNativeToolCallNode(
      playbook,
      nodeId,
      { ...config, toolName: 'notify_user' },
      upstreamOutputs,
      triggerPayload,
    );

    // ── Integration call — execute integration API ──
  case 'integration-call':
    return handleToolCallNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Function — invoke a user-defined function in a runtime container ──
  case 'function':
    return handleFunctionNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Orchestrator prompt — send a message to the orchestrating agent ──
  case 'orchestrator-prompt':
    return handleOrchestratorPromptNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Router — ask the orchestrating agent to decide ──
  case 'router':
    return handleRouterNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Condition — ask the orchestrating agent to evaluate ──
  case 'condition':
    return handleConditionNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Wait — pause execution ──
  case 'wait':
    return handleWaitNode(playbook, nodeId, config);

    // ── Parallel — structural pass-through ──
  case 'parallel':
    return completeNodeAndAdvance(playbook, nodeId, node, upstreamOutputs.map(o => o.result));

    // ── Merge — combine upstream results ──
  case 'merge':
    return completeNodeAndAdvance(playbook, nodeId, node, {
      strategy: config.strategy || 'wait-all',
      merged:   upstreamOutputs.map(o => ({ nodeId: o.nodeId, label: o.label, result: o.result })),
    });

    // ── Loop — iterate body nodes between loop-start and loop-back ──
  case 'loop':
    return handleLoopNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Sub-workflow — load and execute another workflow ──
  case 'sub-workflow':
    return handleSubWorkflowNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Response — send output ──
  case 'response':
    return handleResponseNode(playbook, nodeId, node, config, upstreamOutputs, triggerPayload);

    // ── User input — pause for user ──
  case 'user-input':
    return handleUserInputNode(playbook, nodeId, config);

    // ── Transfer — terminate this workflow and hand off to another ──
  case 'transfer':
    return handleTransferNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

  default:
    return completeNodeAndAdvance(playbook, nodeId, node, null);
  }
}

// ── Node handlers ──

function handleAgentNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  node: WorkflowNodeSerialized,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const agentId = (config.agentId as string) || 'sulla-desktop';
  const orchestratorInstructionsTemplate = (config.orchestratorInstructions as string) || '';

  // Build upstream context summary for the orchestrator
  const upstreamContext = upstreamOutputs
    .map(o => `[${ o.label }]: ${ typeof o.result === 'string' ? o.result : JSON.stringify(o.result) }`)
    .join('\n\n');

  // Resolve templates in orchestrator instructions
  const orchestratorInstructions = orchestratorInstructionsTemplate.trim()
    ? resolveTemplate(orchestratorInstructionsTemplate, triggerPayload, playbook.nodeOutputs, upstreamOutputs, getLoopContextForNode(playbook, nodeId))
    : '';

  // Build the orchestrator planning prompt — the orchestrator will formulate the sub-agent's actual message
  const parts: string[] = [];

  if (orchestratorInstructions) {
    parts.push(orchestratorInstructions);
  }
  if (upstreamContext) {
    parts.push(`\nUpstream context:\n${ upstreamContext }`);
  }
  if (!orchestratorInstructions && !upstreamContext && typeof triggerPayload === 'string') {
    parts.push(triggerPayload);
  }

  const prompt = parts.filter(Boolean).join('\n');

  return {
    action:          'spawn_sub_agent',
    nodeId,
    agentId,
    prompt,
    config,
    updatedPlaybook: playbook,
  };
}

function handleToolCallNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  // Tool calls are processed asynchronously by the graph loop.
  // We return a spawn action so the loop can handle the actual API call.
  const node = getNode(playbook.definition, nodeId)!;
  const defaults = (config.defaults as Record<string, string>) || {};
  const resolvedDefaults: Record<string, string> = {};

  for (const [key, value] of Object.entries(defaults)) {
    resolvedDefaults[key] = resolveTemplate(value, triggerPayload, playbook.nodeOutputs, upstreamOutputs, getLoopContextForNode(playbook, nodeId));
  }

  return {
    action:  'spawn_sub_agent',
    nodeId,
    agentId: '__integration_call__',
    prompt:  '',
    config:  {
      ...config,
      defaults: resolvedDefaults,
    },
    updatedPlaybook: playbook,
  };
}

function handleNativeToolCallNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const toolName = (config.toolName as string) || '';
  const defaults = (config.defaults as Record<string, string>) || {};
  const resolvedParams: Record<string, string> = {};

  for (const [key, value] of Object.entries(defaults)) {
    resolvedParams[key] = resolveTemplate(value, triggerPayload, playbook.nodeOutputs, upstreamOutputs, getLoopContextForNode(playbook, nodeId));
  }

  return {
    action:          'execute_tool_call',
    nodeId,
    toolName,
    params:          resolvedParams,
    updatedPlaybook: playbook,
  };
}

function handleFunctionNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const functionRef = (config.functionRef as string) || '';
  const inputsTemplates = (config.inputs as Record<string, string>) || {};
  const timeoutOverride = (config.timeoutOverride as string | null) ?? null;
  // Integration account bindings map integration slug → accountId (or null
  // meaning "orchestrator picks at runtime"). These are references only —
  // no secret material flows through this step payload. Plaintext values
  // are fetched just-in-time by the runtime via a capability token minted
  // by PlaybookController.
  const integrationAccounts = (config.integrationAccounts as Record<string, string | null>) || {};

  const loopCtx = getLoopContextForNode(playbook, nodeId);
  const resolvedInputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputsTemplates)) {
    resolvedInputs[key] = resolveTemplate(value, triggerPayload, playbook.nodeOutputs, upstreamOutputs, loopCtx);
  }

  return {
    action:          'execute_function',
    nodeId,
    functionRef,
    inputs:          resolvedInputs,
    integrationAccounts,
    timeoutOverride,
    updatedPlaybook: playbook,
  };
}

function handleOrchestratorPromptNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const promptTemplate = (config.prompt as string) || '';

  // Resolve templates in the prompt
  let prompt: string;
  if (promptTemplate.trim()) {
    prompt = resolveTemplate(promptTemplate, triggerPayload, playbook.nodeOutputs, upstreamOutputs, getLoopContextForNode(playbook, nodeId));
  } else {
    // If no prompt specified, pass through upstream context
    const upstreamContext = upstreamOutputs
      .map(o => `[${ o.label }]: ${ typeof o.result === 'string' ? o.result : JSON.stringify(o.result) }`)
      .join('\n\n');
    prompt = upstreamContext || (typeof triggerPayload === 'string' ? triggerPayload : '');
  }

  return {
    action:          'prompt_orchestrator',
    nodeId,
    prompt,
    updatedPlaybook: playbook,
  };
}

function handleRouterNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const classificationPrompt = (config.classificationPrompt as string) || '';
  const routes = (config.routes as { label: string; description: string }[]) || [];

  if (routes.length === 0) {
    return completeNodeAndAdvance(playbook, nodeId, getNode(playbook.definition, nodeId)!, 'no routes configured');
  }

  const routeDescriptions = routes
    .map((r, i) => `${ i + 1 }. "${ r.label }": ${ r.description }`)
    .join('\n');

  const inputContext = upstreamOutputs
    .map(o => `[${ o.label }]: ${ typeof o.result === 'string' ? o.result : JSON.stringify(o.result) }`)
    .join('\n');

  const prompt = `You are at a routing decision point in a workflow.

${ classificationPrompt ? `Context: ${ classificationPrompt }\n` : '' }
${ inputContext ? `Upstream data:\n${ inputContext }\n` : '' }
Choose exactly ONE of these routes:

${ routeDescriptions }

Respond with the route label (e.g. "${ routes[0]?.label || 'Route Name' }").`;

  return {
    action:          'prompt_agent',
    prompt,
    updatedPlaybook: {
      ...playbook,
      pendingDecision: {
        nodeId,
        subtype: 'router',
        prompt,
        routes:  routes.map((r, i) => ({
          label:       r.label,
          description: r.description,
          handleId:    `route-${ i }`,
        })),
      },
    },
  };
}

function handleConditionNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  _triggerPayload: unknown,
): PlaybookStepResult {
  const rules = (config.rules as { field: string; operator: string; value: string }[]) || [];
  const combinator = (config.combinator as string) || 'and';

  const inputContext = upstreamOutputs
    .map(o => `[${ o.label }]: ${ typeof o.result === 'string' ? o.result : JSON.stringify(o.result) }`)
    .join('\n');

  const rulesDescription = rules
    .map(r => `- "${ r.field }" ${ r.operator } "${ r.value }"`)
    .join('\n');

  const prompt = `You are at a condition evaluation point in a workflow.

Evaluate whether the following condition is TRUE or FALSE.

Rules (${ combinator === 'and' ? 'ALL must be true' : 'ANY can be true' }):
${ rulesDescription }

${ inputContext ? `Available data:\n${ inputContext }\n` : '' }
Respond with exactly "true" or "false", nothing else.`;

  return {
    action:          'prompt_agent',
    prompt,
    updatedPlaybook: {
      ...playbook,
      pendingDecision: {
        nodeId,
        subtype: 'condition',
        prompt,
        rules,
      },
    },
  };
}

function handleWaitNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
): PlaybookStepResult {
  const amount = Number(config.delayAmount) || 0;
  const unit = (config.delayUnit as string) || 'seconds';

  const multipliers: Record<string, number> = {
    seconds: 1000,
    minutes: 60_000,
    hours:   3_600_000,
  };

  const durationMs = amount * (multipliers[unit] || 1000);

  return {
    action:          'wait',
    nodeId,
    durationMs,
    updatedPlaybook: playbook,
  };
}

function handleSubWorkflowNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const workflowId = (config.workflowId as string) || '';
  const awaitResponse = config.awaitResponse !== false;
  const agentId = (config.agentId as string) || null;
  const orchestratorPrompt = (config.orchestratorPrompt as string) || '';

  if (!workflowId) {
    const node = getNode(playbook.definition, nodeId)!;
    return completeNodeAndAdvance(playbook, nodeId, node, { error: 'No workflow ID configured' });
  }

  // Determine the payload to pass to the sub-workflow
  const payload = upstreamOutputs.length > 0
    ? upstreamOutputs[upstreamOutputs.length - 1].result
    : triggerPayload;

  return {
    action:          'spawn_sub_workflow',
    nodeId,
    workflowId,
    agentId,
    orchestratorPrompt,
    payload,
    awaitResponse,
    updatedPlaybook: playbook,
  };
}

function handleLoopNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const { definition } = playbook;
  const loopMode = (config.loopMode as string) || 'iterations';
  const maxIterations = Number(config.maxIterations) || 10;
  const condition = (config.condition as string) || '';
  const conditionMode = (config.conditionMode as string) || 'template';
  const node = getNode(definition, nodeId)!;

  // Initialize or retrieve loop state
  const loopState = { ...(playbook.loopState || {}) };
  let iterState = loopState[nodeId];

  // Discover body nodes (once, then cached in loop state)
  const bodyStartNodeIds = getDownstreamNodes(definition, [nodeId], 'loop-start');

  if (bodyStartNodeIds.length === 0) {
    // No body connected — complete immediately via loop-exit
    return completeNodeAndAdvance(playbook, nodeId, node, {
      iteration: 0,
      reason:    'no_body_connected',
    }, 'loop-exit');
  }

  const bodyNodeIds = collectLoopBodyNodes(definition, bodyStartNodeIds, nodeId);

  if (!iterState) {
    // First entry — initialize loop state
    const threadId = `loop_${ nodeId }_${ Date.now() }`;
    iterState = {
      currentIteration:        0,
      threadId,
      accumulatedConversation: [],
      iterationResults:        [],
      bodyNodeIds,
      bodyStartNodeIds,
    };

    // For-each mode: extract items from upstream merge output
    if (loopMode === 'for-each') {
      const mergeOutput = upstreamOutputs.find(o =>
        o.result && typeof o.result === 'object' && Array.isArray((o.result as any).merged),
      );
      const items: { nodeId: string; label: string; result: unknown }[] = mergeOutput
        ? (mergeOutput.result as any).merged
        : [];

      if (items.length === 0) {
        return completeNodeAndAdvance(playbook, nodeId, node, {
          iteration: 0,
          reason:    'for_each_empty_collection',
        }, 'loop-exit');
      }

      iterState.items = items;
      iterState.currentItem = items[0];
    }

    // Ask-orchestrator mode: prompt the orchestrator for iteration count before starting
    if (loopMode === 'ask-orchestrator') {
      const orchestratorPrompt = (config.orchestratorPrompt as string) || 'How many iterations should this loop run? Respond with just a number.';
      loopState[nodeId] = iterState;

      return {
        action:          'prompt_agent',
        prompt:          orchestratorPrompt,
        updatedPlaybook: {
          ...playbook,
          loopState,
          pendingDecision: {
            nodeId,
            subtype: 'loop-ask-orchestrator' as any,
            prompt:  orchestratorPrompt,
          },
        },
      };
    }

    loopState[nodeId] = iterState;

    // Start iteration 0: add body-start nodes to frontier
    return startLoopIteration(playbook, nodeId, iterState, loopState);
  }

  // Re-entry from loop-back — body just completed an iteration
  // Snapshot body outputs before resetting
  const bodyOutputs: Record<string, PlaybookNodeOutput> = {};
  for (const bodyId of bodyNodeIds) {
    if (playbook.nodeOutputs[bodyId]) {
      bodyOutputs[bodyId] = playbook.nodeOutputs[bodyId];

      // Accumulate conversation from body agent nodes
      const output = playbook.nodeOutputs[bodyId];
      if (output.category === 'agent' && output.result) {
        iterState.accumulatedConversation.push({
          role:      'assistant',
          content:   typeof output.result === 'string' ? output.result : JSON.stringify(output.result),
          iteration: iterState.currentIteration,
        });
      }
    }
  }

  iterState.iterationResults.push({
    index: iterState.currentIteration,
    bodyOutputs,
  });

  iterState.currentIteration += 1;

  // For-each mode: check if all items have been iterated
  if (loopMode === 'for-each' && iterState.items) {
    if (iterState.currentIteration >= iterState.items.length) {
      return completeLoop(playbook, nodeId, node, iterState, loopState, 'for_each_complete');
    }
    iterState.currentItem = iterState.items[iterState.currentIteration];
  }

  // Check max iterations (iterations and ask-orchestrator modes)
  if (loopMode !== 'for-each') {
    const effectiveMax = iterState.resolvedMaxIterations ?? maxIterations;
    if (iterState.currentIteration >= effectiveMax) {
      return completeLoop(playbook, nodeId, node, iterState, loopState, loopMode === 'ask-orchestrator' ? 'orchestrator_count_reached' : 'max_iterations');
    }
  }

  // Check stop condition
  if (condition.trim()) {
    if (conditionMode === 'llm') {
      // LLM evaluation — prompt the orchestrator
      const lastBodyOutput = Object.values(bodyOutputs)
        .map(o => `[${ o.label }]: ${ typeof o.result === 'string' ? o.result : JSON.stringify(o.result) }`)
        .join('\n');

      const prompt = `You are evaluating a loop stop condition after iteration ${ iterState.currentIteration }.

Condition to evaluate: ${ condition }

Latest iteration output:
${ lastBodyOutput }

Should the loop STOP? Respond with exactly "true" to stop or "false" to continue.`;

      loopState[nodeId] = iterState;
      return {
        action:          'prompt_agent',
        prompt,
        updatedPlaybook: {
          ...playbook,
          loopState,
          pendingDecision: {
            nodeId,
            subtype: 'loop' as any,
            prompt,
          },
        },
      };
    } else {
      // Template evaluation — resolve variables and check for truthy match
      const loopCtx: LoopTemplateContext = { index: iterState.currentIteration, currentItem: iterState.currentItem || null };
      const resolved = resolveTemplate(condition, triggerPayload, playbook.nodeOutputs, upstreamOutputs, loopCtx);

      // Simple truthy check: if the resolved template equals "true" or the condition contained
      // a "contains" check that matched, stop the loop
      if (resolved.toLowerCase() === 'true' || resolved.toLowerCase() === 'yes') {
        return completeLoop(playbook, nodeId, node, iterState, loopState, 'condition_met');
      }

      // Check "contains" pattern: "{{X.result}} contains Y" → already resolved to "actualValue contains Y"
      const containsMatch = /^(.+?)\s+contains\s+(.+)$/i.exec(resolved);
      if (containsMatch) {
        const [, haystack, needle] = containsMatch;
        if (haystack.toLowerCase().includes(needle.toLowerCase().trim())) {
          return completeLoop(playbook, nodeId, node, iterState, loopState, 'condition_met');
        }
      }
    }
  }

  // Condition not met — start next iteration
  loopState[nodeId] = iterState;
  return startLoopIteration(playbook, nodeId, iterState, loopState);
}

/**
 * Reset body nodes and add body-start nodes to the frontier for a new iteration.
 */
function startLoopIteration(
  playbook: WorkflowPlaybookState,
  loopNodeId: string,
  iterState: LoopIterationState,
  loopState: Record<string, LoopIterationState>,
): PlaybookStepResult {
  const { bodyNodeIds, bodyStartNodeIds } = iterState;

  // Remove body nodes from completedNodeIds
  const bodySet = new Set(bodyNodeIds);
  const updatedCompleted = playbook.completedNodeIds.filter(id => !bodySet.has(id));

  // Clear body node outputs
  const updatedOutputs = { ...playbook.nodeOutputs };
  for (const bodyId of bodyNodeIds) {
    delete updatedOutputs[bodyId];
  }

  // Update frontier: remove loop node, add body-start nodes
  const frontier = new Set(playbook.currentNodeIds);
  frontier.delete(loopNodeId);
  for (const startId of bodyStartNodeIds) {
    frontier.add(startId);
  }

  return {
    action:          'node_completed',
    nodeId:          loopNodeId,
    result:          { continue: true, iteration: iterState.currentIteration },
    updatedPlaybook: {
      ...playbook,
      currentNodeIds:   Array.from(frontier),
      completedNodeIds: updatedCompleted,
      nodeOutputs:      updatedOutputs,
      loopState,
    },
  };
}

/**
 * Finalize a loop — store accumulated results and advance via loop-exit handle.
 */
function completeLoop(
  playbook: WorkflowPlaybookState,
  loopNodeId: string,
  node: WorkflowNodeSerialized,
  iterState: LoopIterationState,
  loopState: Record<string, LoopIterationState>,
  exitReason: string,
): PlaybookStepResult {
  // Clean up body nodes from completedNodeIds so they don't interfere with downstream
  const bodySet = new Set(iterState.bodyNodeIds);
  const updatedCompleted = playbook.completedNodeIds.filter(id => !bodySet.has(id));
  const updatedOutputs = { ...playbook.nodeOutputs };
  for (const bodyId of iterState.bodyNodeIds) {
    delete updatedOutputs[bodyId];
  }

  // Remove loop state for this node (loop is done)
  const updatedLoopState = { ...loopState };
  delete updatedLoopState[loopNodeId];

  const finalResult = {
    totalIterations:  iterState.currentIteration,
    exitReason,
    conversation:     iterState.accumulatedConversation,
    iterationResults: iterState.iterationResults,
    threadId:         iterState.threadId,
  };

  return completeNodeAndAdvance(
    {
      ...playbook,
      completedNodeIds: updatedCompleted,
      nodeOutputs:      updatedOutputs,
      loopState:        Object.keys(updatedLoopState).length > 0 ? updatedLoopState : undefined,
    },
    loopNodeId,
    node,
    finalResult,
    'loop-exit',
  );
}

function handleResponseNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  _node: WorkflowNodeSerialized,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const template = (config.responseTemplate as string) || '';

  // Build upstream context for the orchestrator
  const upstreamContext = upstreamOutputs
    .map(o => `[${ o.label }]: ${ typeof o.result === 'string' ? o.result : JSON.stringify(o.result) }`)
    .join('\n\n');

  let prompt: string;
  if (template.trim()) {
    // The template is an instruction to the orchestrator (e.g. "let the user know what the first step is")
    prompt = `[Workflow Response Node]\nYou need to respond to the user.\n\nInstruction: ${ template }\n\n${ upstreamContext ? `Upstream context:\n${ upstreamContext }\n\n` : '' }Respond directly to the user based on the instruction above.`;
  } else {
    // No template — pass through upstream output as the response instruction
    const passthrough = upstreamOutputs.length > 0
      ? upstreamOutputs.map(o => typeof o.result === 'string' ? o.result : JSON.stringify(o.result)).join('\n\n')
      : String(triggerPayload || '');
    prompt = `[Workflow Response Node]\nRespond to the user with the following:\n\n${ passthrough }`;
  }

  return {
    action:          'prompt_agent',
    prompt,
    updatedPlaybook: {
      ...playbook,
      pendingDecision: {
        nodeId,
        subtype: 'response' as any,
        prompt,
      },
    },
  };
}

function handleUserInputNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
): PlaybookStepResult {
  const promptText = (config.promptText as string) || 'Please provide input:';

  // Pause the workflow and wait for real user input.
  // The orchestrator will present the prompt to the user, then the workflow
  // pauses until the user's next message resolves the pending decision.
  return {
    action:          'await_user_input',
    nodeId,
    promptText,
    updatedPlaybook: {
      ...playbook,
      pendingDecision: {
        nodeId,
        subtype: 'user-input',
        prompt:  promptText,
      },
    },
  };
}

function handleTransferNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
  upstreamOutputs: PlaybookNodeOutput[],
  triggerPayload: unknown,
): PlaybookStepResult {
  const targetWorkflowId = (config.targetWorkflowId as string) || '';

  if (!targetWorkflowId) {
    const node = getNode(playbook.definition, nodeId)!;
    return completeNodeAndAdvance(playbook, nodeId, node, { error: 'No target workflow configured' });
  }

  // Guard: transfer is not allowed inside a loop body
  if (playbook.loopState) {
    for (const [loopNodeId, iterState] of Object.entries(playbook.loopState)) {
      if (iterState.bodyNodeIds.includes(nodeId)) {
        return {
          action:          'workflow_failed',
          error:           `Transfer node "${ nodeId }" cannot be used inside a loop (loop node "${ loopNodeId }"). Use a sub-workflow or response node instead.`,
          updatedPlaybook: { ...playbook, status: 'failed', error: `Transfer inside loop is not allowed` },
        };
      }
    }
  }

  // Guard: transfer is not allowed inside a parallel branch
  if (isInsideParallelBranch(playbook.definition, nodeId)) {
    return {
      action:          'workflow_failed',
      error:           `Transfer node "${ nodeId }" cannot be used inside a parallel branch. Use a sub-workflow or response node instead.`,
      updatedPlaybook: { ...playbook, status: 'failed', error: `Transfer inside parallel branch is not allowed` },
    };
  }

  // Pass the last upstream output as the payload to the target workflow
  const payload = upstreamOutputs.length > 0
    ? upstreamOutputs[upstreamOutputs.length - 1].result
    : triggerPayload;

  return {
    action:          'transfer_workflow',
    nodeId,
    targetWorkflowId,
    payload,
    updatedPlaybook: playbook,
  };
}

// ── DAG advancement ──

/**
 * Mark a node as completed, store its output, and advance the frontier
 * to the next downstream nodes.
 */
function completeNodeAndAdvance(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  node: WorkflowNodeSerialized,
  result: unknown,
  selectedHandle?: string,
): PlaybookStepResult {
  const now = new Date().toISOString();

  const updatedOutputs = {
    ...playbook.nodeOutputs,
    [nodeId]: {
      nodeId,
      label:       node.data.label,
      subtype:     node.data.subtype,
      category:    node.data.category,
      result,
      completedAt: now,
    },
  };

  const updatedCompleted = [...playbook.completedNodeIds, nodeId];

  // Get downstream nodes
  const downstream = getDownstreamNodes(playbook.definition, [nodeId], selectedHandle);

  // Update frontier: remove this node, add downstream (dedup)
  const currentSet = new Set(playbook.currentNodeIds);
  currentSet.delete(nodeId);
  for (const id of downstream) {
    if (!updatedCompleted.includes(id)) {
      currentSet.add(id);
    }
  }

  const updatedCurrentIds = Array.from(currentSet);

  // Check if workflow is done
  const isDone = updatedCurrentIds.length === 0;

  const updatedPlaybook: WorkflowPlaybookState = {
    ...playbook,
    currentNodeIds:   updatedCurrentIds,
    completedNodeIds: updatedCompleted,
    nodeOutputs:      updatedOutputs,
    pendingDecision:  undefined,
    status:           isDone ? 'completed' : 'running',
    completedAt:      isDone ? now : undefined,
  };

  if (isDone) {
    return { action: 'workflow_completed', updatedPlaybook };
  }

  return { action: 'node_completed', nodeId, result, updatedPlaybook };
}

// ── Route matching utilities ──

/**
 * Tokenize a string into lowercase word tokens.
 * Splits on whitespace and common punctuation, filters empties.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean),
  );
}

/**
 * Jaccard similarity between two strings (token-level).
 * Returns a value between 0 (no overlap) and 1 (identical token sets).
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;

  const setAArr = Array.from(setA);

  for (let i = 0; i < setAArr.length; i++) {
    if (setB.has(setAArr[i])) {
      intersection++;
    }
  }

  const setBArr = Array.from(setB);
  const unionSet = new Set(setAArr.concat(setBArr));
  const union = unionSet.size;

  return intersection / union;
}

/** Minimum Jaccard score to consider a route match */
const JACCARD_THRESHOLD = 0.4;
/** Minimum gap between best and second-best scores to avoid ambiguity */
const JACCARD_MARGIN = 0.15;

type RouteMatchResult =
  | { matched: true; route: { label: string; description: string; handleId: string } }
  | { matched: false; reason: 'below_threshold' | 'ambiguous'; scores: { label: string; score: number }[] };

/**
 * Matching cascade for router responses:
 * 1. Exact match (case-insensitive)
 * 2. Jaccard similarity with threshold + margin
 */
function matchRoute(
  response: string,
  routes: { label: string; description: string; handleId: string }[],
): RouteMatchResult {
  const trimmed = response.trim();

  // Step 1: Exact match (case-insensitive)
  const exact = routes.find(r => r.label.toLowerCase() === trimmed.toLowerCase());

  if (exact) {
    return { matched: true, route: exact };
  }

  // Step 2: Jaccard similarity
  const scored = routes.map(r => ({
    route: r,
    score: jaccardSimilarity(trimmed, r.label),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const secondBest = scored[1];

  if (best.score < JACCARD_THRESHOLD) {
    return {
      matched: false,
      reason:  'below_threshold',
      scores:  scored.map(s => ({ label: s.route.label, score: s.score })),
    };
  }

  if (secondBest && (best.score - secondBest.score) < JACCARD_MARGIN) {
    return {
      matched: false,
      reason:  'ambiguous',
      scores:  scored.map(s => ({ label: s.route.label, score: s.score })),
    };
  }

  return { matched: true, route: best.route };
}

// ── Decision resolution ──

/**
 * Called when the orchestrating agent responds to a router/condition/user-input prompt.
 * Resolves the pending decision and advances the DAG.
 */
export function resolveDecision(
  playbook: WorkflowPlaybookState,
  agentResponse: string,
): PlaybookStepResult {
  const decision = playbook.pendingDecision;

  if (!decision) {
    return { action: 'workflow_failed', error: 'No pending decision to resolve', updatedPlaybook: playbook };
  }

  const node = getNode(playbook.definition, decision.nodeId);
  if (!node) {
    return { action: 'workflow_failed', error: `Decision node "${ decision.nodeId }" not found`, updatedPlaybook: playbook };
  }

  switch (decision.subtype) {
  case 'router': {
    const routes = decision.routes || [];
    const response = agentResponse.trim();
    const result = matchRoute(response, routes);

    if (result.matched) {
      return completeNodeAndAdvance(
        { ...playbook, pendingDecision: undefined },
        decision.nodeId,
        node,
        response,
        result.route.handleId,
      );
    }

    // No match — retry once, then fail
    const retryCount = decision.retryCount || 0;
    const failedResult = result as { matched: false; reason: string; scores: { label: string; score: number }[] };

    if (retryCount >= 1) {
      const scoreDetail = failedResult.scores
        .map(s => `"${ s.label }": ${ s.score.toFixed(2) }`)
        .join(', ');

      return {
        action:          'workflow_failed',
        error:           `Router node "${ decision.nodeId }" failed after retry. ` +
                       `Agent response "${ response }" did not match any route. ` +
                       `Reason: ${ failedResult.reason }. Scores: [${ scoreDetail }]`,
        updatedPlaybook: { ...playbook, pendingDecision: undefined },
      };
    }

    // Build retry prompt with explicit route labels
    const routeLabels = routes.map(r => `"${ r.label }"`).join(', ');
    const retryPrompt = `Your previous response "${ response }" did not clearly match any route. ` +
                       `You must respond with EXACTLY one of these route labels: ${ routeLabels }. ` +
                       `Respond with only the label text, nothing else.`;

    return {
      action:          'prompt_agent',
      prompt:          retryPrompt,
      updatedPlaybook: {
        ...playbook,
        pendingDecision: {
          ...decision,
          prompt:     retryPrompt,
          retryCount: retryCount + 1,
        },
      },
    };
  }

  case 'condition': {
    const response = agentResponse.trim().toLowerCase();
    const passed = response === 'true' || response === 'yes';
    const handleId = passed ? 'condition-true' : 'condition-false';

    return completeNodeAndAdvance(
      { ...playbook, pendingDecision: undefined },
      decision.nodeId,
      node,
      passed,
      handleId,
    );
  }

  case 'loop' as any: {
    // LLM condition evaluation response — "true" means stop, "false" means continue
    const response = agentResponse.trim().toLowerCase();
    const shouldStop = response === 'true' || response === 'yes';
    const loopNodeId = decision.nodeId;

    const loopState = { ...(playbook.loopState || {}) };
    const iterState = loopState[loopNodeId];

    if (!iterState) {
      return { action: 'workflow_failed', error: `No loop state for node "${ loopNodeId }"`, updatedPlaybook: playbook };
    }

    const clearedPlaybook = { ...playbook, pendingDecision: undefined };

    if (shouldStop) {
      return completeLoop(clearedPlaybook, loopNodeId, node, iterState, loopState, 'condition_met');
    }

    // Continue iterating
    return startLoopIteration(clearedPlaybook, loopNodeId, iterState, loopState);
  }

  case 'loop-ask-orchestrator' as any: {
    // Orchestrator responded with the number of iterations to run
    const responseText = agentResponse.trim();
    const parsed = parseInt(responseText.replace(/[^0-9]/g, ''), 10);
    const iterationCount = parsed > 0 ? parsed : 0;
    const loopNodeId = decision.nodeId;

    const loopState = { ...(playbook.loopState || {}) };
    const iterState = loopState[loopNodeId];

    if (!iterState) {
      return { action: 'workflow_failed', error: `No loop state for node "${ loopNodeId }"`, updatedPlaybook: playbook };
    }

    const clearedPlaybook = { ...playbook, pendingDecision: undefined };

    if (iterationCount === 0) {
      // Orchestrator said 0 — skip the loop entirely
      return completeLoop(clearedPlaybook, loopNodeId, node, iterState, loopState, 'orchestrator_zero_iterations');
    }

    // Store the resolved count and start iterating
    iterState.resolvedMaxIterations = iterationCount;
    loopState[loopNodeId] = iterState;
    return startLoopIteration({ ...clearedPlaybook, loopState }, loopNodeId, iterState, loopState);
  }

  case 'user-input':
  case 'response': {
    return completeNodeAndAdvance(
      { ...playbook, pendingDecision: undefined },
      decision.nodeId,
      node,
      agentResponse,
    );
  }

  default:
    return completeNodeAndAdvance(
      { ...playbook, pendingDecision: undefined },
      decision.nodeId,
      node,
      agentResponse,
    );
  }
}

/**
 * Called when a sub-agent node completes. Stores the result and advances the DAG.
 */
export function completeSubAgent(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  result: unknown,
  threadId?: string,
): PlaybookStepResult {
  const node = getNode(playbook.definition, nodeId);
  if (!node) {
    return { action: 'workflow_failed', error: `Sub-agent node "${ nodeId }" not found`, updatedPlaybook: playbook };
  }

  const now = new Date().toISOString();
  const updatedOutputs = {
    ...playbook.nodeOutputs,
    [nodeId]: {
      nodeId,
      label:       node.data.label,
      subtype:     node.data.subtype,
      category:    node.data.category,
      result,
      threadId,
      completedAt: now,
    },
  };

  const updatedCompleted = [...playbook.completedNodeIds, nodeId];
  const downstream = getDownstreamNodes(playbook.definition, [nodeId]);

  const currentSet = new Set(playbook.currentNodeIds);
  currentSet.delete(nodeId);
  for (const id of downstream) {
    if (!updatedCompleted.includes(id)) {
      currentSet.add(id);
    }
  }

  const updatedCurrentIds = Array.from(currentSet);
  const isDone = updatedCurrentIds.length === 0;

  const updatedPlaybook: WorkflowPlaybookState = {
    ...playbook,
    currentNodeIds:   updatedCurrentIds,
    completedNodeIds: updatedCompleted,
    nodeOutputs:      updatedOutputs,
    pendingDecision:  undefined,
    status:           isDone ? 'completed' : 'running',
    completedAt:      isDone ? now : undefined,
  };

  if (isDone) {
    return { action: 'workflow_completed', updatedPlaybook };
  }

  return { action: 'node_completed', nodeId, result, updatedPlaybook };
}

/**
 * Abort the active workflow.
 */
export function abortPlaybook(playbook: WorkflowPlaybookState): WorkflowPlaybookState {
  return {
    ...playbook,
    status:          'aborted',
    completedAt:     new Date().toISOString(),
    pendingDecision: undefined,
  };
}
