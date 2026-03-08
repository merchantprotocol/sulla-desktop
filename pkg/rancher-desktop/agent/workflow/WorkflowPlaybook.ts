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
  WorkflowEdgeSerialized,
} from '@pkg/pages/editor/workflow/types';

import type { WorkflowNodeSubtype } from '@pkg/pages/editor/workflow/types';

import type {
  WorkflowPlaybookState,
  PlaybookNodeOutput,
} from './types';

// ── Default hand-back contract ──
// Appended to every sub-agent prompt so the orchestrator gets a structured response.
// Can be overridden per agent node via the completionContract config field.

export const DEFAULT_HANDBACK_CONTRACT = `

--- COMPLETION CONTRACT ---
When you have finished your work, you MUST end your final message with the following structured hand-back block. This is required for the orchestrator to process your results.

HAND_BACK
Summary: [1-3 paragraph summary of what was accomplished, key decisions made, and any important context]
Artifact: [file path to the primary output artifact, or "none" if no file was created]
Needs user input: [yes/no — whether the user needs to review or approve before proceeding]
Suggested next action: [optional — what should happen next in the workflow]
--- END CONTRACT ---
`;

// ── Playbook initialization ──

/**
 * Create a fresh WorkflowPlaybookState from a workflow definition.
 * Called when the agent activates a workflow (e.g. via execute_workflow tool).
 */
