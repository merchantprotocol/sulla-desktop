// Graph - LangGraph-style workflow orchestrator
// sits on the backend and processes the graphs

import type { AbortService } from '../services/AbortService';
import { throwIfAborted } from '../services/AbortService';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getConversationLogger } from '../services/ConversationLogger';
import { InputHandlerNode } from './InputHandlerNode';
import { AgentNode } from './AgentNode';
import { HeartbeatNode, type HeartbeatThreadState } from './HeartbeatNode';
import type { WorkflowPlaybookState, PlaybookNodeOutput } from '../workflow/types';
import {
  processNextStep,
  resolveDecision,
  completeSubAgent,
  type PlaybookStepResult,
} from '../workflow/WorkflowPlaybook';

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================

const DEFAULT_WS_CHANNEL = 'heartbeat';
const MAX_CONSECTUIVE_LOOP = 40;
const MAX_MESSAGES_IN_THREAD = 120;

// ── Hand-back parser ──

interface ParsedHandBack {
  summary: string;
  artifact: string;
  needsUserInput: boolean;
  suggestedNextAction: string;
  rawOutput: string;
}

/**
 * Parse the structured HAND_BACK block from a sub-agent's output.
 * Returns parsed fields if found, or a fallback with the raw output as summary.
 */
function parseHandBack(output: string): ParsedHandBack {
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  const handBackIndex = raw.indexOf('HAND_BACK');

  if (handBackIndex === -1) {
    // No hand-back block — treat the entire output as the summary
    return {
      summary: raw.substring(0, 500),
      artifact: 'none',
      needsUserInput: false,
      suggestedNextAction: '',
      rawOutput: raw,
    };
  }

  const handBackSection = raw.substring(handBackIndex);

  const extractField = (field: string): string => {
    const regex = new RegExp(`${field}:\\s*(.+?)(?:\\n|$)`, 'i');
    const match = handBackSection.match(regex);
    return match?.[1]?.trim() || '';
  };

  return {
    summary: extractField('Summary') || raw.substring(0, handBackIndex).trim().substring(0, 500),
    artifact: extractField('Artifact') || 'none',
    needsUserInput: /^yes$/i.test(extractField('Needs user input')),
    suggestedNextAction: extractField('Suggested next action'),
    rawOutput: raw,
  };
}

// ============================================================================
// THREAD STATE INTERFACES
// ============================================================================

/**
 * Generic node interface for any graph execution.
 * Nodes MUST ONLY write facts/verdicts to state — no routing decisions.
 * @template TState - Specific state shape (BaseThreadState, OverlordThreadState, etc.)
 */
export interface GraphNode<TState> {
  /** Unique node identifier (must be graph-unique, e.g. 'tactical_executor') */
  id: string;

  /** Human-readable name for logs/debug */
  name: string;

  /**
   * Core execution logic.
   * - Perform work (plan, execute, critique, write, etc.)
   * - Mutate state.metadata with results/facts only
   * - Return neutral decision (graph edges handle real next node)
   */
  execute(state: TState): Promise<NodeResult<TState>>;

  /** Optional: one-time setup (LLM init, tool registration, etc.) */
  initialize?(): Promise<void>;

  /** Optional: cleanup on graph destroy */
  destroy?(): Promise<void>;
}

/**
 * Minimal result type every node must return.
 * Keeps routing out of nodes — edges interpret state facts.
 */
export interface NodeResult<TState> {
  state: TState;                  // mutated/updated state
  decision: NodeDecision;         // neutral signal only
}

// NodeResult must always be one of:
type NodeDecision =
  | { type: 'end' }
  | { type: 'goto', nodeId: string }
  | { type: 'continue' }           // same node, more work
  | { type: 'next' }               // follow static/conditional edge
  | { type: 'revise' }             // go back to planner/critic

export interface GraphEdge<TState> {
  from: string;
  to: string | ((state: TState) => string | null);
}

// Base shared across all thread states
export interface BaseThreadState {
  messages: ChatMessage[];

  // for simple node
  prompt?: string;

  // Tools found by browse_tools calls (accumulates across multiple calls)
  foundTools?: any[];

  metadata: {
    action: 'direct_answer' | 'ask_clarification' | 'use_tools' | 'create_plan' | 'run_again';
    threadId: string;
    wsChannel: string;
    /** Conversation logger ID — set by workflow agent handler or graph creator */
    conversationId?: string;
    /** Parent conversation ID (e.g. the workflow execution that spawned this graph) */
    parentConversationId?: string;

    reasoning?: string;

    llmModel: string;
    llmLocal: boolean;

    cycleComplete: boolean;
    waitingForUser: boolean;

    options: {
      abort?: AbortService;
    };

    currentNodeId: string;
    consecutiveSameNode: number;
    iterations: number;
    revisionCount: number;
    maxIterationsReached: boolean;

    memory: {
      knowledgeBaseContext: string;
      chatSummariesContext: string;
    };

    // any graph could technically call another graph, this is the format
    subGraph: {
      state: 'trigger_subgraph' | 'running' | 'completed' | 'failed';
      name: 'hierarchical';
      prompt: string;
      response: string;
    };

    finalSummary: string;
    totalSummary?: string;
    finalState: 'failed'  | 'running' | 'completed';
    n8nLiveEventsEnabled?: boolean;

    // parent graph return
    returnTo: string | null;

    awarenessIncluded?: boolean;
    datetimeIncluded?: boolean;
    hadToolCalls?: boolean;
    hadUserMessages?: boolean;

    /** When set, workflow tools (list/execute) are scoped to only this workflow */
    scopedWorkflowId?: string;

    /** Active workflow playbook — when set, the agent orchestrates this workflow */
    activeWorkflow?: WorkflowPlaybookState;
  };
}

/**
 * AgentGraph-specific thread state interface
 * Minimal state for the independent agent graph (InputHandler → Agent loop)
 */
export interface AgentGraphState extends BaseThreadState {
  metadata: BaseThreadState['metadata'] & {
    agent?: {
      // Config (loaded at graph creation from agent.yaml)
      name?: string;
      description?: string;
      type?: string;
      skills?: string[];
      tools?: string[];         // allowlist of tool names
      prompt?: string;          // compiled .md files, no variable substitution

      // Execution outcomes (set during runtime)
      status?: 'done' | 'blocked' | 'continue' | 'in_progress';
      status_report?: string | null;
      response?: string | null;
      blocker_reason?: string | null;
      unblock_requirements?: string | null;
      updatedAt?: number;
    };
    agentLoopCount?: number;
  };
}

// Back-compat alias while callers migrate to AgentGraph naming.
export type GeneralGraphState = AgentGraphState;

// Back-compat: OverlordThreadState is now HeartbeatThreadState
export type OverlordThreadState = HeartbeatThreadState;
export type { HeartbeatThreadState };

// ============================================================================
//
// Graph Class
//
//
//
// ============================================================================

/**
 * Generic Graph engine for hierarchical agent execution.
 * 
 * Supports any state shape via generics (TState).
 * - Nodes write facts/verdicts only
 * - Edges own all routing/advancement logic
 * - Handles abort, loop safety, WS completion signal
 * - Works standalone or as sub-graph (with returnTo flag)
 * 
 * Usage:
 *   const graph = new Graph<BaseThreadState>();
 *   graph.addNode(new InputHandlerNode());
 *   graph.setEntryPoint('input_handler');
 *   const finalState = await graph.execute(initialState);
 * 
 * @template TState - State interface (ThreadState, BaseThreadState, etc.)
 */
export class Graph<TState = BaseThreadState> {
  private nodes: Map<string, GraphNode<TState>> = new Map();
  private edges: Map<string, GraphEdge<TState>[]> = new Map();
  private entryPoint: string | null = null;
  private endPoints: Set<string> = new Set();
  private initialized = false;

  /**
   * Add a node to the graph.
   * @param node - Node instance implementing GraphNode<TState>
   * @returns this for chaining
   */
  addNode(node: GraphNode<TState>): this {
    this.nodes.set(node.id, node);
    return this;
  }

  /**
   * Add a static or conditional edge.
   * @param from - Starting node ID
   * @param to - Target node ID or conditional function (state => nextId | null)
   * @returns this for chaining
   */
  addEdge(
    from: string,
    to: string | ((state: TState) => string | null)
  ): this {
    const list = this.edges.get(from) || [];
    list.push({ from, to });
    this.edges.set(from, list);
    return this;
  }

  /**
   * Convenience alias for conditional edges.
   * @param from - Starting node ID
   * @param condition - Function returning next node ID or null
   * @returns this for chaining
   */
  addConditionalEdge(
    from: string,
    condition: (state: TState) => string | null
  ): this {
    return this.addEdge(from, condition);
  }

  /**
   * Set the starting node.
   * @param nodeId - Node ID to begin execution
   * @returns this for chaining
   */
  setEntryPoint(nodeId: string): this {
    this.entryPoint = nodeId;
    return this;
  }

  /**
   * Mark nodes as valid termination points.
   * @param nodeIds - Node IDs where execution can end
   * @returns this for chaining
   */
  setEndPoints(...nodeIds: string[]): this {
    nodeIds.forEach(id => this.endPoints.add(id));
    return this;
  }