export function createPlaybookState(
  definition: WorkflowDefinition,
  triggerPayload: unknown,
): WorkflowPlaybookState {
  const executionId = `wfp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Find trigger nodes — they are the starting frontier
  const triggerNodeIds = definition.nodes
    .filter(n => n.data.category === 'trigger')
    .map(n => n.id);

  if (triggerNodeIds.length === 0) {
    throw new Error(`Workflow "${definition.id}" has no trigger nodes`);
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
 * Check if all upstream dependencies of a node are completed.
 */
function areUpstreamComplete(
  definition: WorkflowDefinition,
  nodeId: string,
  completedNodeIds: string[],
): boolean {
  const reverse = buildReverseEdges(definition);
  const incomingEdges = reverse.get(nodeId) || [];

  if (incomingEdges.length === 0) return true;

  const completedSet = new Set(completedNodeIds);
  return incomingEdges.every(edge => completedSet.has(edge.source));
}

// ── Step result types ──

/** A single node's spawn info used inside a parallel batch. */
export interface ParallelNodeSpawn {
  nodeId: string;
  agentId: string;
  prompt: string;
  config: Record<string, unknown>;
}

export type PlaybookStepResult =
  | { action: 'prompt_agent'; prompt: string; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'node_completed'; nodeId: string; result: unknown; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'spawn_sub_agent'; nodeId: string; agentId: string; prompt: string; config: Record<string, unknown>; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'spawn_parallel_agents'; nodes: ParallelNodeSpawn[]; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'spawn_sub_workflow'; nodeId: string; workflowId: string; payload: unknown; awaitResponse: boolean; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'workflow_completed'; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'workflow_failed'; error: string; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'wait'; nodeId: string; durationMs: number; updatedPlaybook: WorkflowPlaybookState }
  | { action: 'await_user_input'; nodeId: string; promptText: string; updatedPlaybook: WorkflowPlaybookState };

// ── Template resolution ──

function resolveTemplate(
  template: string,
  triggerPayload: unknown,
  nodeOutputs: Record<string, PlaybookNodeOutput>,
  upstreamOutputs: PlaybookNodeOutput[],
): string {
  return template.replace(/\{\{(\s*[\w\-. ]+\s*)\}\}/g, (_match, expr: string) => {
    const parts = expr.trim().split('.');
    const name = parts[0];
    const field = parts[1] || 'result';

    if (name === 'trigger') {
      return typeof triggerPayload === 'string' ? triggerPayload : JSON.stringify(triggerPayload ?? '');
    }

    // Find by label or nodeId
    const output = upstreamOutputs.find(o => o.label === name || o.nodeId === name)
      ?? Object.values(nodeOutputs).find(o => o.label === name || o.nodeId === name);

    if (!output) return _match;
    if (field === 'threadId') return output.threadId ?? '';
    if (field === 'result') {
      return typeof output.result === 'string' ? output.result : JSON.stringify(output.result ?? '');
    }
    return _match;
  });
}

// ── Parallelization ──

/**
 * Node subtypes that cannot run in parallel — they require orchestrator
 * attention, user interaction, or impose temporal constraints.
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
function isParallelizable(subtype: WorkflowNodeSubtype): boolean {
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
 * - spawn_parallel_agents: launch multiple independent agent/tool-call graphs concurrently
 * - workflow_completed: all nodes done
 * - workflow_failed: error
 * - wait: pause for a duration
 */
export function processNextStep(playbook: WorkflowPlaybookState): PlaybookStepResult {
  const { definition, currentNodeIds, completedNodeIds, nodeOutputs } = playbook;

  if (playbook.status !== 'running') {
    return {
      action: 'workflow_completed',
      updatedPlaybook: playbook,
    };
  }

  // If there's a pending decision that the agent hasn't resolved yet, re-prompt
  if (playbook.pendingDecision) {
    return {
      action: 'prompt_agent',
      prompt: playbook.pendingDecision.prompt,
      updatedPlaybook: playbook,
    };
  }

  // Filter to nodes whose upstream dependencies are all complete
  const readyNodes = currentNodeIds.filter(id =>
    areUpstreamComplete(definition, id, completedNodeIds),
  );

  if (readyNodes.length === 0) {
    // No more nodes to process — workflow is done
    const now = new Date().toISOString();
    return {
      action: 'workflow_completed',
      updatedPlaybook: {
        ...playbook,
        status: 'completed',
        completedAt: now,
        currentNodeIds: [],
      },
    };
  }

  // ── Parallel batch detection ──
  // When multiple ready nodes are all parallelizable (agent/tool-call/response/sub-workflow),
  // batch them into a single spawn_parallel_agents action for concurrent execution.
  if (readyNodes.length > 1) {
    const parallelizableNodes: Array<{ nodeId: string; node: WorkflowNodeSerialized }> = [];

    for (const id of readyNodes) {
      const n = getNode(definition, id);
      if (n && isParallelizable(n.data.subtype) && (n.data.subtype === 'agent' || n.data.subtype === 'tool-call')) {
        parallelizableNodes.push({ nodeId: id, node: n });
      }
    }

    // Only batch if we have 2+ parallelizable spawn nodes
    if (parallelizableNodes.length > 1) {
      const triggerPayload = Object.values(nodeOutputs).find(o => o.category === 'trigger')?.result;
      const spawns: ParallelNodeSpawn[] = [];

      for (const { nodeId: pNodeId, node: pNode } of parallelizableNodes) {
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
          action: 'spawn_parallel_agents',
          nodes: spawns,
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
      action: 'workflow_failed',
      error: `Node "${nodeId}" not found in workflow definition`,
      updatedPlaybook: { ...playbook, status: 'failed', error: `Node "${nodeId}" not found` },
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

    // ── Tool call — execute integration API ──
    case 'tool-call':
      return handleToolCallNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

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
        merged: upstreamOutputs.map(o => ({ nodeId: o.nodeId, label: o.label, result: o.result })),
      });

    // ── Loop — check iteration count ──
    case 'loop':
      return handleLoopNode(playbook, nodeId, config);

    // ── Sub-workflow — load and execute another workflow ──
    case 'sub-workflow':
      return handleSubWorkflowNode(playbook, nodeId, config, upstreamOutputs, triggerPayload);

    // ── Response — send output ──
    case 'response':
      return handleResponseNode(playbook, nodeId, node, config, upstreamOutputs, triggerPayload);

    // ── User input — pause for user ──
    case 'user-input':
      return handleUserInputNode(playbook, nodeId, config);

    // ── Transfer — hand off to another workflow ──
    case 'transfer':
      return completeNodeAndAdvance(playbook, nodeId, node, { transferred: config.targetWorkflowId });

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
  const agentId = (config.agentId as string) || '';
  const additionalPrompt = (config.additionalPrompt as string) || '';
  const userMessageTemplate = (config.userMessage as string) || '';

  let prompt: string;
  if (userMessageTemplate.trim()) {
    prompt = resolveTemplate(userMessageTemplate, triggerPayload, playbook.nodeOutputs, upstreamOutputs);
    if (additionalPrompt) {
      prompt = `${additionalPrompt}\n\n${prompt}`;
    }
  } else {
    const upstreamContext = upstreamOutputs
      .map(o => `[${o.label}]: ${typeof o.result === 'string' ? o.result : JSON.stringify(o.result)}`)
      .join('\n\n');

    prompt = [
      additionalPrompt,
      upstreamContext ? `\nUpstream context:\n${upstreamContext}` : '',
      typeof triggerPayload === 'string' && upstreamOutputs.length === 0 ? triggerPayload : '',
    ].filter(Boolean).join('\n');
  }

  // Append the completion contract — custom override or default
  const completionContract = (config.completionContract as string) || '';
  prompt += completionContract.trim() ? `\n\n${completionContract}` : DEFAULT_HANDBACK_CONTRACT;

  return {
    action: 'spawn_sub_agent',
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
    resolvedDefaults[key] = resolveTemplate(value, triggerPayload, playbook.nodeOutputs, upstreamOutputs);
  }

  return {
    action: 'spawn_sub_agent',
    nodeId,
    agentId: '__tool_call__',
    prompt: '',
    config: {
      ...config,
      defaults: resolvedDefaults,
    },
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
  const routes = (config.routes as Array<{ label: string; description: string }>) || [];

  if (routes.length === 0) {
    return completeNodeAndAdvance(playbook, nodeId, getNode(playbook.definition, nodeId)!, 'no routes configured');
  }

  const routeDescriptions = routes
    .map((r, i) => `${i + 1}. "${r.label}": ${r.description}`)
    .join('\n');

  const inputContext = upstreamOutputs
    .map(o => `[${o.label}]: ${typeof o.result === 'string' ? o.result : JSON.stringify(o.result)}`)
    .join('\n');

  const prompt = `You are at a routing decision point in a workflow.

${classificationPrompt ? `Context: ${classificationPrompt}\n` : ''}
${inputContext ? `Upstream data:\n${inputContext}\n` : ''}
Choose exactly ONE of these routes by responding with ONLY the route label:

${routeDescriptions}

Respond with the exact label text of your chosen route, nothing else.`;

  return {
    action: 'prompt_agent',
    prompt,
    updatedPlaybook: {
      ...playbook,
      pendingDecision: {
        nodeId,
        subtype: 'router',
        prompt,
        routes: routes.map((r, i) => ({
          label: r.label,
          description: r.description,
          handleId: `route-${i}`,
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
  const rules = (config.rules as Array<{ field: string; operator: string; value: string }>) || [];
  const combinator = (config.combinator as string) || 'and';

  const inputContext = upstreamOutputs
    .map(o => `[${o.label}]: ${typeof o.result === 'string' ? o.result : JSON.stringify(o.result)}`)
    .join('\n');

  const rulesDescription = rules
    .map(r => `- "${r.field}" ${r.operator} "${r.value}"`)
    .join('\n');

  const prompt = `You are at a condition evaluation point in a workflow.

Evaluate whether the following condition is TRUE or FALSE.

Rules (${combinator === 'and' ? 'ALL must be true' : 'ANY can be true'}):
${rulesDescription}

${inputContext ? `Available data:\n${inputContext}\n` : ''}
Respond with exactly "true" or "false", nothing else.`;

  return {
    action: 'prompt_agent',
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
    action: 'wait',
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

  if (!workflowId) {
    const node = getNode(playbook.definition, nodeId)!;
    return completeNodeAndAdvance(playbook, nodeId, node, { error: 'No workflow ID configured' });
  }

  // Determine the payload to pass to the sub-workflow
  const payload = upstreamOutputs.length > 0
    ? upstreamOutputs[upstreamOutputs.length - 1].result
    : triggerPayload;

  return {
    action: 'spawn_sub_workflow',
    nodeId,
    workflowId,
    payload,
    awaitResponse,
    updatedPlaybook: playbook,
  };
}

function handleLoopNode(
  playbook: WorkflowPlaybookState,
  nodeId: string,
  config: Record<string, unknown>,
): PlaybookStepResult {
  const maxIterations = Number(config.maxIterations) || 10;
  const iterKey = `__loop_${nodeId}_iteration`;

  // Track iterations in nodeOutputs as a side-channel
  const currentIteration = (playbook.nodeOutputs[iterKey]?.result as number) || 0;

  if (currentIteration >= maxIterations) {
    const node = getNode(playbook.definition, nodeId)!;
    return completeNodeAndAdvance(playbook, nodeId, node, {
      continue: false,
      iteration: currentIteration,
      reason: 'max_iterations',
    });
  }

  // Increment iteration counter and continue the loop
  const now = new Date().toISOString();
  const updatedOutputs = {
    ...playbook.nodeOutputs,
    [iterKey]: {
      nodeId:      iterKey,
      label:       'loop_counter',
      subtype:     'loop' as WorkflowNodeSubtype,
      category:    'flow-control' as const,
      result:      currentIteration + 1,
      completedAt: now,
    },
  };

  const node = getNode(playbook.definition, nodeId)!;
  return completeNodeAndAdvance(
    { ...playbook, nodeOutputs: updatedOutputs },
    nodeId,
    node,
    { continue: true, iteration: currentIteration + 1 },
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
    .map(o => `[${o.label}]: ${typeof o.result === 'string' ? o.result : JSON.stringify(o.result)}`)
    .join('\n\n');

  let prompt: string;
  if (template.trim()) {
    // The template is an instruction to the orchestrator (e.g. "let the user know what the first step is")
    prompt = `[Workflow Response Node]\nYou need to respond to the user.\n\nInstruction: ${template}\n\n${upstreamContext ? `Upstream context:\n${upstreamContext}\n\n` : ''}Respond directly to the user based on the instruction above.`;
  } else {
    // No template — pass through upstream output as the response instruction
    const passthrough = upstreamOutputs.length > 0
      ? upstreamOutputs.map(o => typeof o.result === 'string' ? o.result : JSON.stringify(o.result)).join('\n\n')
      : String(triggerPayload || '');
    prompt = `[Workflow Response Node]\nRespond to the user with the following:\n\n${passthrough}`;
  }

  return {
    action: 'prompt_agent',
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
    action: 'await_user_input',
    nodeId,
    promptText,
    updatedPlaybook: {
      ...playbook,
      pendingDecision: {
        nodeId,
        subtype: 'user-input',
        prompt: promptText,
      },
    },
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
    return { action: 'workflow_failed', error: `Decision node "${decision.nodeId}" not found`, updatedPlaybook: playbook };
  }

  switch (decision.subtype) {
    case 'router': {
      const routes = decision.routes || [];
      const response = agentResponse.trim();
      const matchedRoute = routes.find(
        r => r.label.toLowerCase() === response.toLowerCase(),
      );
      const handleId = matchedRoute?.handleId || routes[0]?.handleId || 'route-0';

      return completeNodeAndAdvance(
        { ...playbook, pendingDecision: undefined },
        decision.nodeId,
        node,
        response,
        handleId,
      );
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
    return { action: 'workflow_failed', error: `Sub-agent node "${nodeId}" not found`, updatedPlaybook: playbook };
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
    status: 'aborted',
    completedAt: new Date().toISOString(),
    pendingDecision: undefined,
  };
}