  /**
   * Initialize all nodes (call initialize() if present).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    for (const node of this.nodes.values()) {
      if (node.initialize) await node.initialize();
    }
    this.initialized = true;
  }

  /**
   * Get node by ID for testing and validation purposes
   * @param nodeId - The node identifier
   * @returns The node instance or undefined if not found
   */
  getNode(nodeId: string): GraphNode<TState> | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Get all node IDs for validation purposes
   * @returns Array of all registered node IDs
   */
  getNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Execute the graph from entry point until end or max iterations.
   * 
   * @param initialState - Starting state (TState)
   * @param maxIterations - Safety limit (default 1M)
   * @param options - Optional abort controller
   * @returns Final state after execution
   */
  async execute(
    initialState: TState,
    entryPointNodeId?: string,
    options?: { maxIterations: number; _isPlaybookReentry?: boolean }
  ): Promise<TState> {
    if (!this.entryPoint) throw new Error('No entry point');

    await this.initialize();

    let state = initialState;
    (state as any).metadata.currentNodeId = entryPointNodeId || this.entryPoint;

    console.log(`[Graph] Start from ${(state as any).metadata.currentNodeId}`);

    // Conversation logging (skip on playbook re-entry to avoid duplicates)
    const isReentry = options?._isPlaybookReentry ?? false;
    const convId = (state as any).metadata.conversationId;
    if (convId && !isReentry) {
      const convLogger = getConversationLogger();
      const agentName = (state as any).metadata.agent?.name || (state as any).metadata.wsChannel || 'unknown';
      const parentId = (state as any).metadata.parentConversationId;
      convLogger.logGraphStarted(convId, agentName, {
        agentId: (state as any).metadata.wsChannel,
        channel: (state as any).metadata.wsChannel,
        parentId,
      });
      // Log the initial user message if present
      const msgs = (state as any).messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg?.role === 'user' && lastMsg?.content) {
          convLogger.logMessage(convId, 'user', String(lastMsg.content));
        }
      }
    }

    (state as any).metadata.iterations ??= 0;
    (state as any).metadata.consecutiveSameNode ??= 0;

    const maxIterations = options?.maxIterations ?? 1000000;

    try {
      while ((state as any).metadata.iterations < maxIterations) {
        (state as any).metadata.iterations++;
        
        throwIfAborted(state, 'Graph execution aborted');

        if ((state as any).metadata.waitingForUser && (state as any).metadata.currentNodeId === 'input_handler') {
          console.log('[Graph] Waiting for user at input_handler → forcing end');
          break;
        }

        const node = this.nodes.get((state as any).metadata.currentNodeId);
        if (!node) throw new Error(`Node missing: ${(state as any).metadata.currentNodeId}`);

        console.log(`[Graph] → ${node.name} (${(state as any).metadata.currentNodeId})`);
        const result: NodeResult<TState> = await node.execute(state);

        state = result.state;

        // Check abort immediately after node execution
        throwIfAborted(state, 'Graph execution aborted');

        // yield to event loop
        await new Promise(r => setTimeout(r, 0));

        const currentNodeId = String((state as any).metadata.currentNodeId || '');
        let nextId = this.resolveNext(currentNodeId, result.decision, state);
        console.log(`[Graph] ${result.decision.type} → ${nextId}`);

        if (nextId === currentNodeId) {
          (state as any).metadata.consecutiveSameNode++;
          if ((state as any).metadata.consecutiveSameNode >= MAX_CONSECTUIVE_LOOP) {
            if (currentNodeId === 'action') {
              console.warn('Max consecutive loop on action — forcing critic review');
              (state as any).metadata.consecutiveSameNode = 0;
              nextId = 'skill_critic';
            } else {
              console.warn(`Max consecutive loop — forcing end`);
              (state as any).metadata.stopReason = 'max_loops';
              break;
            }
          }
        } else {
          (state as any).metadata.consecutiveSameNode = 0;
        }

        if (nextId === 'end' || (this.endPoints.has((state as any).metadata.currentNodeId) && result.decision.type === 'end')) {
          console.log(`[Graph] Complete after ${(state as any).metadata.iterations} iterations`);
          break;
        }

        (state as any).metadata.currentNodeId = nextId;
      }
    } catch (error: any) {
      console.log('[Graph] Execution stopped:', error);
      if (error?.name === 'AbortError') {
        console.log('[Graph] Graph execution aborted by user');
        if (convId) {
          getConversationLogger().logGraphCompleted(convId, 'aborted');
        }
      } else {
        if (convId) {
          getConversationLogger().logGraphCompleted(convId, 'failed', { error: error?.message || String(error) });
        }
        // Re-throw non-abort errors
        throw error;
      }
    }

    if ((state as any).metadata.iterations >= maxIterations) {
      console.warn('Max iterations hit');
      (state as any).metadata.maxIterationsReached = true;
      (state as any).metadata.stopReason = 'max_loops';
    }

    // ── Workflow Playbook Integration ──
    // After the agent's normal cycle completes, check if there's an active
    // workflow to orchestrate. If so, process next steps and potentially
    // re-enter the agent loop with new messages.
    if (!isReentry) {
      state = await this.processWorkflowPlaybook(state);
    }

    // Conversation logging — graph completed (skip on playbook re-entry)
    if (convId && !isReentry) {
      const convLogger = getConversationLogger();
      const finalStatus = (state as any).metadata.maxIterationsReached ? 'max_iterations' :
        (state as any).metadata.stopReason === 'max_loops' ? 'max_loops' : 'completed';
      convLogger.logGraphCompleted(convId, finalStatus, {
        iterations: (state as any).metadata.iterations,
        agentStatus: (state as any).metadata.agent?.status,
      });
    }

    // Send completion signal (skip on playbook re-entry to avoid duplicate signals)
    if (!isReentry) {
      const stopReason = (state as any).metadata.stopReason || null;
      console.log('[Graph] Sending graph_execution_complete signal, stopReason:', stopReason);
      const ws = getWebSocketClientService();
      const connId = (state as any).metadata.wsChannel || 'heartbeat';
      ws.send(connId, {
        type: 'transfer_data',
        data: { role: 'system', content: 'graph_execution_complete', stopReason },
      });
      // Clear stopReason after sending
      (state as any).metadata.stopReason = null;
    }

    return state;
  }

  /**
   * Process the active workflow playbook after the agent's normal cycle completes.
   * Walks the DAG, handles structural nodes mechanically, spawns sub-agents,
   * and injects prompts for router/condition decisions. Re-enters the agent loop
   * if the workflow needs the agent to make a decision or process sub-agent results.
   */
  private async processWorkflowPlaybook(state: TState): Promise<TState> {
    const meta = (state as any).metadata;
    const playbook: WorkflowPlaybookState | undefined = meta?.activeWorkflow;

    if (!playbook || playbook.status !== 'running') return state;

    console.log(`[Graph:Playbook] Processing workflow "${playbook.workflowId}" — frontier: [${playbook.currentNodeIds.join(', ')}]`);

    // ── Reset canvas and replay all already-completed nodes (triggers + checkpoint nodes) ──
    this.emitPlaybookEvent(state, 'workflow_started', { workflowId: playbook.workflowId });

    for (const [nodeId, output] of Object.entries(playbook.nodeOutputs)) {
      this.emitPlaybookEvent(state, 'node_completed', {
        nodeId,
        nodeLabel: output.label,
        output: output.result,
      });
      this.emitEdgeActivations(state, playbook.definition, nodeId, 'outgoing');
    }

    // If the agent just responded and there's a pending decision, resolve it
    if (playbook.pendingDecision) {
      const msgs = (state as any).messages;
      const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');

      if (lastAssistant?.content) {
        console.log(`[Graph:Playbook] Resolving pending ${playbook.pendingDecision.subtype} decision with agent response`);
        const pendNodeId = playbook.pendingDecision.nodeId;
        const resolved = resolveDecision(playbook, String(lastAssistant.content));
        meta.activeWorkflow = resolved.updatedPlaybook;

        const pendNodeLabel = this.getPlaybookNodeLabel(playbook, pendNodeId);
        const pendNodeSubtype = this.getPlaybookNodeSubtype(playbook, pendNodeId);
        this.emitPlaybookEvent(state, 'node_completed', {
          nodeId: pendNodeId,
          nodeLabel: pendNodeLabel,
          output: lastAssistant.content,
        });
        this.emitEdgeActivations(state, playbook.definition, pendNodeId, 'outgoing');
        await this.saveCheckpoint(resolved.updatedPlaybook, pendNodeId, pendNodeLabel, pendNodeSubtype, lastAssistant.content);

        if (resolved.action === 'workflow_completed' || resolved.action === 'workflow_failed') {
          console.log(`[Graph:Playbook] Workflow ${resolved.action} after decision resolution`);
          this.emitPlaybookEvent(state, resolved.action, {});
          const outcome = resolved.action === 'workflow_completed' ? 'completed' : 'failed';
          state = await this.releaseWorkflow(state, resolved.updatedPlaybook, outcome);
          return state;
        }
        // Decision resolved, fall through to process next step
      } else {
        // No agent response yet — re-enter agent loop to get one
        return state;
      }
    }

    // Process steps until we need the agent or workflow completes
    let continueProcessing = true;
    while (continueProcessing) {
      const currentPlaybook: WorkflowPlaybookState = meta.activeWorkflow;
      if (!currentPlaybook || currentPlaybook.status !== 'running') break;

      const step: PlaybookStepResult = processNextStep(currentPlaybook);
      meta.activeWorkflow = step.updatedPlaybook;

      switch (step.action) {
        case 'prompt_agent': {
          // Inject the prompt as a user message and re-enter agent loop
          console.log(`[Graph:Playbook] Prompting agent for decision`);
          const decisionNodeId = step.updatedPlaybook.pendingDecision?.nodeId;
          if (decisionNodeId) {
            this.emitEdgeActivations(state, step.updatedPlaybook.definition, decisionNodeId, 'incoming');
            this.emitPlaybookEvent(state, 'node_started', {
              nodeId: decisionNodeId,
              nodeLabel: this.getPlaybookNodeLabel(step.updatedPlaybook, decisionNodeId),
            });
          }
          this.injectWorkflowMessage(state, step.prompt);
          // Re-execute the agent loop to get a response (playbook re-entry — no completion signals)
          state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

          // Agent has responded — resolve the pending decision inline
          const pendingPlaybook: WorkflowPlaybookState | undefined = meta.activeWorkflow;
          if (pendingPlaybook?.pendingDecision) {
            const msgs = (state as any).messages;
            const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
            if (lastAssistant?.content) {
              console.log(`[Graph:Playbook] Resolving decision after re-entry`);
              const resolvedNodeId = pendingPlaybook.pendingDecision?.nodeId;
              const resolved = resolveDecision(pendingPlaybook, String(lastAssistant.content));
              meta.activeWorkflow = resolved.updatedPlaybook;
              if (resolvedNodeId) {
                const rNodeLabel = this.getPlaybookNodeLabel(pendingPlaybook, resolvedNodeId);
                const rNodeSubtype = this.getPlaybookNodeSubtype(pendingPlaybook, resolvedNodeId);
                this.emitPlaybookEvent(state, 'node_completed', {
                  nodeId: resolvedNodeId,
                  nodeLabel: rNodeLabel,
                  output: lastAssistant.content,
                });
                this.emitEdgeActivations(state, pendingPlaybook.definition, resolvedNodeId, 'outgoing');
                await this.saveCheckpoint(resolved.updatedPlaybook, resolvedNodeId, rNodeLabel, rNodeSubtype, lastAssistant.content);
              }
              if (resolved.action === 'workflow_completed' || resolved.action === 'workflow_failed') {
                this.emitPlaybookEvent(state, resolved.action, {});
                const outcome = resolved.action === 'workflow_completed' ? 'completed' : 'failed';
                state = await this.releaseWorkflow(state, resolved.updatedPlaybook, outcome);
                return state;
              }
              // Decision resolved — continue processing next nodes in the loop
              break;
            }
          }
          // No decision to resolve or no response — stop processing
          return state;
        }

        case 'spawn_sub_agent': {
          const subNodeLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          const isToolCall = step.agentId === '__tool_call__';

          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: subNodeLabel });

          if (isToolCall) {
            // ── Tool Call: orchestrator validates params, then execute silently ──
            console.log(`[Graph:Playbook] Tool call "${step.nodeId}" — validating params`);
            const preCallDesc = (step.config.preCallDescription as string) || '';
            const toolInfo = `Integration: ${step.config.integrationSlug || 'unknown'}\nEndpoint: ${step.config.endpointName || 'unknown'}`;
            const paramSummary = Object.entries((step.config.defaults as Record<string, string>) || {})
              .map(([k, v]) => `  ${k}: ${v}`)
              .join('\n');

            const validatePrompt = `[Workflow Tool Call: ${subNodeLabel}]\n${toolInfo}\n${paramSummary ? `\nParameters:\n${paramSummary}` : ''}\n${preCallDesc ? `\nDescription: ${preCallDesc}` : ''}\n\nValidate these parameters. The tool will execute after your review.`;
            this.injectWorkflowMessage(state, validatePrompt);
            state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

            // Execute the tool call
            try {
              const result = await this.executeSubAgent(state, step.nodeId, step.agentId, step.prompt, step.config);
              const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

              // Add result to thread silently — no orchestrator re-entry
              this.injectWorkflowMessage(state, `[Tool Call Result: ${subNodeLabel}]\n${resultText}`, true);

              const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, result.output, result.threadId);
              meta.activeWorkflow = completed.updatedPlaybook;

              this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, output: resultText });
              this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
              await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, subNodeLabel, 'tool-call', resultText);

              if (completed.action === 'workflow_completed') {
                console.log(`[Graph:Playbook] Workflow completed after tool call`);
                this.emitPlaybookEvent(state, 'workflow_completed', {});
                state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
                return state;
              }
            } catch (err: any) {
              console.error(`[Graph:Playbook] Tool call failed:`, err);
              this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, error: err.message || String(err) });
              const failedPlaybook = { ...meta.activeWorkflow, status: 'failed', error: err.message || String(err) };
              this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
              state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
              return state;
            }
          } else {
            // ── Agent Node: before prompt → execute (no orchestrator) → after validation ──
            console.log(`[Graph:Playbook] Agent node "${step.nodeId}" — before prompt`);
            const beforePromptText = (step.config.beforePrompt as string) || '';
            const successCriteria = (step.config.successCriteria as string) || '';

            // Phase 1: Before — always prompt orchestrator; use custom beforePrompt or default
            const beforeMsg = beforePromptText
              ? `[Workflow Node: ${subNodeLabel}]\n${beforePromptText}\n\nAgent: ${step.config.agentName || step.agentId || 'default'}\nPrompt:\n---\n${step.prompt}\n---`
              : `[Workflow Node: ${subNodeLabel}]\nThe following agent node is ready to execute.\n\nAgent: ${step.config.agentName || step.agentId || 'default'}\nPrompt that will be sent:\n---\n${step.prompt}\n---\n\nReview and process this step.`;
            this.injectWorkflowMessage(state, beforeMsg);
            state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

            // Phase 2: Execute the specialized sub-agent (no orchestrator involvement)
            try {
              const result = await this.executeSubAgent(state, step.nodeId, step.agentId, step.prompt, step.config);
              const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

              // Parse the structured hand-back from the sub-agent's response
              const handBack = parseHandBack(resultText);

              // Phase 3: After — always prompt orchestrator with parsed hand-back + validation
              const handBackBlock = [
                `Summary: ${handBack.summary}`,
                `Artifact: ${handBack.artifact}`,
                `Needs user input: ${handBack.needsUserInput ? 'yes' : 'no'}`,
                handBack.suggestedNextAction ? `Suggested next action: ${handBack.suggestedNextAction}` : '',
              ].filter(Boolean).join('\n');

              let afterMsg: string;
              if (successCriteria) {
                afterMsg = `[Workflow Node Complete: ${subNodeLabel}]\nThe agent has completed its work and handed back results.\n\nHAND_BACK:\n${handBackBlock}\n\nFull result:\n---\n${resultText}\n---\n\nSuccess Criteria: ${successCriteria}\n\nValidate whether the agent's output meets the success criteria above. Decide: approve, retry, or ask user.`;
              } else {
                afterMsg = `[Workflow Node Complete: ${subNodeLabel}]\nThe agent has completed its work and handed back results.\n\nHAND_BACK:\n${handBackBlock}\n\nReview this result. The workflow will advance to the next node.`;
              }
              this.injectWorkflowMessage(state, afterMsg);
              state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

              const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, result.output, result.threadId);
              meta.activeWorkflow = completed.updatedPlaybook;

              this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, output: resultText, threadId: result.threadId });
              this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
              await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, subNodeLabel, 'agent', resultText);

              if (completed.action === 'workflow_completed') {
                console.log(`[Graph:Playbook] Workflow completed after sub-agent`);
                this.emitPlaybookEvent(state, 'workflow_completed', {});
                state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
                return state;
              }
            } catch (err: any) {
              console.error(`[Graph:Playbook] Sub-agent failed:`, err);
              this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, error: err.message || String(err) });
              const failedPlaybook = { ...meta.activeWorkflow, status: 'failed', error: err.message || String(err) };
              this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
              state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
              return state;
            }
          }
          break;
        }

        case 'node_completed': {
          const mechLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          console.log(`[Graph:Playbook] Node "${step.nodeId}" completed mechanically`);
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: mechLabel });
          this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: mechLabel, output: step.result });
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
          await this.saveCheckpoint(step.updatedPlaybook, step.nodeId, mechLabel, this.getPlaybookNodeSubtype(currentPlaybook, step.nodeId), step.result);
          break;
        }

        case 'wait': {
          const waitLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          console.log(`[Graph:Playbook] Wait node "${step.nodeId}" — ${step.durationMs}ms`);
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: waitLabel });
          await new Promise<void>(resolve => setTimeout(resolve, step.durationMs));
          const waitNode = meta.activeWorkflow.definition.nodes.find((n: any) => n.id === step.nodeId);
          if (waitNode) {
            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, `Waited ${step.durationMs}ms`);
            meta.activeWorkflow = completed.updatedPlaybook;
          }
          this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: waitLabel, output: `Waited ${step.durationMs}ms` });
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
          await this.saveCheckpoint(meta.activeWorkflow, step.nodeId, waitLabel, 'wait', `Waited ${step.durationMs}ms`);
          break;
        }

        case 'workflow_completed': {
          console.log(`[Graph:Playbook] Workflow completed`);
          this.emitPlaybookEvent(state, 'workflow_completed', {});
          state = await this.releaseWorkflow(state, step.updatedPlaybook, 'completed');
          return state;
        }

        case 'workflow_failed': {
          console.error(`[Graph:Playbook] Workflow failed: ${step.error}`);
          this.emitPlaybookEvent(state, 'workflow_failed', { error: step.error });
          state = await this.releaseWorkflow(state, step.updatedPlaybook, 'failed', step.error);
          return state;
        }
      }
    }

    return state;
  }

  /**
   * Emit a workflow execution event via WebSocket so the frontend can update the canvas.
   */
  private emitPlaybookEvent(state: TState, type: string, data: Record<string, unknown> = {}): void {
    try {
      const ws = getWebSocketClientService();
      const channel = (state as any).metadata?.wsChannel || 'workbench';
      ws.send(channel, {
        type: 'workflow_execution_event',
        data: { type, timestamp: new Date().toISOString(), ...data },
        timestamp: Date.now(),
      });
    } catch { /* best-effort */ }
  }

  /**
   * Emit edge_activated events for all edges connecting to/from a node.
   * Direction 'incoming' animates edges pointing INTO the node,
   * 'outgoing' animates edges going OUT of the node.
   */
  private emitEdgeActivations(
    state: TState,
    definition: { edges: Array<{ source: string; target: string }> },
    nodeId: string,
    direction: 'incoming' | 'outgoing',
  ): void {
    for (const edge of definition.edges) {
      if (direction === 'incoming' && edge.target === nodeId) {
        this.emitPlaybookEvent(state, 'edge_activated', { sourceId: edge.source, targetId: edge.target });
      } else if (direction === 'outgoing' && edge.source === nodeId) {
        this.emitPlaybookEvent(state, 'edge_activated', { sourceId: edge.source, targetId: edge.target });
      }
    }
  }

  /**
   * Resolve a node label from the playbook definition.
   */
  private getPlaybookNodeLabel(playbook: WorkflowPlaybookState, nodeId: string): string {
    const node = playbook.definition.nodes.find((n: any) => n.id === nodeId);
    return node?.data?.label || nodeId;
  }

  /**
   * Resolve a node subtype from the playbook definition.
   */
  private getPlaybookNodeSubtype(playbook: WorkflowPlaybookState, nodeId: string): string {
    const node = playbook.definition.nodes.find((n: any) => n.id === nodeId);
    return node?.data?.subtype || 'unknown';
  }

  /**
   * Inject a workflow-related message into the agent's conversation.
   */
  private injectWorkflowMessage(state: TState, content: string, _silent?: boolean): void {
    const msgs = (state as any).messages;
    if (Array.isArray(msgs)) {
      msgs.push({ role: 'user', content: `[Workflow] ${content}` });
    }
  }

  /**
   * Save a checkpoint for a completed node so the workflow can be restarted from this point.
   * Best-effort — failures are logged but don't break the workflow.
   */
  private async saveCheckpoint(
    playbook: WorkflowPlaybookState,
    nodeId: string,
    nodeLabel: string,
    nodeSubtype: string,
    nodeOutput: unknown,
  ): Promise<void> {
    try {
      const { WorkflowCheckpointModel } = await import('../database/models/WorkflowCheckpointModel');
      const sequence = Object.keys(playbook.nodeOutputs).length;

      // Strip the full definition to avoid storing huge JSONB — keep only IDs and edges
      const slimPlaybook = {
        ...playbook,
        definition: {
          ...playbook.definition,
          // Keep nodes but strip execution state to save space
          nodes: playbook.definition.nodes.map(n => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: { subtype: n.data.subtype, category: n.data.category, label: n.data.label, config: n.data.config },
          })),
        },
      };

      await WorkflowCheckpointModel.saveCheckpoint({
        executionId:  playbook.executionId,
        workflowId:   playbook.workflowId,
        workflowName: playbook.definition.name,
        nodeId,
        nodeLabel,
        nodeSubtype,
        sequence,
        playbookState: slimPlaybook as any,
        nodeOutput,
      });

      console.log(`[Graph:Checkpoint] Saved checkpoint #${sequence} for "${nodeLabel}" (${nodeId})`);
    } catch (err) {
      console.warn(`[Graph:Checkpoint] Failed to save checkpoint for "${nodeLabel}":`, err);
    }
  }

  /**
   * Release the agent from a completed/failed workflow.
   * Captures all workflow metadata into `meta.lastCompletedWorkflow` so the agent
   * retains context, injects a summary message, and re-enters the agent loop
   * so the agent can continue its normal conversation cycle.
   */
  private async releaseWorkflow(
    state: TState,
    playbook: WorkflowPlaybookState,
    outcome: 'completed' | 'failed',
    error?: string,
  ): Promise<TState> {
    const meta = (state as any).metadata;

    // Build a summary of all node outputs for the agent's context
    const nodeSummaries = Object.values(playbook.nodeOutputs).map((output: PlaybookNodeOutput) => ({
      nodeId:    output.nodeId,
      label:     output.label,
      subtype:   output.subtype,
      category:  output.category,
      result:    typeof output.result === 'string' ? output.result : JSON.stringify(output.result),
      threadId:  output.threadId,
    }));

    // Store the workflow context so the agent remembers what happened
    meta.lastCompletedWorkflow = {
      workflowId:   playbook.workflowId,
      workflowName: playbook.definition.name,
      executionId:  playbook.executionId,
      outcome,
      error:        error || undefined,
      startedAt:    playbook.startedAt,
      completedAt:  new Date().toISOString(),
      nodeResults:  nodeSummaries,
    };

    // Clear the active workflow
    meta.activeWorkflow = undefined;

    // Build a rich context message for the agent
    const nodeLines = nodeSummaries
      .filter(n => n.category !== 'trigger')
      .map(n => `  • ${n.label} (${n.subtype}): ${(n.result || '').substring(0, 200)}${(n.result || '').length > 200 ? '...' : ''}`)
      .join('\n');

    const statusLabel = outcome === 'completed' ? 'completed successfully' : `failed: ${error || 'unknown error'}`;
    const summaryMsg = `[Workflow Complete] The workflow "${playbook.definition.name}" has ${statusLabel}.\n\nNode results:\n${nodeLines}\n\nYou are now free from the workflow. Continue the conversation naturally — you have full context of what was accomplished above. Respond to the user as needed.`;

    this.injectWorkflowMessage(state, summaryMsg);

    // Re-enter the agent loop so the agent can process the completion and continue naturally
    console.log(`[Graph:Playbook] Releasing agent from workflow — re-entering agent loop`);
    state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

    return state;
  }

  /**
   * Execute a sub-agent graph for a workflow agent node.
   * The sub-agent runs independently with its own persona/graph, then
   * reports its result back to the orchestrator.
   */
  private async executeSubAgent(
    _state: TState,
    nodeId: string,
    agentId: string,
    prompt: string,
    config: Record<string, unknown>,
  ): Promise<{ output: unknown; threadId?: string }> {
    // Handle tool-call nodes
    if (agentId === '__tool_call__') {
      return this.executeToolCall(config);
    }

    const { GraphRegistry } = await import('../services/GraphRegistry');

    const threadId = `workflow-playbook-${nodeId}-${Date.now()}`;
    const agentConfigChannel = agentId || threadId;

    const { graph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(agentConfigChannel, threadId) as {
      graph: any;
      state: any;
    };

    // Inject prompt
    subState.messages.push({ role: 'user', content: prompt });

    // Tag sub-agent with workflow nodeId so BaseNode.wsChatMessage can emit
    // node_thinking events back to the workflow canvas.
    const parentChannel = (_state as any).metadata?.wsChannel || 'workbench';
    subState.metadata.workflowNodeId = nodeId;
    subState.metadata.workflowParentChannel = parentChannel;

    // Execute sub-agent graph
    const finalState = await graph.execute(subState);
    const output = finalState.metadata?.finalSummary
      || finalState.messages?.[finalState.messages.length - 1]?.content
      || '';

    return { output, threadId };
  }

  /**
   * Execute a tool call (integration API) for a workflow tool-call node.
   */
  private async executeToolCall(config: Record<string, unknown>): Promise<{ output: unknown }> {
    const integrationSlug = (config.integrationSlug as string) || '';
    const endpointName = (config.endpointName as string) || '';
    const accountId = (config.accountId as string) || 'default';
    const defaults = (config.defaults as Record<string, string>) || {};

    if (!integrationSlug || !endpointName) {
      return { output: { error: 'Missing integration or endpoint configuration' } };
    }

    const { getIntegrationConfigLoader } = await import('../integrations/configApi');
    const loader = getIntegrationConfigLoader();
    const client = loader.getClient(integrationSlug);

    if (!client) {
      return { output: { error: `Integration "${integrationSlug}" not found` } };
    }

    // Resolve credentials
    const options: Record<string, any> = {};
    try {
      const { getIntegrationService } = await import('../services/IntegrationService');
      const integrationService = getIntegrationService();
      const values = await integrationService.getFormValues(integrationSlug, accountId);
      const apiKeyVal = values.find((v: { property: string; value: string }) =>
        v.property === 'api_key' || v.property === 'apiKey' || v.property === 'token',
      );
      if (apiKeyVal?.value) options.apiKey = apiKeyVal.value;
      const tokenVal = values.find((v: { property: string; value: string }) => v.property === 'access_token');
      if (tokenVal?.value) options.token = tokenVal.value;
    } catch (err) {
      console.warn('[Graph:Playbook] Could not load credentials:', err);
    }

    const result = await client.call(endpointName, defaults, options);
    return { output: result };
  }

  /**
   * Resolve next node based on decision and edges.
   * @param current - Current node ID
   * @param decision - Node's returned decision
   * @param state - Current state
   * @returns Next node ID or 'end'
   */
  private resolveNext(current: string, decision: NodeDecision, state: TState): string {
    console.log(`[Graph] resolveNext: current=${current}, decision=${decision.type}`);
    
    switch (decision.type) {
      case 'end': return 'end';
      case 'goto':
        if (this.nodes.has(decision.nodeId)) return decision.nodeId;
        console.warn(`Invalid goto: ${decision.nodeId}`);
        return 'end';
      case 'continue': return current;
      case 'revise':
        return this.getReviserFor(current) || 'end';
      case 'next':
        const edges = this.edges.get(current) || [];
        console.log(`[Graph] resolveNext: found ${edges.length} edges for ${current}`);
        for (const edge of edges) {
          if (typeof edge.to === 'function') {
            const nextId = edge.to(state);
            console.log(`[Graph] resolveNext: conditional edge resolved to ${nextId}`);
            if (nextId && this.nodes.has(nextId)) return nextId;
          } else if (this.nodes.has(edge.to)) {
            console.log(`[Graph] resolveNext: static edge to ${edge.to}`);
            return edge.to;
          }
        }
        console.log(`[Graph] resolveNext: no valid edges found, ending`);
        return 'end';
    }
  }

  /**
   * Get reviser node for revise decisions (stub - customize per graph).
   */
  private getReviserFor(nodeId: string): string | null {
    if (nodeId.includes('executor')) return 'planner';
    if (nodeId.includes('critic') || nodeId.includes('planner')) return 'strategic_planner';
    return null;
  }

  /**
   * Clean up all nodes.
   */
  async destroy(): Promise<void> {
    for (const node of this.nodes.values()) {
      if (node.destroy) await node.destroy();
    }
    this.nodes.clear();
    this.edges.clear();
    this.initialized = false;
  }
}

/**
 * Create initial thread state with first user message.
 * @param prompt - The initial user message content
 * @param metadata - Optional metadata for the message
 * @returns Fully initialized ThreadState
 */
export async function createInitialThreadState<T extends BaseThreadState>(
  prompt: string,
  overrides: Partial<T['metadata']> = {}
): Promise<T> {

  const now = Date.now();
  const msgId = nextMessageId();
  
  const mode = await SullaSettingsModel.get('modelMode', 'local');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';
  
  const baseMetadata: BaseThreadState['metadata'] = {
      action: 'direct_answer',  // Default action for initial state
      threadId: overrides.threadId ?? nextThreadId(),
      wsChannel: overrides.wsChannel ?? DEFAULT_WS_CHANNEL,
      llmModel,
      llmLocal,
      cycleComplete: false,
      waitingForUser: false,
      options: overrides.options ?? { abort: undefined },
      currentNodeId: overrides.currentNodeId ?? 'input_handler',
      consecutiveSameNode: 0,
      iterations: 0,
      revisionCount: 0,
      maxIterationsReached: false,
      memory: overrides.memory ?? {
        knowledgeBaseContext: '',
        chatSummariesContext: ''
      },
      subGraph: {
        state: 'completed',
        name: 'hierarchical',
        prompt: '',
        response: ''
      },
      finalSummary: '',
      totalSummary: '',
      finalState: 'running',
      n8nLiveEventsEnabled: false,
      returnTo: null
    };

  const result = {
      messages: [{
        id: msgId,
        role: 'user',
        content: prompt.trim(),
        timestamp: now,
        metadata: {
          type: 'initial_prompt',
          source: 'user'
        }
      }],
      metadata: {
        ...baseMetadata,
        ...overrides
      }
    };

  return result as unknown as T;
}

let messageCounter = 0;
let threadCounter = 0;

export function nextMessageId(): string {
  return `msg_${Date.now()}_${++messageCounter}`;
}

export function nextThreadId(): string {
  return `thread_${Date.now()}_${++threadCounter}`;
}

// ============================================================================
//
// Graph Decision Trees
//
// ============================================================================

const MAX_HEARTBEAT_CYCLES = 10;

/**
 * Create the Heartbeat Graph for autonomous execution.
 *
 * Flow: InputHandler → HeartbeatNode (loops up to MAX_HEARTBEAT_CYCLES)
 *
 * Each HeartbeatNode cycle:
 *   1. Loads active projects & available skills
 *   2. Builds a rich autonomous prompt with context
 *   3. Spawns a fresh AgentGraph (with full tool access) as a sub-graph
 *   4. Captures outcome and decides whether to loop or stop
 *
 * The heartbeat graph is triggered by HeartbeatService on a timer
 * and by BackendGraphWebSocketService for the heartbeat channel.
 */
export function createHeartbeatGraph(): Graph<HeartbeatThreadState> {
  const graph = new Graph<HeartbeatThreadState>();

  graph.addNode(new InputHandlerNode<HeartbeatThreadState>());
  graph.addNode(new HeartbeatNode());

  // InputHandler cleans up the initial prompt message, then → heartbeat
  graph.addEdge('input_handler', 'heartbeat');

  // Heartbeat conditional edge: done/blocked → end, otherwise loop
  graph.addConditionalEdge('heartbeat', state => {
    const hbStatus = state.metadata.heartbeatStatus || 'running';
    const cycleCount = state.metadata.heartbeatCycleCount || 0;
    const maxCycles = state.metadata.heartbeatMaxCycles || MAX_HEARTBEAT_CYCLES;

    if (hbStatus === 'done') {
      console.log('[HeartbeatGraph] Agent reported DONE — ending heartbeat');
      return 'end';
    }

    if (hbStatus === 'blocked') {
      console.log('[HeartbeatGraph] Agent reported BLOCKED — ending heartbeat');
      return 'end';
    }

    if (cycleCount >= maxCycles) {
      console.log(`[HeartbeatGraph] Max heartbeat cycles (${maxCycles}) reached — ending`);
      return 'end';
    }

    console.log(`[HeartbeatGraph] Cycle ${cycleCount}/${maxCycles} — continuing`);
    return 'heartbeat';
  });

  graph.setEntryPoint('input_handler');
  graph.setEndPoints('heartbeat');

  return graph;
}

// Back-compat alias
export function createOverlordGraph(): Graph<HeartbeatThreadState> {
  return createHeartbeatGraph();
}

// Back-compat alias while callers migrate to AgentGraph naming.
export function createGeneralGraph(): Graph<GeneralGraphState> {
  return createAgentGraph();
}

/**
 * Create the AgentGraph for independent agent execution.
 * 
 * Flow: Input → Agent (loops on itself up to 20 times until DONE or BLOCKED)
 * 
 * @returns {Graph} Fully configured AgentGraph
 */
export function createAgentGraph(): Graph<AgentGraphState> {
  const graph = new Graph<AgentGraphState>();

  graph.addNode(new InputHandlerNode());  // id: 'input_handler'
  graph.addNode(new AgentNode());         // id: 'agent'

  // Input → Agent
  graph.addEdge('input_handler', 'agent');

  // Agent routing: done/blocked → end, otherwise continue looping
  graph.addConditionalEdge('agent', state => {
    // If a workflow has been activated, stop the agent loop immediately.
    // The workflow playbook will take over orchestration.
    if ((state.metadata as any).activeWorkflow?.status === 'running') {
      console.log('[AgentGraph] Workflow activated — pausing agent for workflow orchestration');
      return 'end';
    }

    const agentMeta = (state.metadata as any).agent || {};
    const agentStatus = String(agentMeta.status || '').trim().toLowerCase();
    const hadToolCalls = Boolean((state.metadata as any).hadToolCalls);

    if (agentStatus === 'done') {
      console.log('[AgentGraph] Agent reported DONE - ending');
      return 'end';
    }

    if (agentStatus === 'blocked') {
      console.log('[AgentGraph] Agent reported BLOCKED - ending');
      return 'end';
    }

    if (agentStatus !== 'continue' && !hadToolCalls) {
      console.log(`[AgentGraph] Agent status '${agentStatus || 'unknown'}' is not CONTINUE - ending`);
      return 'end';
    }

    // Track loop count for diagnostics
    const currentLoopCount = (state.metadata as any).agentLoopCount || 0;
    const newLoopCount = currentLoopCount + 1;
    (state.metadata as any).agentLoopCount = newLoopCount;

    console.log(`[AgentGraph] Agent cycle ${newLoopCount} - continuing`);
    return 'agent';
  });

  graph.setEntryPoint('input_handler');
  graph.setEndPoints('agent');

  return graph;
}

