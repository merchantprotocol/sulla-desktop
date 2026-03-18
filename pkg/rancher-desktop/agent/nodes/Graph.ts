// Graph - LangGraph-style workflow orchestrator
// sits on the backend and processes the graphs

import type { AbortService } from '../services/AbortService';
import { throwIfAborted } from '../services/AbortService';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getConversationLogger } from '../services/ConversationLogger';
import { getTrainingDataLogger } from '../services/TrainingDataLogger';
import { InputHandlerNode } from './InputHandlerNode';
import { AgentNode } from './AgentNode';
import { HeartbeatNode, type HeartbeatThreadState } from './HeartbeatNode';
import type { WorkflowPlaybookState, PlaybookNodeOutput } from '../workflow/types';

import {
  processNextStep,
  resolveDecision,
  completeSubAgent,
  createPlaybookState,
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

// ── Completion block parser ──

interface ParsedHandBack {
  summary:             string;
  artifact:            string;
  needsUserInput:      boolean;
  rawOutput:           string;
}

/**
 * Parse the structured completion block from a sub-agent's output.
 * Looks for <AGENT_DONE> XML wrapper containing a summary and "Needs user input: yes/no".
 * Falls back to raw output as summary if no completion block found.
 */
function parseHandBack(output: string): ParsedHandBack {
  const raw = typeof output === 'string' ? output : JSON.stringify(output);

  // Extract content from <AGENT_DONE> wrapper
  const agentDoneMatch = /<AGENT_DONE>([\s\S]*?)<\/AGENT_DONE>/i.exec(raw);

  if (!agentDoneMatch) {
    // No completion block — treat the entire output as the summary
    return {
      summary:             raw.substring(0, 500),
      artifact:            'none',
      needsUserInput:      false,
      rawOutput:           raw,
    };
  }

  const doneBlock = agentDoneMatch[1].trim();

  // Extract "Needs user input: yes/no"
  const needsInputMatch = /Needs user input:\s*(yes|no)/i.exec(doneBlock);
  const needsUserInput = needsInputMatch ? /^yes$/i.test(needsInputMatch[1]) : false;

  // Summary is everything except the "Needs user input" line
  const summary = doneBlock
    .replace(/Needs user input:\s*(yes|no)/i, '')
    .trim()
    .substring(0, 500) || '';

  return {
    summary,
    artifact:       'none',
    needsUserInput,
    rawOutput:      raw,
  };
}

// ── <PROMPT> tag parser for agent delegation ──

interface ParsedPrompt {
  agentId: string | null;
  label:   string | null;
  content: string;
}

/**
 * Parse `<PROMPT>` tags from the orchestrator's Phase 1 response.
 * Each tag spawns a separate sub-agent in parallel.
 * Attributes: agentId (optional), label (optional).
 */
function parsePromptTags(text: string): ParsedPrompt[] {
  // Match attributes in any order: agentId="...", label="..."
  const tagRegex = /<PROMPT([^>]*)>([\s\S]*?)<\/PROMPT>/gi;
  const prompts: ParsedPrompt[] = [];
  let match;

  while ((match = tagRegex.exec(text)) !== null) {
    const attrs = match[1] || '';
    const content = (match[2] || '').trim();

    const agentIdMatch = /agentId="([^"]*)"/.exec(attrs);
    const labelMatch = /label="([^"]*)"/.exec(attrs);

    if (content) {
      prompts.push({
        agentId: agentIdMatch?.[1] || null,
        label:   labelMatch?.[1] || null,
        content,
      });
    }
  }

  return prompts;
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
  state:    TState;                  // mutated/updated state
  decision: NodeDecision;         // neutral signal only
}

// NodeResult must always be one of:
type NodeDecision =
  | { type: 'end' }
  | { type: 'goto', nodeId: string }
  | { type: 'continue' }           // same node, more work
  | { type: 'next' }               // follow static/conditional edge
  | { type: 'revise' };             // go back to planner/critic

export interface GraphEdge<TState> {
  from: string;
  to:   string | ((state: TState) => string | null);
}

// Base shared across all thread states
export interface BaseThreadState {
  messages: ChatMessage[];

  prompt?: string;

  // Tools found by browse_tools calls (accumulates across multiple calls)
  foundTools?: any[];

  metadata: {
    action:                'direct_answer' | 'ask_clarification' | 'use_tools' | 'create_plan' | 'run_again';
    threadId:              string;
    wsChannel:             string;
    /** Conversation logger ID — set by workflow agent handler or graph creator */
    conversationId?:       string;
    /** Parent conversation ID (e.g. the workflow execution that spawned this graph) */
    parentConversationId?: string;

    reasoning?: string;

    llmModel: string;
    llmLocal: boolean;

    cycleComplete:  boolean;
    waitingForUser: boolean;

    /** True when this graph was spawned as a sub-agent (heartbeat, workflow, etc.) */
    isSubAgent: boolean;

    /** Recursion depth counter for nested sub-agent spawning (0 = top-level) */
    subAgentDepth: number;

    options: {
      abort?: AbortService;
    };

    currentNodeId:        string;
    consecutiveSameNode:  number;
    iterations:           number;
    revisionCount:        number;
    maxIterationsReached: boolean;

    memory: {
      knowledgeBaseContext: string;
      chatSummariesContext: string;
    };

    // any graph could technically call another graph, this is the format
    subGraph: {
      state:    'trigger_subgraph' | 'running' | 'completed' | 'failed';
      name:     'hierarchical';
      prompt:   string;
      response: string;
    };

    finalSummary:          string;
    totalSummary?:         string;
    finalState:            'failed' | 'running' | 'completed';
    n8nLiveEventsEnabled?: boolean;

    // parent graph return
    returnTo: string | null;

    awarenessIncluded?: boolean;
    datetimeIncluded?:  boolean;
    hadToolCalls?:      boolean;
    hadUserMessages?:   boolean;

    /** When set, workflow tools (list/execute) are scoped to only this workflow */
    scopedWorkflowId?: string;

    /** Trust level of the caller */
    isTrustedUser?:      'trusted' | 'untrusted' | 'verify';
    /** Whether the user can see browser panels in the UI */
    userVisibleBrowser?: boolean;

    /** Active workflow playbook — when set, the agent orchestrates this workflow */
    activeWorkflow?: WorkflowPlaybookState;

    /** Stack of parent workflow playbooks when executing sub-workflows.
     *  Persisted so sub-workflow completion can pop back to the parent after restarts. */
    workflowStack?: Array<{ playbook: WorkflowPlaybookState; nodeId: string }>;
  };
}

/**
 * AgentGraph-specific thread state interface
 * Minimal state for the independent agent graph (InputHandler → Agent loop)
 */
export interface AgentGraphState extends BaseThreadState {
  metadata: BaseThreadState['metadata'] & {
    agent?: {
      // Config (loaded at graph creation from config.yaml)
      name?:         string;
      description?:  string;
      type?:         string;
      skills?:       string[];
      tools?:        string[];         // allowlist of tool names
      integrations?: string[];  // allowlist of integration slugs (empty = none, ["*"] = all)
      prompt?:       string;          // compiled .md files, no variable substitution

      // Execution outcomes (set during runtime)
      status?:               'done' | 'blocked' | 'continue' | 'in_progress';
      status_report?:        string | null;
      response?:             string | null;
      blocker_reason?:       string | null;
      unblock_requirements?: string | null;
      updatedAt?:            number;
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
  private nodes = new Map<string, GraphNode<TState>>();
  private edges = new Map<string, GraphEdge<TState>[]>();
  private entryPoint: string | null = null;
  private endPoints = new Set<string>();
  private initialized = false;

  // ── Non-blocking sub-agent tracking ──
  private pendingSubAgents = new Map<string, {
    nodeId:    string;
    nodeLabel: string;
    agentId:   string;
    startedAt: number;
  }>();
  private pendingCompletions: Array<{
    nodeId:    string;
    nodeLabel: string;
    output:    unknown;
    threadId?: string;
  }> = [];
  private pendingFailures: Array<{
    nodeId:    string;
    nodeLabel: string;
    error:     string;
  }> = [];
  private pendingEscalations: Array<{
    nodeId:    string;
    nodeLabel: string;
    agentId:   string;
    prompt:    string;
    config:    Record<string, unknown>;
    question:  string;
    threadId?: string;
    orchestratorAttempted?: boolean; // true after the orchestrator has been asked to answer
  }> = [];
  private isProcessingPlaybook = false;

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
    to: string | ((state: TState) => string | null),
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
    condition: (state: TState) => string | null,
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
    options?: { maxIterations: number; _isPlaybookReentry?: boolean },
  ): Promise<TState> {
    if (!this.entryPoint) throw new Error('No entry point');

    await this.initialize();

    let state = initialState;
    (state as any).metadata.currentNodeId = entryPointNodeId || this.entryPoint;

    // Conversation logging (skip on playbook re-entry to avoid duplicates)
    const isReentry = options?._isPlaybookReentry ?? false;

    // Propagate reentry flag to metadata so downstream nodes (AgentNode, BaseNode)
    // can route orchestrator responses as workflow events instead of chat messages.
    const prevReentryFlag = (state as any).metadata._isPlaybookReentry;
    (state as any).metadata._isPlaybookReentry = isReentry;
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

      // Training data capture
      getTrainingDataLogger().startSession(convId, {
        agentId: (state as any).metadata.wsChannel,
        model:   (state as any).metadata.llmModel,
      });
    }

    (state as any).metadata.iterations ??= 0;
    (state as any).metadata.consecutiveSameNode ??= 0;

    const maxIterations = options?.maxIterations ?? 1000000;

    try {
      while ((state as any).metadata.iterations < maxIterations) {
        (state as any).metadata.iterations++;

        throwIfAborted(state, 'Graph execution aborted');

        if ((state as any).metadata.cycleComplete) {
          break;
        }

        if ((state as any).metadata.waitingForUser && (state as any).metadata.currentNodeId === 'input_handler') {
          break;
        }

        const node = this.nodes.get((state as any).metadata.currentNodeId);
        if (!node) throw new Error(`Node missing: ${ (state as any).metadata.currentNodeId }`);

        const result: NodeResult<TState> = await node.execute(state);

        state = result.state;

        // Check abort immediately after node execution
        throwIfAborted(state, 'Graph execution aborted');

        // yield to event loop
        await new Promise(r => setTimeout(r, 0));

        const currentNodeId = String((state as any).metadata.currentNodeId || '');
        let nextId = this.resolveNext(currentNodeId, result.decision, state);

        if (nextId === currentNodeId) {
          (state as any).metadata.consecutiveSameNode++;
          const hasActiveWorkflow = !!(state as any).metadata?.activeWorkflow?.status
            && (state as any).metadata.activeWorkflow.status === 'running';
          if (!hasActiveWorkflow && (state as any).metadata.consecutiveSameNode >= MAX_CONSECTUIVE_LOOP) {
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
          break;
        }

        (state as any).metadata.currentNodeId = nextId;
      }
    } catch (error: any) {
      // Restore reentry flag on error path
      (state as any).metadata._isPlaybookReentry = prevReentryFlag;

      if (error?.name === 'AbortError') {
        (state as any).metadata.waitingForUser = true;
        (state as any).metadata.cycleComplete = true;
        if (convId) {
          getConversationLogger().logGraphCompleted(convId, 'aborted');
          if (!isReentry) getTrainingDataLogger().endSession(convId);
        }
      } else {
        if (convId) {
          getConversationLogger().logGraphCompleted(convId, 'failed', { error: error?.message || String(error) });
          if (!isReentry) getTrainingDataLogger().endSession(convId);
        }
        // Re-throw non-abort errors
        throw error;
      }
    }

    const hasActiveWorkflowPostLoop = !!(state as any).metadata?.activeWorkflow?.status
      && (state as any).metadata.activeWorkflow.status === 'running';
    if (!hasActiveWorkflowPostLoop && (state as any).metadata.iterations >= maxIterations) {
      console.warn('Max iterations hit');
      (state as any).metadata.maxIterationsReached = true;
      (state as any).metadata.stopReason = 'max_loops';
      (state as any).metadata.waitingForUser = false;
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
      const finalStatus = (state as any).metadata.maxIterationsReached
        ? 'max_iterations'
        : (state as any).metadata.stopReason === 'max_loops' ? 'max_loops' : 'completed';
      convLogger.logGraphCompleted(convId, finalStatus, {
        iterations:  (state as any).metadata.iterations,
        agentStatus: (state as any).metadata.agent?.status,
      });
      getTrainingDataLogger().endSession(convId);
    }

    // Send completion signal (skip on playbook re-entry to avoid duplicate signals)
    if (!isReentry) {
      const stopReason = (state as any).metadata.stopReason || null;
      const waitingForUser = !!(state as any).metadata.waitingForUser;
      const ws = getWebSocketClientService();
      const connId = (state as any).metadata.wsChannel || 'heartbeat';
      ws.send(connId, {
        type: 'transfer_data',
        data: { role: 'system', content: 'graph_execution_complete', stopReason, waitingForUser, thread_id: (state as any).metadata.threadId },
      });
      // Clear stopReason after sending
      (state as any).metadata.stopReason = null;
    }

    // Restore previous reentry flag so nested reentries unwind correctly
    (state as any).metadata._isPlaybookReentry = prevReentryFlag;

    return state;
  }

  /**
   * Process the active workflow playbook after the agent's normal cycle completes.
   * Walks the DAG, handles structural nodes mechanically, spawns sub-agents,
   * and injects prompts for router/condition decisions. Re-enters the agent loop
   * if the workflow needs the agent to make a decision or process sub-agent results.
   */
  private async processWorkflowPlaybook(state: TState): Promise<TState> {
    this.isProcessingPlaybook = true;
    try {
      return await this._processWorkflowPlaybookInner(state);
    } finally {
      this.isProcessingPlaybook = false;

      // If a sub-agent completed while we were processing, re-trigger immediately
      if (this._continuationQueued) {
        this._continuationQueued = false;
        const hasUndrained = this.pendingCompletions.length > 0 || this.pendingFailures.length > 0 || this.pendingEscalations.length > 0;
        if (hasUndrained) {
          console.log('[Graph:Playbook] Draining queued continuation after processWorkflowPlaybook unlock');
          setImmediate(async() => {
            try {
              await this.processWorkflowPlaybook(state);
            } catch (err) {
              console.error('[Graph:Playbook] Queued continuation failed:', err);
            }
          });
        }
      }
    }
  }

  private async _processWorkflowPlaybookInner(state: TState): Promise<TState> {
    const meta = (state as any).metadata;
    const playbook: WorkflowPlaybookState | undefined = meta?.activeWorkflow;

    console.log(`[Graph:Playbook] processWorkflowPlaybook called — status=${ playbook?.status }, frontier=[${ playbook?.currentNodeIds?.join(', ') || '' }], completed=${ playbook?.completedNodeIds?.length ?? 0 }, defNodes=${ playbook?.definition?.nodes?.length ?? 0 }, defEdges=${ playbook?.definition?.edges?.length ?? 0 }`);

    if (playbook?.status !== 'running') {
      console.log(`[Graph:Playbook] Skipping — playbook status is '${ playbook?.status }', not 'running'`);

      return state;
    }

    // ── Drain persisted completions/failures/escalations from DB ──
    // These survive Graph restarts and ensure sub-agent results are never lost.
    try {
      const { WorkflowPendingCompletionModel } = await import('../database/models/WorkflowPendingCompletionModel');
      const persistedRecords = await WorkflowPendingCompletionModel.findPending(playbook.executionId);

      for (const record of persistedRecords) {
        const attrs = record.attributes;
        const alreadyInMemory = (kind: string) => {
          if (kind === 'completion') return this.pendingCompletions.some(c => c.nodeId === attrs.node_id);
          if (kind === 'failure') return this.pendingFailures.some(f => f.nodeId === attrs.node_id);
          if (kind === 'escalation') return this.pendingEscalations.some(e => e.nodeId === attrs.node_id);
          return false;
        };

        // Also skip if node already completed in the playbook
        const alreadyCompleted = playbook.completedNodeIds.includes(attrs.node_id!);

        if (!alreadyInMemory(attrs.kind!) && !alreadyCompleted) {
          if (attrs.kind === 'completion') {
            this.pendingCompletions.push({ nodeId: attrs.node_id!, nodeLabel: attrs.node_label!, output: attrs.output, threadId: attrs.thread_id ?? undefined });
            console.log(`[Graph:Playbook] Restored persisted completion for "${ attrs.node_label }" from DB`);
          } else if (attrs.kind === 'failure') {
            this.pendingFailures.push({ nodeId: attrs.node_id!, nodeLabel: attrs.node_label!, error: attrs.error || 'Unknown error' });
            console.log(`[Graph:Playbook] Restored persisted failure for "${ attrs.node_label }" from DB`);
          } else if (attrs.kind === 'escalation' && attrs.escalation) {
            const esc = attrs.escalation as Record<string, any>;
            this.pendingEscalations.push({
              nodeId:    attrs.node_id!,
              nodeLabel: attrs.node_label!,
              agentId:   esc.agentId || '',
              prompt:    esc.prompt || '',
              config:    esc.config || {},
              question:  esc.question || '',
              threadId:  attrs.thread_id ?? undefined,
            });
            console.log(`[Graph:Playbook] Restored persisted escalation for "${ attrs.node_label }" from DB`);
          }
        }

        // Mark as drained regardless (whether we used it or it was duplicate)
        await WorkflowPendingCompletionModel.markDrained(attrs.id!);
      }
    } catch (err) {
      console.warn('[Graph:Playbook] Failed to drain persisted completions from DB:', err);
    }

    // ── Reset canvas and replay all already-completed nodes (triggers + checkpoint nodes) ──
    // Only emit workflow_started once per execution to avoid duplicate chat cards.
    // The flag is stored on the playbook so it resets on new workflow activations.
    if (!(playbook as any)._workflowStartedEmitted) {
      this.emitPlaybookEvent(state, 'workflow_started', { workflowId: playbook.workflowId });
      (playbook as any)._workflowStartedEmitted = true;
    }

    for (const [nodeId, output] of Object.entries(playbook.nodeOutputs ?? {})) {
      this.emitPlaybookEvent(state, 'node_completed', {
        nodeId,
        nodeLabel: output.label,
        output:    output.result,
      });
      this.emitEdgeActivations(state, playbook.definition, nodeId, 'outgoing');
    }

    // If there's a pending decision, resolve it
    if (playbook.pendingDecision) {
      const msgs = (state as any).messages;
      const pendingSubtype = playbook.pendingDecision.subtype;

      // For user-input nodes, resolve with the user's last message (not the assistant's)
      // For all other decision types (router, condition, response), resolve with the assistant's response
      let resolveContent: string | undefined;

      if (pendingSubtype === 'user-input') {
        const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user' && !m.content?.startsWith?.('[Workflow]'));
        resolveContent = lastUser?.content ? String(lastUser.content) : undefined;
      } else {
        const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
        resolveContent = lastAssistant?.content ? String(lastAssistant.content) : undefined;
      }

      if (resolveContent) {
        const pendNodeId = playbook.pendingDecision.nodeId;
        const resolved = resolveDecision(playbook, resolveContent);
        meta.activeWorkflow = resolved.updatedPlaybook;

        const pendNodeLabel = this.getPlaybookNodeLabel(playbook, pendNodeId);
        const pendNodeSubtype = this.getPlaybookNodeSubtype(playbook, pendNodeId);
        this.emitPlaybookEvent(state, 'node_completed', {
          nodeId:    pendNodeId,
          nodeLabel: pendNodeLabel,
          output:    resolveContent,
        });
        this.emitEdgeActivations(state, playbook.definition, pendNodeId, 'outgoing');
        await this.saveCheckpoint(resolved.updatedPlaybook, pendNodeId, pendNodeLabel, pendNodeSubtype, resolveContent);

        if (resolved.action === 'workflow_completed' || resolved.action === 'workflow_failed') {
          this.emitPlaybookEvent(state, resolved.action, {});
          const outcome = resolved.action === 'workflow_completed' ? 'completed' : 'failed';
          state = await this.releaseWorkflow(state, resolved.updatedPlaybook, outcome);
          return state;
        }
        // Decision resolved, fall through to process next step
      } else {
        // No response yet — return and wait for user/agent input
        return state;
      }
    }

    // ── Drain pending sub-agent completions before processing next steps ──
    while (this.pendingCompletions.length > 0) {
      const completion = this.pendingCompletions.shift()!;
      const pendingEntry = this.pendingSubAgents.get(completion.nodeId);
      this.pendingSubAgents.delete(completion.nodeId);
      const completionLabel = completion.nodeLabel;
      const resultText = typeof completion.output === 'string' ? completion.output : JSON.stringify(completion.output);

      console.log(`[Graph:Playbook] Draining pending completion for "${ completionLabel }" (node: ${ completion.nodeId })`);

      // ── Phase 3: Orchestrator evaluates with success criteria (single-agent) ──
      const pendingSuccessCriteria = (pendingEntry as any)?.successCriteria || '';
      let finalOutput = completion.output;

      // Extract <completion-contract> content if present
      const contractMatch = resultText.match(/<completion-contract>([\s\S]*?)<\/completion-contract>/);
      const contractContent = contractMatch ? contractMatch[1].trim() : null;

      if (pendingSuccessCriteria.trim()) {
        const evalMsg = `[Sub-agent Complete: ${ completionLabel }]\n\n` +
          (contractContent
            ? `Completion contract response:\n${ contractContent }\n\nFull output:\n${ resultText }\n\n`
            : `Sub-agent output:\n${ resultText }\n\n`) +
          `Evaluate the sub-agent's response against the following success criteria:\n${ pendingSuccessCriteria }\n\n` +
          `If the response meets all criteria, respond with APPROVED and a brief summary of what was delivered.\n` +
          `If it fails any criteria, respond with NEEDS_REVISION and explain what fell short.`;

        this.injectWorkflowMessage(state, evalMsg);
        state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        const evalResponse = (state as any).messages?.[(state as any).messages.length - 1];
        const evalText = typeof evalResponse?.content === 'string' ? evalResponse.content : '';
        finalOutput = `${ resultText }\n\n[Orchestrator Evaluation]\n${ evalText }`;
      }

      const completed = completeSubAgent(meta.activeWorkflow, completion.nodeId, finalOutput, completion.threadId);
      meta.activeWorkflow = completed.updatedPlaybook;

      const finalResultText = typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput);
      this.emitPlaybookEvent(state, 'node_completed', { nodeId: completion.nodeId, nodeLabel: completionLabel, output: finalResultText, threadId: completion.threadId });
      this.emitEdgeActivations(state, meta.activeWorkflow.definition, completion.nodeId, 'outgoing');
      await this.saveCheckpoint(completed.updatedPlaybook, completion.nodeId, completionLabel, 'agent', finalResultText);

      // Narrate completion to the orchestrator (skip if we already evaluated above)
      if (!pendingSuccessCriteria.trim()) {
        const handBack = parseHandBack(resultText);
        const resultMsg = `[Workflow Node Complete: ${ completionLabel }]\nSummary: ${ handBack.summary }\nNeeds user input: ${ handBack.needsUserInput ? 'yes' : 'no' }`;
        this.injectWorkflowMessage(state, resultMsg, !handBack.needsUserInput);
      }

      const handBack = parseHandBack(resultText);

      if (handBack.needsUserInput) {
        // Pause the workflow — the agent flagged that user input is needed
        console.log(`[Graph:Playbook] Node "${ completionLabel }" needs user input — pausing workflow`);
        this.emitPlaybookEvent(state, 'workflow_paused', { nodeId: completion.nodeId, nodeLabel: completionLabel, reason: 'needs_user_input', summary: handBack.summary });

        // Persist any remaining in-memory completions to DB before pausing,
        // so they are not lost if the Graph is re-created before we resume.
        if (this.pendingCompletions.length > 0) {
          const execId = meta.activeWorkflow?.executionId;
          if (execId) {
            try {
              const { WorkflowPendingCompletionModel } = await import('../database/models/WorkflowPendingCompletionModel');
              for (const remaining of this.pendingCompletions) {
                await WorkflowPendingCompletionModel.saveCompletion({ executionId: execId, nodeId: remaining.nodeId, nodeLabel: remaining.nodeLabel, output: remaining.output, threadId: remaining.threadId });
              }
              console.log(`[Graph:Playbook] Persisted ${ this.pendingCompletions.length } undrained completions before needsUserInput pause`);
            } catch (e) { console.warn('[Graph:Playbook] Failed to persist undrained completions:', e); }
          }
        }

        // Let the orchestrator tell the user what's needed
        const pauseMsg = `[Workflow Paused: "${ completionLabel }" needs user input]\n` +
          `${ handBack.summary }\n\n` +
          `The workflow is paused. Tell the user what the agent needs and wait for their response.`;
        this.injectWorkflowMessage(state, pauseMsg);
        state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        // Wait for user — do not advance to the next node
        (state as any).metadata.waitingForUser = true;
        return state;
      }

      if (completed.action === 'workflow_completed') {
        this.emitPlaybookEvent(state, 'workflow_completed', {});
        state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
        return state;
      }
    }

    // ── Drain pending sub-agent failures ──
    while (this.pendingFailures.length > 0) {
      const failure = this.pendingFailures.shift()!;
      this.pendingSubAgents.delete(failure.nodeId);

      console.error(`[Graph:Playbook] Draining pending failure for "${ failure.nodeLabel }" (node: ${ failure.nodeId }): ${ failure.error }`);

      this.emitPlaybookEvent(state, 'node_failed', { nodeId: failure.nodeId, nodeLabel: failure.nodeLabel, error: failure.error });

      const escalationMsg = `[Workflow Node Failed: ${ failure.nodeLabel }]\n` +
        `The sub-agent "${ failure.nodeLabel }" failed.\n` +
        `Error: ${ failure.error }\n\n` +
        `Tell the user what happened and ask what they'd like to do.`;
      this.injectWorkflowMessage(state, escalationMsg);
    }

    // ── Drain pending sub-agent escalations (blocked agents asking questions) ──
    // Two-phase approach:
    //   Phase 1: Ask the orchestrator if it can answer the sub-agent's question.
    //   Phase 2: If orchestrator can't answer, escalate to the user.
    if (this.pendingEscalations.length > 0) {
      const esc = this.pendingEscalations[0]; // Process one at a time — pause after each
      const msgs = (state as any).messages;

      if (!esc.orchestratorAttempted) {
        // ── Phase 1: Let the orchestrator try to answer ──
        console.log(`[Graph:Playbook] Sub-agent "${ esc.nodeLabel }" blocked — asking orchestrator to answer: ${ esc.question.slice(0, 200) }`);

        esc.orchestratorAttempted = true;

        const orchestratorPrompt =
          `[Workflow: Sub-agent "${ esc.nodeLabel }" has a question]\n` +
          `The sub-agent is blocked and needs an answer before it can continue.\n\n` +
          `Sub-agent's question:\n${ esc.question }\n\n` +
          `You are the orchestrator. Based on the workflow context and conversation history, ` +
          `decide if YOU can answer this question or if it must go to the user.\n\n` +
          `Respond with exactly ONE of these XML blocks:\n\n` +
          `If you CAN answer:\n` +
          `<SUB_AGENT_ANSWER>Your answer here</SUB_AGENT_ANSWER>\n\n` +
          `If you CANNOT answer (needs human judgment, credentials, or info you don't have):\n` +
          `<SUB_AGENT_ESCALATE>Brief explanation of what the user needs to decide</SUB_AGENT_ESCALATE>\n\n` +
          `Do NOT use send_channel_message — reply directly with one of the two XML blocks above.`;

        this.injectWorkflowMessage(state, orchestratorPrompt);
        (state as any).metadata._muteWsChat = true;
        state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
        (state as any).metadata._muteWsChat = false;

        // Parse the orchestrator's response
        const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
        const response = lastAssistant?.content ? String(lastAssistant.content) : '';

        const answerMatch = /<SUB_AGENT_ANSWER>([\s\S]*?)<\/SUB_AGENT_ANSWER>/i.exec(response);
        const escalateMatch = /<SUB_AGENT_ESCALATE>([\s\S]*?)<\/SUB_AGENT_ESCALATE>/i.exec(response);

        if (answerMatch && !escalateMatch) {
          // Orchestrator answered — re-launch the sub-agent with the answer
          const orchestratorAnswer = answerMatch[1].trim();
          this.pendingEscalations.shift();
          const augmentedPrompt = `${ esc.prompt }\n\n[The orchestrating agent provided the following answer to your question]\n${ orchestratorAnswer }`;
          const maxRetries = 3;

          console.log(`[Graph:Playbook] Orchestrator answered blocked agent "${ esc.nodeLabel }" — re-launching with answer: ${ orchestratorAnswer.slice(0, 200) }`);

          this.pendingSubAgents.set(esc.nodeId, {
            nodeId:    esc.nodeId,
            nodeLabel: esc.nodeLabel,
            agentId:   esc.agentId,
            startedAt: Date.now(),
          });

          this.executeSubAgentWithRetry(state, esc.nodeId, esc.agentId, augmentedPrompt, esc.config, esc.nodeLabel, maxRetries);
          this.emitPlaybookEvent(state, 'node_started', { nodeId: esc.nodeId, nodeLabel: esc.nodeLabel, prompt: augmentedPrompt });

          // Narrate what happened so the user sees it
          const narrateMsg = `[Workflow: Answered sub-agent "${ esc.nodeLabel }"]\n` +
            `The sub-agent asked: ${ esc.question.slice(0, 300) }\n` +
            `I answered: ${ orchestratorAnswer.slice(0, 300) }\n\n` +
            `The sub-agent has been re-launched and is continuing its work.`;
          this.injectWorkflowMessage(state, narrateMsg);
          state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
          return state;
        }

        // Orchestrator can't answer (or response didn't match) — fall through to Phase 2
        console.log(`[Graph:Playbook] Orchestrator escalated blocked agent "${ esc.nodeLabel }" to user`);
      }

      // ── Phase 2: Escalate to user (orchestrator couldn't answer) ──

      // Check if the user has responded since we paused
      const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user' && !m.content?.startsWith?.('[Workflow'));
      const lastPauseMsg = [...msgs].reverse().find((m: any) =>
        typeof m.content === 'string' && m.content.includes('[Workflow Paused:') && m.content.includes(esc.nodeLabel));

      const lastUserIdx = lastUser ? msgs.indexOf(lastUser) : -1;
      const lastPauseIdx = lastPauseMsg ? msgs.indexOf(lastPauseMsg) : -1;

      if (lastUserIdx > lastPauseIdx && lastPauseIdx >= 0) {
        // User has responded — consume the escalation and re-launch the agent
        this.pendingEscalations.shift();
        const userAnswer = String(lastUser.content);
        const augmentedPrompt = `${ esc.prompt }\n\n[User provided the following input]\n${ userAnswer }`;
        const maxRetries = 3;

        console.log(`[Graph:Playbook] User responded to blocked agent "${ esc.nodeLabel }" — re-launching with user's answer`);

        this.pendingSubAgents.set(esc.nodeId, {
          nodeId:    esc.nodeId,
          nodeLabel: esc.nodeLabel,
          agentId:   esc.agentId,
          startedAt: Date.now(),
        });

        this.executeSubAgentWithRetry(state, esc.nodeId, esc.agentId, augmentedPrompt, esc.config, esc.nodeLabel, maxRetries);
        this.emitPlaybookEvent(state, 'node_started', { nodeId: esc.nodeId, nodeLabel: esc.nodeLabel, prompt: augmentedPrompt });
      } else {
        // No user response yet — pause the workflow
        console.log(`[Graph:Playbook] Sub-agent "${ esc.nodeLabel }" blocked — pausing workflow for user input: ${ esc.question.slice(0, 200) }`);

        this.emitPlaybookEvent(state, 'workflow_paused', {
          nodeId:    esc.nodeId,
          nodeLabel: esc.nodeLabel,
          reason:    'agent_blocked',
          summary:   esc.question.slice(0, 500),
        });

        // Tell the orchestrator to surface this to the user
        const pauseMsg = `[Workflow Paused: Sub-agent "${ esc.nodeLabel }" is blocked and needs user input]\n` +
          `${ esc.question }\n\n` +
          `The orchestrator could not answer this question. Tell the user what the agent needs. The workflow is paused until the user responds.`;

        this.injectWorkflowMessage(state, pauseMsg);
        state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        // Wait for user — do not advance
        (state as any).metadata.waitingForUser = true;
        return state;
      }
    }

    // ── Inject pending sub-agent status so orchestrator stays aware ──
    if (this.pendingSubAgents.size > 0) {
      const now = Date.now();
      const lines = [...this.pendingSubAgents.values()].map(sa => {
        const elapsed = Math.round((now - sa.startedAt) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const duration = mins > 0 ? `${ mins }m ${ secs }s` : `${ secs }s`;
        return `- "${ sa.nodeLabel }" (node: ${ sa.nodeId }) — running for ${ duration }`;
      });

      const statusBlock = `[Active Workflow Sub-Agents]\n${ lines.join('\n') }\n\n` +
        `These agents are working in the background as part of the active workflow.\n` +
        `Do not duplicate their work. You can tell the user about their progress or help with other things.`;
      this.injectWorkflowMessage(state, statusBlock, true);
    }

    // Process steps until we need the agent or workflow completes
    console.log(`[Graph:Playbook] Entering walker loop`);
    const continueProcessing = true;
    try {
    while (continueProcessing) {
      const currentPlaybook: WorkflowPlaybookState = meta.activeWorkflow;
      if (currentPlaybook?.status !== 'running') break;

      const step: PlaybookStepResult = processNextStep(currentPlaybook);
      meta.activeWorkflow = step.updatedPlaybook;

      console.log(`[Graph:Playbook] Step action=${ step.action }, nodeId=${ (step as any).nodeId || 'n/a' }, playbookStatus=${ step.updatedPlaybook?.status }`);

      switch (step.action) {
      case 'prompt_orchestrator': {
        // ── Orchestrator Prompt node: inject message, get response, complete node ──
        const opNodeId = step.nodeId;
        const opLabel = this.getPlaybookNodeLabel(currentPlaybook, opNodeId);

        this.emitEdgeActivations(state, currentPlaybook.definition, opNodeId, 'incoming');
        this.emitPlaybookEvent(state, 'node_started', { nodeId: opNodeId, nodeLabel: opLabel, prompt: step.prompt });

        this.injectWorkflowMessage(state, step.prompt);
        state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        // Capture orchestrator's response as the node output
        const opMsgs = (state as any).messages;
        const opLastAssistant = [...opMsgs].reverse().find((m: any) => m.role === 'assistant');
        const opResult = opLastAssistant?.content ?? '';

        const opCompleted = completeSubAgent(meta.activeWorkflow, opNodeId, opResult);
        meta.activeWorkflow = opCompleted.updatedPlaybook;

        this.emitPlaybookEvent(state, 'node_completed', { nodeId: opNodeId, nodeLabel: opLabel, output: opResult });
        this.emitEdgeActivations(state, currentPlaybook.definition, opNodeId, 'outgoing');
        await this.saveCheckpoint(opCompleted.updatedPlaybook, opNodeId, opLabel, 'orchestrator-prompt', opResult);

        if (opCompleted.action === 'workflow_completed') {
          this.emitPlaybookEvent(state, 'workflow_completed', {});
          state = await this.releaseWorkflow(state, opCompleted.updatedPlaybook, 'completed');
          return state;
        }
        break;
      }

      case 'prompt_agent': {
        // Inject the prompt as a user message and re-enter agent loop
        const decisionNodeId = step.updatedPlaybook.pendingDecision?.nodeId;
        if (decisionNodeId) {
          this.emitEdgeActivations(state, step.updatedPlaybook.definition, decisionNodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', {
            nodeId:    decisionNodeId,
            nodeLabel: this.getPlaybookNodeLabel(step.updatedPlaybook, decisionNodeId),
            prompt:    step.prompt,
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
            const resolvedNodeId = pendingPlaybook.pendingDecision?.nodeId;
            const resolved = resolveDecision(pendingPlaybook, String(lastAssistant.content));
            meta.activeWorkflow = resolved.updatedPlaybook;
            if (resolvedNodeId) {
              const rNodeLabel = this.getPlaybookNodeLabel(pendingPlaybook, resolvedNodeId);
              const rNodeSubtype = this.getPlaybookNodeSubtype(pendingPlaybook, resolvedNodeId);
              this.emitPlaybookEvent(state, 'node_completed', {
                nodeId:    resolvedNodeId,
                nodeLabel: rNodeLabel,
                output:    lastAssistant.content,
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
        const isIntegrationCall = step.agentId === '__integration_call__';

        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
        this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: subNodeLabel, prompt: step.prompt });

        if (isIntegrationCall) {
          // ── Tool Call: orchestrator validates params, then execute silently ──
          const preCallDesc = (step.config.preCallDescription as string) || '';
          const toolInfo = `Integration: ${ step.config.integrationSlug || 'unknown' }\nEndpoint: ${ step.config.endpointName || 'unknown' }`;
          const paramSummary = Object.entries((step.config.defaults as Record<string, string>) || {})
            .map(([k, v]) => `  ${ k }: ${ v }`)
            .join('\n');

          const validatePrompt = `[Workflow Tool Call: ${ subNodeLabel }]\n${ toolInfo }\n${ paramSummary ? `\nParameters:\n${ paramSummary }` : '' }\n${ preCallDesc ? `\nDescription: ${ preCallDesc }` : '' }\n\nValidate these parameters. The tool will execute after your review.`;
          this.injectWorkflowMessage(state, validatePrompt);
          state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

          // Execute the tool call
          try {
            const result = await this.executeSubAgent(state, step.nodeId, step.agentId, step.prompt, step.config);
            const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

            // Add result to thread silently — no orchestrator re-entry
            this.injectWorkflowMessage(state, `[Tool Call Result: ${ subNodeLabel }]\n${ resultText }`, true);

            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, result.output, result.threadId);
            meta.activeWorkflow = completed.updatedPlaybook;

            this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, output: resultText });
            this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
            await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, subNodeLabel, 'integration-call', resultText);

            if (completed.action === 'workflow_completed') {
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
          // ── Agent Node: orchestrator-mediated deployment ──
          // Phase 1: Orchestrator formulates the sub-agent's task message
          // Phase 2: Sub-agent executes with the formulated message
          // Phase 3: Orchestrator evaluates the response against success criteria
          const agentName = (step.config.agentName as string) || step.agentId || 'default';
          const additionalPrompt = (step.config.additionalPrompt as string) || '';
          const completionContract = (step.config.completionContract as string) || '';
          const successCriteria = (step.config.successCriteria as string) || '';

          // ── Phase 1: Ask orchestrator to formulate the sub-agent's message ──
          let formationMsg = `[Workflow: Deploying Agent — ${ subNodeLabel }]\n` +
            `Agent type: ${ agentName }\n\n`;

          if (step.prompt.trim()) {
            formationMsg += `Here are your instructions for deploying this sub-agent:\n${ step.prompt }\n\n`;
          }

          formationMsg += `Formulate the complete task message that will be sent to this sub-agent. Be specific about:\n` +
            `1. What the sub-agent needs to accomplish\n` +
            `2. What completion contract to follow — describe the exact format and content for its final deliverable\n\n`;

          if (completionContract.trim()) {
            formationMsg += `The workflow expects this completion structure:\n${ completionContract }\n\n`;
          }

          formationMsg += `The sub-agent's final response MUST be wrapped in <completion-contract> XML tags.\n` +
            `Include these requirements in your message to the sub-agent.\n\n` +
            `## Delegation\n` +
            `You may delegate work to multiple agents by wrapping each task in a <PROMPT> tag.\n` +
            `Each <PROMPT> spawns one agent in parallel. Attributes:\n` +
            `  agentId="name" (optional — defaults to "${ agentName }")\n` +
            `  label="description" (optional — names the result for downstream reference)\n\n` +
            `Example:\n` +
            `<PROMPT agentId="observer" label="Financial">Watch for financial signals...</PROMPT>\n` +
            `<PROMPT agentId="observer" label="Emotional">Watch for emotional patterns...</PROMPT>\n\n` +
            `If you don't use <PROMPT> tags, your entire response is sent as a single task to the configured agent.\n\n` +
            `Respond with the message(s) to send to the sub-agent(s).`;

          this.injectWorkflowMessage(state, formationMsg);
          (state as any).metadata._muteWsChat = true;
          state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
          (state as any).metadata._muteWsChat = false;

          // Extract orchestrator's formulated message
          const lastMsg = (state as any).messages?.[(state as any).messages.length - 1];
          const orchestratorResponse = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

          // Parse <PROMPT> tags for delegation
          const parsedPrompts = parsePromptTags(orchestratorResponse);
          // Strip <PROMPT> tags and legacy SPAWN_COUNT from the cleaned message
          const cleanedMessage = orchestratorResponse
            .replace(/<PROMPT[^>]*>[\s\S]*?<\/PROMPT>/gi, '')
            .replace(/SPAWN_COUNT:\s*\d+\s*/gi, '')
            .trim();

          const contractWrapper = `\nIMPORTANT: When you have completed your task, you MUST wrap your final deliverable in <completion-contract> XML tags:\n` +
            `<completion-contract>\nYour final response here\n</completion-contract>`;

          // ── Phase 2: Launch sub-agent(s) ──
          if (parsedPrompts.length > 0) {
            // ── Batch delegation: one agent per <PROMPT> tag, all in parallel ──
            const cappedPrompts = parsedPrompts.slice(0, 10);
            console.log(`[Graph:Playbook] Orchestrator delegated ${ cappedPrompts.length } prompts for "${ subNodeLabel }"`);
            this.emitPlaybookEvent(state, 'node_parallel_spawn', { nodeId: step.nodeId, nodeLabel: subNodeLabel, count: cappedPrompts.length });

            const delegationSummary = cappedPrompts.map((pp, i) =>
              `  ${ i + 1 }. [${ pp.label || `prompt-${ i }` }] (agent: ${ pp.agentId || agentName })`,
            ).join('\n');
            this.injectWorkflowMessage(state, `[Workflow: Agent Delegation — ${ subNodeLabel }]\nSpawning ${ cappedPrompts.length } agents in parallel:\n${ delegationSummary }\n\nAll agents are launching now.`);
            state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

            const parallelPromises = cappedPrompts.map((pp, i) => {
              const promptParts: string[] = [];
              if (additionalPrompt.trim()) promptParts.push(additionalPrompt);
              promptParts.push(pp.content);
              promptParts.push(contractWrapper);
              const fullPrompt = promptParts.join('\n\n');
              const effectiveAgentId = pp.agentId || step.agentId;
              const instanceId = `${ step.nodeId }-prompt-${ i }`;

              return this.executeSubAgent(state, instanceId, effectiveAgentId, fullPrompt, step.config)
                .then(result => ({ index: i, label: pp.label || `prompt-${ i }`, result, error: null as string | null }))
                .catch((err: any) => ({ index: i, label: pp.label || `prompt-${ i }`, result: null as { output: unknown; threadId?: string; contractStatus: 'done' | 'blocked' | 'no_contract' } | null, error: err.message || String(err) }));
            });

            const results = await Promise.allSettled(parallelPromises);

            const successes: { index: number; label: string; resultText: string; threadId?: string }[] = [];
            const failures: { index: number; label: string; error: string }[] = [];

            for (const outcome of results) {
              if (outcome.status === 'fulfilled') {
                const { index, label, result, error } = outcome.value;
                if (error || !result) {
                  failures.push({ index, label, error: error || 'Unknown error' });
                } else if (result.contractStatus === 'no_contract') {
                  failures.push({ index, label, error: 'Sub-graph died without completion contract' });
                } else if (result.contractStatus === 'blocked') {
                  const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
                  failures.push({ index, label, error: `Blocked: ${ resultText.slice(0, 200) }` });
                } else {
                  const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
                  successes.push({ index, label, resultText, threadId: result.threadId });
                }
              } else {
                failures.push({ index: -1, label: 'unknown', error: outcome.reason?.message || String(outcome.reason) });
              }
            }

            console.log(`[Graph:Playbook] Delegation "${ subNodeLabel }": ${ successes.length }/${ cappedPrompts.length } succeeded, ${ failures.length } failed`);

            if (successes.length === 0) {
              const errSummary = failures.map(f => `${ f.label }: ${ f.error }`).join('; ');
              this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, error: errSummary });

              const escalationMsg = `[Workflow Node Failed: ${ subNodeLabel }]\n` +
                `All ${ cappedPrompts.length } delegated agents failed.\n` +
                `Errors: ${ errSummary }\n\n` +
                `The workflow "${ currentPlaybook.definition?.name }" is paused. Ask the user what to do.`;

              this.injectWorkflowMessage(state, escalationMsg);
              state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
              return state;
            }

            // Build batch output in merge-compatible format for downstream for-each loops
            const batchOutput = {
              strategy: 'delegation',
              merged:   successes.map(s => ({
                nodeId: `${ step.nodeId }-prompt-${ s.index }`,
                label:  s.label,
                result: s.resultText,
              })),
            };

            const failureNote = failures.length > 0
              ? `\n\n(${ failures.length }/${ cappedPrompts.length } agents failed: ${ failures.map(f => `${ f.label }: ${ f.error.slice(0, 100) }`).join('; ') })`
              : '';

            // ── Phase 3: Orchestrator evaluates with success criteria (batch) ──
            const batchSummaryText = successes.map(s => {
              const handBack = parseHandBack(s.resultText);
              return `[${ s.label }] ${ handBack.summary || s.resultText.slice(0, 500) }`;
            }).join('\n\n');

            let finalOutput: unknown = batchOutput;
            if (successCriteria.trim()) {
              const evalMsg = `[Sub-agents Complete: ${ subNodeLabel } — ${ successes.length }/${ cappedPrompts.length } agents]\n\n` +
                `${ batchSummaryText }${ failureNote }\n\n` +
                `Evaluate the results against the following success criteria:\n${ successCriteria }\n\n` +
                `If the results meet all criteria, respond with APPROVED and a brief summary.\n` +
                `If they fail any criteria, respond with NEEDS_REVISION and explain what fell short.`;

              this.injectWorkflowMessage(state, evalMsg);
              state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
            } else {
              const resultMsg = `[Workflow Node Complete: ${ subNodeLabel } — ${ successes.length }/${ cappedPrompts.length } agents]\n${ batchSummaryText }${ failureNote }`;
              this.injectWorkflowMessage(state, resultMsg, true);
            }

            const firstThread = successes[0]?.threadId;
            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, finalOutput, firstThread);
            meta.activeWorkflow = completed.updatedPlaybook;

            this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, output: JSON.stringify(finalOutput), instanceCount: cappedPrompts.length, succeeded: successes.length, failed: failures.length });
            this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
            await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, subNodeLabel, 'agent', JSON.stringify(finalOutput));

            if (completed.action === 'workflow_completed') {
              this.emitPlaybookEvent(state, 'workflow_completed', {});
              state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
              return state;
            }
          } else {
            // ── Single agent: no <PROMPT> tags — existing non-blocking path ──
            const subAgentPromptParts: string[] = [];
            if (additionalPrompt.trim()) {
              subAgentPromptParts.push(additionalPrompt);
            }
            subAgentPromptParts.push(cleanedMessage);
            subAgentPromptParts.push(contractWrapper);

            const subAgentPrompt = subAgentPromptParts.join('\n\n');
            const maxRetries = 3;
            const nodeId = step.nodeId;
            const agentId = step.agentId;

            console.log(`[Graph:Playbook] Launching sub-agent "${ subNodeLabel }" (agent: ${ agentId }) non-blocking`);

            this.pendingSubAgents.set(nodeId, {
              nodeId,
              nodeLabel: subNodeLabel,
              agentId,
              startedAt: Date.now(),
            });

            // Store success criteria + completion contract on the pending entry so the
            // completion handler can run Phase 3 evaluation
            const pending = this.pendingSubAgents.get(nodeId)!;
            (pending as any).successCriteria = successCriteria;
            (pending as any).completionContract = completionContract;

            this.executeSubAgentWithRetry(state, nodeId, agentId, subAgentPrompt, step.config, subNodeLabel, maxRetries);

            const narrateMsg = `[Workflow: Sub-agent "${ subNodeLabel }" launched]\n` +
              `Agent type: ${ agentName }\n` +
              `Task: ${ cleanedMessage.slice(0, 300) }${ cleanedMessage.length > 300 ? '...' : '' }\n\n` +
              `The sub-agent is now running in the background. Tell the user what you just launched ` +
              `and what it will do. You can continue helping the user while it works.`;

            this.injectWorkflowMessage(state, narrateMsg);
            state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

            return state;
          }
        }
        break;
      }

      case 'spawn_parallel_agents': {
        // ── True parallel execution: fire all sub-agents concurrently ──
        const parallelNodes = step.nodes;
        const nodeLabels = parallelNodes.map(n => this.getPlaybookNodeLabel(currentPlaybook, n.nodeId));

        // Emit started events for all parallel nodes
        for (let i = 0; i < parallelNodes.length; i++) {
          const pn = parallelNodes[i];
          this.emitEdgeActivations(state, currentPlaybook.definition, pn.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: pn.nodeId, nodeLabel: nodeLabels[i], prompt: pn.prompt });
        }

        // Before prompt: notify orchestrator about the parallel batch
        const batchSummary = parallelNodes.map((pn, i) => {
          const isIntegrationCall = pn.agentId === '__integration_call__';
          return `  ${ i + 1 }. [${ nodeLabels[i] }] (${ isIntegrationCall ? 'integration-call' : `agent: ${ pn.config.agentName || pn.agentId || 'default' }` })`;
        }).join('\n');
        this.injectWorkflowMessage(state, `[Workflow: Parallel Execution]\nThe following ${ parallelNodes.length } nodes will execute concurrently:\n${ batchSummary }\n\nAll branches are launching now.`);
        state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        // Fire all sub-agents concurrently with Promise.allSettled
        const parallelPromises = parallelNodes.map(async(pn, i) => {
          const result = await this.executeSubAgent(state, pn.nodeId, pn.agentId, pn.prompt, pn.config);
          return { nodeId: pn.nodeId, label: nodeLabels[i], result, config: pn.config, agentId: pn.agentId };
        });

        const settled = await Promise.allSettled(parallelPromises);

        // Process results — complete succeeded nodes, fail others
        const successes: { nodeId: string; label: string; resultText: string; threadId?: string }[] = [];
        const failures: { nodeId: string; label: string; error: string }[] = [];

        for (const outcome of settled) {
          if (outcome.status === 'fulfilled') {
            const { nodeId: nId, label, result } = outcome.value;

            // Check contract status — only complete nodes that finished properly
            if (result.contractStatus === 'no_contract') {
              console.warn(`[Graph:Playbook] Parallel node "${ label }" returned without contract — graph died mid-execution`);
              this.emitPlaybookEvent(state, 'node_failed', { nodeId: nId, nodeLabel: label, error: 'Sub-graph died without completion contract' });
              failures.push({ nodeId: nId, label, error: 'Sub-graph died without completion contract' });
              continue;
            }

            if (result.contractStatus === 'blocked') {
              // Blocked = sub-agent has a question. Escalate via the same path as single agents
              // instead of treating it as a failure.
              const blockText = typeof result.output === 'string' ? result.output : 'Unknown blocker';
              const pnMatch = parallelNodes.find(p => p.nodeId === nId);
              console.log(`[Graph:Playbook] Parallel node "${ label }" blocked — pushing to escalations`);
              this.pendingEscalations.push({
                nodeId:    nId,
                nodeLabel: label,
                agentId:   pnMatch?.agentId || '',
                prompt:    pnMatch?.prompt || '',
                config:    pnMatch?.config || {},
                question:  blockText.slice(0, 500),
                threadId:  result.threadId,
              });
              // Don't count as failure — will be resolved by escalation handler
              continue;
            }

            const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

            const completed = completeSubAgent(meta.activeWorkflow, nId, result.output, result.threadId);
            meta.activeWorkflow = completed.updatedPlaybook;

            this.emitPlaybookEvent(state, 'node_completed', { nodeId: nId, nodeLabel: label, output: resultText, threadId: result.threadId });
            this.emitEdgeActivations(state, currentPlaybook.definition, nId, 'outgoing');
            const nodeSubtype = this.getPlaybookNodeSubtype(currentPlaybook, nId);
            await this.saveCheckpoint(completed.updatedPlaybook, nId, label, nodeSubtype, resultText);

            successes.push({ nodeId: nId, label, resultText, threadId: result.threadId });
          } else {
            const pn = parallelNodes[settled.indexOf(outcome)];
            const label = this.getPlaybookNodeLabel(currentPlaybook, pn.nodeId);
            const errMsg = outcome.reason?.message || String(outcome.reason);

            this.emitPlaybookEvent(state, 'node_failed', { nodeId: pn.nodeId, nodeLabel: label, error: errMsg });
            failures.push({ nodeId: pn.nodeId, label, error: errMsg });
          }
        }

        // If all nodes failed, fail the workflow
        if (successes.length === 0 && failures.length > 0) {
          const errSummary = failures.map(f => `${ f.label }: ${ f.error }`).join('; ');
          const failedPlaybook = { ...meta.activeWorkflow, status: 'failed' as const, error: `All parallel branches failed: ${ errSummary }` };
          this.emitPlaybookEvent(state, 'workflow_failed', { error: failedPlaybook.error });
          state = await this.releaseWorkflow(state, failedPlaybook, 'failed', failedPlaybook.error);
          return state;
        }

        // After prompt: summarize results for orchestrator
        const resultsSummary = [
          ...successes.map(s => `  [${ s.label }]: completed`),
          ...failures.map(f => `  [${ f.label }]: FAILED — ${ f.error }`),
        ].join('\n');
        this.injectWorkflowMessage(state, `[Workflow: Parallel Execution Complete]\n${ successes.length }/${ parallelNodes.length } branches succeeded.\n${ resultsSummary }\n\nReview and continue.`, failures.length === 0);
        if (failures.length > 0) {
          // Only re-enter agent if there were partial failures to review
          state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
        }

        // Check if workflow completed after all parallel nodes
        if (meta.activeWorkflow?.status === 'completed') {
          this.emitPlaybookEvent(state, 'workflow_completed', {});
          state = await this.releaseWorkflow(state, meta.activeWorkflow, 'completed');
          return state;
        }

        break;
      }

      case 'execute_tool_call': {
        // ── Native tool call: execute directly and inject result into orchestrator thread ──
        const toolNodeLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
        this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: toolNodeLabel });

        try {
          // Dynamically import the tool registry and execute
          const { toolRegistry } = await import('../tools/registry');
          const tool = await toolRegistry.getTool(step.toolName);
          const toolResult = await tool.call(step.params);

          const resultText = toolResult.success
            ? (toolResult.result || 'Tool completed successfully')
            : `Tool error: ${ toolResult.error || 'Unknown error' }`;

          // Complete the node in the playbook
          const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, resultText, undefined);
          meta.activeWorkflow = completed.updatedPlaybook;

          this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: toolNodeLabel, output: resultText });
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
          await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, toolNodeLabel, 'tool-call', resultText);

          // Inject tool call + result into orchestrator's conversation as a pair
          const toolCallMsg = `[Workflow Tool Call: ${ toolNodeLabel }]\n` +
            `Tool: ${ step.toolName }\n` +
            `Parameters: ${ JSON.stringify(step.params) }\n\n` +
            `Result:\n${ resultText }`;
          this.injectWorkflowMessage(state, toolCallMsg, true);

          if (completed.action === 'workflow_completed') {
            this.emitPlaybookEvent(state, 'workflow_completed', {});
            state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
            return state;
          }
        } catch (err: any) {
          console.error(`[Graph:Playbook] Native tool call failed:`, err);
          const errMsg = err.message || String(err);

          // Still complete the node with the error — don't fail the whole workflow
          const errorResult = `Tool call failed: ${ errMsg }`;
          const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, errorResult, undefined);
          meta.activeWorkflow = completed.updatedPlaybook;

          this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: toolNodeLabel, output: errorResult });
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');

          const errorMsg = `[Workflow Tool Call Failed: ${ toolNodeLabel }]\n` +
            `Tool: ${ step.toolName }\n` +
            `Error: ${ errMsg }\n\n` +
            `The workflow will continue — review the error and decide how to proceed.`;
          this.injectWorkflowMessage(state, errorMsg);
          state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
        }

        break;
      }

      case 'spawn_sub_workflow': {
        const subWfLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
        this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: subWfLabel });

        try {
          // Load the sub-workflow definition via the registry (scans production dir)
          const { getWorkflowRegistry } = await import('@pkg/agent/workflow/WorkflowRegistry');
          const subRegistry = getWorkflowRegistry();
          const subDefinition = subRegistry.loadWorkflow(step.workflowId);

          if (step.agentId) {
            // ── Delegated orchestration: spawn a dedicated agent to run the sub-workflow ──
            console.log(`[Graph:Playbook] Delegating sub-workflow "${ subWfLabel }" to agent "${ step.agentId }"`);

            const { GraphRegistry } = await import('../services/GraphRegistry');
            const threadId = `workflow-subwf-${ step.nodeId }-${ Date.now() }`;
            const { graph: subGraph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(step.agentId, threadId) as {
              graph: any;
              state: any;
            };

            // Activate the sub-workflow playbook on the delegated agent
            const subPlaybook = createPlaybookState(subDefinition, step.payload);
            subState.metadata.activeWorkflow = subPlaybook;
            subState.metadata.isSubAgent = true;

            // Tag with workflow nodeId for UI events
            const parentChannel = (state as any).metadata?.wsChannel || 'workbench';
            subState.metadata.workflowNodeId = step.nodeId;
            subState.metadata.workflowParentChannel = parentChannel;

            // Inject a prompt so the delegated agent knows its role
            const basePrompt = `You are orchestrating the workflow "${ subDefinition.name }". ` +
              `Process it step by step using your persona, tools, and judgment. ` +
              `The workflow has been loaded into your active playbook.`;
            const fullPrompt = step.orchestratorPrompt
              ? `${ basePrompt }\n\nAdditional instructions from the parent workflow:\n${ step.orchestratorPrompt }`
              : basePrompt;
            subState.messages.push({ role: 'user', content: fullPrompt });

            // Execute the delegated agent graph — it will process the workflow via its own playbook loop
            const finalSubState = await subGraph.execute(subState);

            // Extract the result from the completed sub-workflow
            const subOutputs = Object.values(finalSubState.metadata?.activeWorkflow?.nodeOutputs ?? {}) as PlaybookNodeOutput[];
            const lastOutput = subOutputs[subOutputs.length - 1];
            const subResult = lastOutput?.result ?? null;

            // Complete the sub-workflow node in the parent playbook
            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, subResult, threadId);
            meta.activeWorkflow = completed.updatedPlaybook;

            this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: subWfLabel, output: subResult });
            this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
            await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, subWfLabel, 'sub-workflow', subResult);

            // Narrate the result to the orchestrator
            const resultText = typeof subResult === 'string' ? subResult : JSON.stringify(subResult);
            this.injectWorkflowMessage(state, `[Sub-workflow Complete: ${ subWfLabel }]\nOrchestrated by agent "${ step.agentId }"\nResult: ${ (resultText || '').substring(0, 500) }${ (resultText || '').length > 500 ? '...' : '' }`);

            if (completed.action === 'workflow_completed') {
              this.emitPlaybookEvent(state, 'workflow_completed', {});
              state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
              return state;
            }
          } else {
            // ── Default: same-agent orchestration (swap playbook) ──
            // Save parent workflow onto a stack
            const parentPlaybook = meta.activeWorkflow;
            if (!meta.workflowStack) meta.workflowStack = [];
            meta.workflowStack.push({ playbook: parentPlaybook, nodeId: step.nodeId });

            // Create and activate the sub-workflow playbook
            const subPlaybook = createPlaybookState(subDefinition, step.payload);
            meta.activeWorkflow = subPlaybook;

            // Process the sub-workflow through the same loop (recursive via continue)
            // The main while loop will pick up meta.activeWorkflow which is now the sub-workflow
          }
          break;
        } catch (err: any) {
          console.error(`[Graph:Playbook] Sub-workflow failed to load:`, err);
          this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: subWfLabel, error: err.message || String(err) });
          const failedPlaybook = { ...meta.activeWorkflow, status: 'failed', error: err.message || String(err) };
          this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
          state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
          return state;
        }
      }

      case 'transfer_workflow': {
        const transferLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
        console.log(`[Graph:Playbook] Transfer to workflow "${ step.targetWorkflowId }" from node "${ step.nodeId }"`);

        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
        this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: transferLabel });

        try {
          // Load the target workflow definition via the registry (scans production dir)
          const { getWorkflowRegistry: getTransferRegistry } = await import('@pkg/agent/workflow/WorkflowRegistry');
          const transferRegistry = getTransferRegistry();
          const targetDefinition = transferRegistry.loadWorkflow(step.targetWorkflowId);

          // Mark the transfer node as completed
          this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: transferLabel, output: { transferred: step.targetWorkflowId } });
          await this.saveCheckpoint(step.updatedPlaybook, step.nodeId, transferLabel, 'transfer', { transferred: step.targetWorkflowId });

          // Capture outgoing workflow metadata (like releaseWorkflow, but without clearing activeWorkflow)
          const outgoingPlaybook = meta.activeWorkflow as WorkflowPlaybookState;
          const nodeSummaries = Object.values(outgoingPlaybook.nodeOutputs ?? {}).map((output: PlaybookNodeOutput) => ({
            nodeId:   output.nodeId,
            label:    output.label,
            subtype:  output.subtype,
            category: output.category,
            result:   typeof output.result === 'string' ? output.result : JSON.stringify(output.result),
            threadId: output.threadId,
          }));

          meta.lastCompletedWorkflow = {
            workflowId:    outgoingPlaybook.workflowId,
            workflowName:  outgoingPlaybook.definition.name,
            executionId:   outgoingPlaybook.executionId,
            outcome:       'completed',
            startedAt:     outgoingPlaybook.startedAt,
            completedAt:   new Date().toISOString(),
            nodeResults:   nodeSummaries,
            transferredTo: step.targetWorkflowId,
          };

          // Abandon the workflow stack — transfer is a clean break
          meta.workflowStack = [];

          // Complete the old workflow on the canvas
          this.emitPlaybookEvent(state, 'workflow_completed', {});

          // Create and activate the target workflow
          const targetPlaybook = createPlaybookState(targetDefinition, step.payload);
          meta.activeWorkflow = targetPlaybook;

          console.log(`[Graph:Playbook] Transferred to "${ targetDefinition.name }" (${ targetPlaybook.executionId })`);

          // Notify orchestrator about the transfer
          this.injectWorkflowMessage(state, `[Workflow Transfer] The workflow "${ outgoingPlaybook.definition.name }" has handed off to "${ targetDefinition.name }". The new workflow is now active.`);

          // The main while loop will pick up the new meta.activeWorkflow
          break;
        } catch (err: any) {
          console.error(`[Graph:Playbook] Transfer failed:`, err);
          this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: transferLabel, error: err.message || String(err) });
          const failedPlaybook = { ...meta.activeWorkflow, status: 'failed', error: err.message || String(err) };
          this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
          state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
          return state;
        }
      }

      case 'node_completed': {
        const mechLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
        this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: mechLabel });
        this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: mechLabel, output: step.result });
        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
        await this.saveCheckpoint(step.updatedPlaybook, step.nodeId, mechLabel, this.getPlaybookNodeSubtype(currentPlaybook, step.nodeId), step.result);
        break;
      }

      case 'wait': {
        const waitLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
        this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: waitLabel });

        // Abort-aware wait — respects cancellation instead of sleeping through it
        const abortService = meta.options?.abort;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, step.durationMs);
          if (abortService?.signal) {
            const onAbort = () => { clearTimeout(timer); reject(new Error('AbortError')); };
            if (abortService.signal.aborted) { clearTimeout(timer); reject(new Error('AbortError')); return; }
            abortService.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        throwIfAborted(abortService);

        const waitNode = meta.activeWorkflow.definition.nodes.find((n: any) => n.id === step.nodeId);
        if (waitNode) {
          const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, `Waited ${ step.durationMs }ms`);
          meta.activeWorkflow = completed.updatedPlaybook;
        }
        this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: waitLabel, output: `Waited ${ step.durationMs }ms` });
        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
        await this.saveCheckpoint(meta.activeWorkflow, step.nodeId, waitLabel, 'wait', `Waited ${ step.durationMs }ms`);
        break;
      }

      case 'await_user_input': {
        const uiNodeLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
        console.log(`[Graph:Playbook] User input node "${ step.nodeId }" — waiting for user response`);

        this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
        this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: uiNodeLabel });
        this.emitPlaybookEvent(state, 'node_waiting', { nodeId: step.nodeId, nodeLabel: uiNodeLabel, output: { promptText: step.promptText } });

        // Tell the orchestrator to present the question to the user
        this.injectWorkflowMessage(state, `[Workflow: User Input Required]\nThe workflow needs input from the user before it can continue.\n\nPrompt to present: ${ step.promptText }\n\nAsk the user this question now. Do NOT answer it yourself — wait for the user to respond.`);

        // Re-enter the agent loop so the orchestrator can present the question
        state = await this.execute(state, this.entryPoint || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        // Return — the workflow is now paused. When the user responds,
        // the next agent cycle will call processWorkflowPlaybook again,
        // which will resolve the pendingDecision with the user's message.
        return state;
      }

      case 'workflow_completed': {
        // Guard: if only triggers completed, something is wrong with upstream resolution
        const onlyTriggersCompleted = Object.values(step.updatedPlaybook.nodeOutputs ?? {})
          .every((o: PlaybookNodeOutput) => o.category === 'trigger');
        if (onlyTriggersCompleted) {
          console.error(`[Graph:Playbook] BUG: Workflow completed with only triggers done. Frontier: [${ currentPlaybook.currentNodeIds }], completedIds: [${ currentPlaybook.completedNodeIds }]`);
        }

        // Check if this is a sub-workflow completing — pop the stack
        if (meta.workflowStack?.length > 0) {
          const parent = meta.workflowStack.pop();
          const subOutputs = Object.values(step.updatedPlaybook.nodeOutputs ?? {});
          const lastOutput = subOutputs[subOutputs.length - 1];
          const subResult = lastOutput?.result ?? null;

          this.emitPlaybookEvent(state, 'workflow_completed', {});

          // Complete the sub-workflow node in the parent playbook
          const completed = completeSubAgent(parent.playbook, parent.nodeId, subResult);
          meta.activeWorkflow = completed.updatedPlaybook;

          const parentNodeLabel = this.getPlaybookNodeLabel(parent.playbook, parent.nodeId);
          this.emitPlaybookEvent(state, 'node_completed', { nodeId: parent.nodeId, nodeLabel: parentNodeLabel, output: subResult });
          this.emitEdgeActivations(state, parent.playbook.definition, parent.nodeId, 'outgoing');
          await this.saveCheckpoint(completed.updatedPlaybook, parent.nodeId, parentNodeLabel, 'sub-workflow', subResult);

          if (completed.action === 'workflow_completed') {
            // Parent workflow also completed
            this.emitPlaybookEvent(state, 'workflow_completed', {});
            state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
            return state;
          }
          // Continue processing parent workflow
          break;
        }

        this.emitPlaybookEvent(state, 'workflow_completed', {});
        state = await this.releaseWorkflow(state, step.updatedPlaybook, 'completed');
        return state;
      }

      case 'workflow_failed': {
        // If a sub-workflow fails, propagate failure to the parent
        if (meta.workflowStack?.length > 0) {
          const parent = meta.workflowStack.pop();
          console.error(`[Graph:Playbook] Sub-workflow failed: ${ step.error }, propagating to parent node "${ parent.nodeId }"`);
          this.emitPlaybookEvent(state, 'workflow_failed', { error: step.error });
          this.emitPlaybookEvent(state, 'node_failed', { nodeId: parent.nodeId, error: step.error });

          // Fail the parent workflow
          const failedParent = { ...parent.playbook, status: 'failed' as const, error: step.error };
          meta.activeWorkflow = failedParent;
          this.emitPlaybookEvent(state, 'workflow_failed', { error: step.error });
          state = await this.releaseWorkflow(state, failedParent, 'failed', step.error);
          return state;
        }

        console.error(`[Graph:Playbook] Workflow failed: ${ step.error }`);
        this.emitPlaybookEvent(state, 'workflow_failed', { error: step.error });
        state = await this.releaseWorkflow(state, step.updatedPlaybook, 'failed', step.error);
        return state;
      }
      case 'waiting_for_sub_agents': {
        // Frontier nodes are blocked waiting for in-flight sub-agents.
        // This is NOT a completion — just return and let the sub-agent
        // completions trigger the next processWorkflowPlaybook cycle.
        const waitingLabels = step.blockedNodeIds.map(id => this.getPlaybookNodeLabel(currentPlaybook, id));
        console.log(`[Graph:Playbook] Waiting for sub-agents: ${ waitingLabels.join(', ') } (missing upstream: ${ step.missingUpstream.join(', ') })`);
        return state;
      }
      default:
        console.warn(`[Graph:Playbook] Unhandled step action: ${ (step as any).action }`);
        break;
      }
      }
    } catch (err: any) {
      console.error(`[Graph:Playbook] Walker crashed:`, err);
      const failedPlaybook = { ...meta.activeWorkflow, status: 'failed' as const, error: err.message || String(err) };
      this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
      state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
    }

    return state;
  }

  /**
   * Emit a workflow execution event via WebSocket so the frontend can update both
   * the vue-flow canvas (WorkflowEditor) and the chat message list (AgentPersonaModel).
   *
   * **Consumers (two independent listeners on the same WebSocket channel):**
   *
   * 1. **Canvas path** — `EditorChatInterface` forwards the raw event to
   *    `AgentEditor.vue`, which calls methods on `WorkflowEditor.vue`
   *    (`updateNodeExecution`, `clearAllExecution`, `setEdgeAnimated`, `pushNodeThinking`).
   *
   * 2. **Chat path** — `AgentPersonaModel.handleWebSocketMessage()` creates or
   *    mutates `ChatMessage` objects (kind: `'workflow_node'`) in the reactive
   *    messages array, rendered by `WorkflowNodeCard.vue`.
   *
   * **Supported event types:**
   * - `workflow_started`  — resets canvas; creates a "Workflow Started" chat card
   * - `node_started`      — sets node running on canvas; creates a running chat card
   * - `node_completed`    — updates canvas + chat card to completed
   * - `node_failed`       — updates canvas + chat card to failed
   * - `node_waiting`      — chat-only (updates card to waiting; canvas ignores)
   * - `node_thinking`     — canvas-only (pushes thinking message; chat ignores)
   * - `edge_activated`    — canvas-only (animates edge; chat ignores)
   * - `workflow_completed` — chat updates start card; canvas is a no-op
   * - `workflow_failed`    — chat updates start card; canvas is a no-op
   * - `workflow_aborted`   — canvas no-op; chat does not handle
   *
   * @param state  Current graph state (provides wsChannel + threadId from metadata)
   * @param type   One of the event types listed above
   * @param data   Extra payload fields merged into the event (e.g. nodeId, nodeLabel, output, error)
   */
  private emitPlaybookEvent(state: TState, type: string, data: Record<string, unknown> = {}): void {
    try {
      const ws = getWebSocketClientService();
      const channel = (state as any).metadata?.wsChannel || 'workbench';
      const meta = (state as any).metadata ?? {};
      const playbook = meta.activeWorkflow;

      // Compute progress counters from the active playbook
      let totalNodes = 0;
      let nodeIndex = 0;

      if (playbook?.definition?.nodes) {
        const executableNodes = (playbook.definition.nodes as any[]).filter(
          (n: any) => n.data?.category !== 'trigger',
        );

        totalNodes = executableNodes.length;
        nodeIndex = Object.keys(playbook.nodeOutputs ?? {}).length;
      }

      ws.send(channel, {
        type:      'workflow_execution_event',
        data:      {
          type, thread_id: meta.threadId, timestamp: new Date().toISOString(), totalNodes, nodeIndex, ...data,
        },
        timestamp: Date.now(),
      });
    } catch { /* best-effort */ }
  }

  /**
   * Emit `edge_activated` events for all edges connecting to/from a node.
   *
   * These events are consumed **only by the canvas** (WorkflowEditor.vue via
   * `setEdgeAnimated`). The chat path in AgentPersonaModel explicitly skips them.
   *
   * @param state      Current graph state (forwarded to `emitPlaybookEvent`)
   * @param definition Workflow definition containing the edges array
   * @param nodeId     The node whose edges should animate
   * @param direction  `'incoming'` animates edges pointing INTO the node,
   *                   `'outgoing'` animates edges going OUT of the node
   */
  private emitEdgeActivations(
    state: TState,
    definition: { edges: { source: string; target: string }[] },
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
   *
   * Training data logging is intentionally NOT done here. The message will be
   * logged by `BaseNode.logTrainingTurn()` after `InputHandlerNode.sanitizeMessage()`
   * has normalized whitespace. Logging here would create a duplicate entry because
   * sanitization mutates the content in place (e.g. collapsing `\n\n\n` → `\n\n`),
   * causing the dedup check in TrainingDataLogger to fail.
   */
  private injectWorkflowMessage(state: TState, content: string, _silent?: boolean): void {
    const msgs = (state as any).messages;
    if (Array.isArray(msgs)) {
      msgs.push({ role: 'user', content: `[Workflow] ${ content }` });
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
      const sequence = Object.keys(playbook.nodeOutputs ?? {}).length;

      // Strip the full definition to avoid storing huge JSONB — keep only IDs and edges
      const slimPlaybook = {
        ...playbook,
        definition: {
          ...playbook.definition,
          // Keep nodes but strip execution state to save space
          nodes: playbook.definition.nodes.map(n => ({
            id:       n.id,
            type:     n.type,
            position: n.position,
            data:     { subtype: n.data.subtype, category: n.data.category, label: n.data.label, config: n.data.config },
          })),
        },
      };

      await WorkflowCheckpointModel.saveCheckpoint({
        executionId:   playbook.executionId,
        workflowId:    playbook.workflowId,
        workflowName:  playbook.definition.name,
        nodeId,
        nodeLabel,
        nodeSubtype,
        sequence,
        playbookState: slimPlaybook as any,
        nodeOutput,
      });
    } catch (err) {
      console.warn(`[Graph:Checkpoint] Failed to save checkpoint for "${ nodeLabel }":`, err);
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
    const nodeSummaries = Object.values(playbook.nodeOutputs ?? {}).map((output: PlaybookNodeOutput) => ({
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
      .map(n => `  • ${ n.label } (${ n.subtype }): ${ (n.result || '').substring(0, 200) }${ (n.result || '').length > 200 ? '...' : '' }`)
      .join('\n');

    const statusLabel = outcome === 'completed' ? 'completed successfully' : `failed: ${ error || 'unknown error' }`;
    const summaryMsg = `[Workflow Complete] The workflow "${ playbook.definition.name }" has ${ statusLabel }.\n\nNode results:\n${ nodeLines }\n\nYou are now free from the workflow. Continue the conversation naturally — you have full context of what was accomplished above. Respond to the user as needed.`;

    this.injectWorkflowMessage(state, summaryMsg);

    // Re-enter the agent loop so the agent can process the completion and continue naturally
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
  ): Promise<{ output: unknown; threadId?: string; contractStatus: 'done' | 'blocked' | 'no_contract' }> {
    // Handle integration-call nodes
    if (agentId === '__integration_call__') {
      const result = await this.executeToolCall(config);
      return { ...result, contractStatus: 'done' };
    }

    const { GraphRegistry } = await import('../services/GraphRegistry');

    const threadId = `workflow-playbook-${ nodeId }-${ Date.now() }`;
    const agentConfigChannel = agentId || threadId;

    const { graph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(agentConfigChannel, threadId) as {
      graph: any;
      state: any;
    };

    // Inject prompt
    subState.messages.push({ role: 'user', content: prompt });

    // Training data: start sub-agent session
    const trainingLogger = getTrainingDataLogger();
    trainingLogger.startSession(threadId, { agentId: agentConfigChannel });

    // Mark as sub-agent so blocked status doesn't trigger waitingForUser
    subState.metadata.isSubAgent = true;

    // Tag sub-agent with workflow nodeId so BaseNode.wsChatMessage can emit
    // node_thinking events back to the workflow canvas.
    const parentChannel = (_state as any).metadata?.wsChannel || 'workbench';
    subState.metadata.workflowNodeId = nodeId;
    subState.metadata.workflowParentChannel = parentChannel;

    // Execute sub-agent graph
    const finalState = await graph.execute(subState);

    // Training data: embed sub-agent conversation into parent
    const parentConvId = (_state as any).metadata?.conversationId;
    if (parentConvId && trainingLogger.hasSession(parentConvId)) {
      const subNodeLabel = config.agentName as string || agentId || nodeId;
      trainingLogger.embedSubAgentConversation(parentConvId, threadId, subNodeLabel);
    }

    // Determine contract status from the sub-agent's final state
    const agentMeta = (finalState.metadata)?.agent || {};
    const agentStatus = String(agentMeta.status || '').toLowerCase();

    if (agentStatus === 'blocked') {
      const blockerReason = agentMeta.blocker_reason || 'Unknown blocker';
      const unblockReqs = agentMeta.unblock_requirements || '';
      return {
        output: `[BLOCKED] ${ blockerReason }${ unblockReqs ? ` | Requirements: ${ unblockReqs }` : '' }`,
        threadId,
        contractStatus: 'blocked',
      };
    }

    if (agentStatus === 'done') {
      const output = finalState.metadata?.finalSummary ||
        finalState.messages?.[finalState.messages.length - 1]?.content ||
        '';
      return { output, threadId, contractStatus: 'done' };
    }

    // Graph returned without a completion contract (AGENT_DONE/AGENT_BLOCKED).
    // The sub-graph likely died mid-execution (LLM timeout, crash, etc.)
    const partialOutput = finalState.metadata?.finalSummary ||
      finalState.messages?.[finalState.messages.length - 1]?.content ||
      '';
    console.warn(`[Graph:executeSubAgent] Sub-graph "${ agentId }" returned without contract. agentStatus="${ agentStatus }", messages=${ finalState.messages?.length ?? 0 }, threadId=${ threadId }`);

    return { output: partialOutput, threadId, contractStatus: 'no_contract' };
  }

  /**
   * Fire-and-forget sub-agent execution with retry logic.
   * Runs in the background; pushes results to pendingCompletions/pendingFailures
   * and emits WebSocket events so the UI updates in real time.
   */
  private executeSubAgentWithRetry(
    state: TState,
    nodeId: string,
    agentId: string,
    prompt: string,
    config: Record<string, unknown>,
    nodeLabel: string,
    maxRetries: number,
  ): void {
    const attempt = async(attemptNum: number): Promise<void> => {
      try {
        console.log(`[Graph:Playbook] Sub-agent "${ nodeLabel }" attempt ${ attemptNum }/${ maxRetries }`);
        const result = await this.executeSubAgent(state, nodeId, agentId, prompt, config);
        const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

        if (result.contractStatus === 'blocked') {
          // The sub-agent is asking a question — escalate to the orchestrator first,
          // and only to the user if the orchestrator can't answer.
          console.log(`[Graph:Playbook] Sub-agent "${ nodeLabel }" blocked — escalating (orchestrator will attempt to answer first)`);
          this.pendingSubAgents.delete(nodeId);
          this.pendingEscalations.push({
            nodeId,
            nodeLabel,
            agentId,
            prompt,
            config,
            question: resultText,
            threadId: result.threadId,
          });

          // Persist escalation to DB so it survives Graph restart
          const escExecId = (state as any).metadata?.activeWorkflow?.executionId;
          if (escExecId) {
            import('../database/models/WorkflowPendingCompletionModel').then(({ WorkflowPendingCompletionModel }) => {
              WorkflowPendingCompletionModel.saveEscalation({ executionId: escExecId, nodeId, nodeLabel, agentId, prompt, config, question: resultText, threadId: result.threadId })
                .catch(e => console.warn('[Graph:Playbook] Failed to persist escalation to DB:', e));
            }).catch(() => { /* best-effort */ });
          }

          // Emit event so the UI bubble updates to show "waiting for answer"
          try {
            const ws = getWebSocketClientService();
            const channel = (state as any).metadata?.wsChannel || 'workbench';
            ws.send(channel, {
              type:      'workflow_execution_event',
              data:      {
                type:      'sub_agent_blocked',
                nodeId,
                nodeLabel,
                question:  resultText.slice(0, 500),
                timestamp: new Date().toISOString(),
              },
              timestamp: Date.now(),
            });
          } catch { /* best-effort */ }

          this.triggerPlaybookContinuation(state);
          return;
        }

        if (result.contractStatus === 'no_contract' && attemptNum < maxRetries) {
          console.warn(`[Graph:Playbook] Sub-agent "${ nodeLabel }" returned without contract (attempt ${ attemptNum }), retrying...`);
          this.emitPlaybookEvent(state, 'node_retrying', { nodeId, nodeLabel, attempt: attemptNum, reason: 'no_contract' });
          return attempt(attemptNum + 1);
        }

        // Success or final attempt — push to completions queue
        if (result.contractStatus === 'done' || attemptNum >= maxRetries) {
          this.pendingCompletions.push({ nodeId, nodeLabel, output: result.output, threadId: result.threadId });

          // Persist to DB so completion survives Graph restart
          const execId = (state as any).metadata?.activeWorkflow?.executionId;
          if (execId) {
            import('../database/models/WorkflowPendingCompletionModel').then(({ WorkflowPendingCompletionModel }) => {
              WorkflowPendingCompletionModel.saveCompletion({ executionId: execId, nodeId, nodeLabel, output: result.output, threadId: result.threadId })
                .catch(e => console.warn('[Graph:Playbook] Failed to persist completion to DB:', e));
            }).catch(() => { /* best-effort */ });
          }

          // Emit sub_agent_completed event to the parent channel for UI update
          try {
            const ws = getWebSocketClientService();
            const channel = (state as any).metadata?.wsChannel || 'workbench';
            ws.send(channel, {
              type: 'workflow_execution_event',
              data: {
                type:      'sub_agent_completed',
                nodeId,
                nodeLabel,
                output:    resultText.slice(0, 500),
                threadId:  result.threadId,
                timestamp: new Date().toISOString(),
              },
              timestamp: Date.now(),
            });
          } catch { /* best-effort */ }

          // Trigger DAG continuation
          this.triggerPlaybookContinuation(state);
        }
      } catch (err: any) {
        const errorMsg = err.message || String(err);
        console.error(`[Graph:Playbook] Sub-agent "${ nodeLabel }" threw (attempt ${ attemptNum }/${ maxRetries }):`, errorMsg);

        if (attemptNum < maxRetries) {
          this.emitPlaybookEvent(state, 'node_retrying', { nodeId, nodeLabel, attempt: attemptNum, reason: 'exception', error: errorMsg });
          return attempt(attemptNum + 1);
        }

        // All retries exhausted — push failure
        this.pendingFailures.push({ nodeId, nodeLabel, error: errorMsg });

        // Persist failure to DB so it survives Graph restart
        const failExecId = (state as any).metadata?.activeWorkflow?.executionId;
        if (failExecId) {
          import('../database/models/WorkflowPendingCompletionModel').then(({ WorkflowPendingCompletionModel }) => {
            WorkflowPendingCompletionModel.saveFailure({ executionId: failExecId, nodeId, nodeLabel, error: errorMsg })
              .catch(e => console.warn('[Graph:Playbook] Failed to persist failure to DB:', e));
          }).catch(() => { /* best-effort */ });
        }

        // Emit sub_agent_failed event
        try {
          const ws = getWebSocketClientService();
          const channel = (state as any).metadata?.wsChannel || 'workbench';
          ws.send(channel, {
            type: 'workflow_execution_event',
            data: {
              type:      'sub_agent_failed',
              nodeId,
              nodeLabel,
              error:     errorMsg,
              timestamp: new Date().toISOString(),
            },
            timestamp: Date.now(),
          });
        } catch { /* best-effort */ }

        // Trigger DAG continuation (to drain the failure)
        this.triggerPlaybookContinuation(state);
      }
    };

    // Fire without awaiting
    attempt(1).catch(err => {
      console.error(`[Graph:Playbook] executeSubAgentWithRetry unhandled error:`, err);
    });
  }

  /**
   * Trigger a deferred processWorkflowPlaybook call after a sub-agent completes.
   * Guards against concurrent execution with isProcessingPlaybook flag.
   *
   * If the playbook is already processing, queues a re-trigger flag so the
   * finally block will re-process (fixes P1 #4).
   *
   * If the graph is idle (waitingForUser), sends a synthetic WS message to
   * wake the orchestrator so it picks up the completion (fixes P0 #2).
   */
  private _continuationQueued = false;

  private triggerPlaybookContinuation(state: TState): void {
    if (this.isProcessingPlaybook) {
      // Queue a re-trigger — processWorkflowPlaybook's finally block will check this
      this._continuationQueued = true;
      console.log('[Graph:Playbook] Playbook already processing, queued continuation for after unlock');
      return;
    }

    // If the graph is idle/waitingForUser, the stale state reference won't help.
    // Send a synthetic WS message to wake the orchestrator through the normal path.
    const meta = (state as any).metadata;
    if (meta?.waitingForUser || meta?.cycleComplete) {
      const channel = meta?.wsChannel;
      const threadId = meta?.threadId;
      if (channel && threadId) {
        console.log(`[Graph:Playbook] Graph is idle — sending WS wake-up on channel "${ channel }"`);
        try {
          const ws = getWebSocketClientService();
          ws.send(channel, {
            type: 'user_message',
            data: {
              content:  '[Workflow continuation: sub-agent completed]',
              threadId,
              metadata: { origin: 'workflow_continuation' },
            },
            timestamp: Date.now(),
          });
        } catch (err) {
          console.warn('[Graph:Playbook] Failed to send WS wake-up:', err);
        }
        return;
      }
    }

    setImmediate(async() => {
      if (this.isProcessingPlaybook) {
        this._continuationQueued = true;
        return;
      }
      try {
        console.log('[Graph:Playbook] Triggering playbook continuation after sub-agent completion');
        await this.processWorkflowPlaybook(state);
      } catch (err) {
        console.error('[Graph:Playbook] Post-completion playbook processing failed:', err);
      }
    });
  }

  /**
   * Execute an integration call (integration API) for a workflow integration-call node.
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
      return { output: { error: `Integration "${ integrationSlug }" not found` } };
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
    switch (decision.type) {
    case 'end': return 'end';
    case 'goto':
      if (this.nodes.has(decision.nodeId)) return decision.nodeId;
      console.warn(`[Graph] Invalid goto: ${ decision.nodeId }`);
      return 'end';
    case 'continue': return current;
    case 'revise':
      return this.getReviserFor(current) || 'end';
    case 'next':
      const edges = this.edges.get(current) || [];
      for (const edge of edges) {
        if (typeof edge.to === 'function') {
          const nextId = edge.to(state);
          if (nextId && this.nodes.has(nextId)) return nextId;
        } else if (this.nodes.has(edge.to)) {
          return edge.to;
        }
      }
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
  overrides: Partial<T['metadata']> = {},
): Promise<T> {
  const now = Date.now();
  const msgId = nextMessageId();

  const mode = await SullaSettingsModel.get('modelMode', 'local');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';

  const baseMetadata: BaseThreadState['metadata'] = {
    action:               'direct_answer',  // Default action for initial state
    threadId:             overrides.threadId ?? nextThreadId(),
    wsChannel:            overrides.wsChannel ?? DEFAULT_WS_CHANNEL,
    llmModel,
    llmLocal,
    cycleComplete:        false,
    waitingForUser:       false,
    isSubAgent:           overrides.isSubAgent ?? false,
    subAgentDepth:        overrides.subAgentDepth ?? 0,
    options:              overrides.options ?? { abort: undefined },
    currentNodeId:        overrides.currentNodeId ?? 'input_handler',
    consecutiveSameNode:  0,
    iterations:           0,
    revisionCount:        0,
    maxIterationsReached: false,
    memory:               overrides.memory ?? {
      knowledgeBaseContext: '',
      chatSummariesContext: '',
    },
    subGraph: {
      state:    'completed',
      name:     'hierarchical',
      prompt:   '',
      response: '',
    },
    finalSummary:         '',
    totalSummary:         '',
    finalState:           'running',
    n8nLiveEventsEnabled: false,
    returnTo:             null,
  };

  const result = {
    messages: [{
      id:        msgId,
      role:      'user',
      content:   prompt.trim(),
      timestamp: now,
      metadata:  {
        type:   'initial_prompt',
        source: 'user',
      },
    }],
    metadata: {
      ...baseMetadata,
      ...overrides,
    },
  };

  return result as unknown as T;
}

let messageCounter = 0;
let threadCounter = 0;

export function nextMessageId(): string {
  return `msg_${ Date.now() }_${ ++messageCounter }`;
}

export function nextThreadId(): string {
  return `thread_${ Date.now() }_${ ++threadCounter }`;
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
      console.log(`[HeartbeatGraph] Max heartbeat cycles (${ maxCycles }) reached — ending`);
      return 'end';
    }

    console.log(`[HeartbeatGraph] Cycle ${ cycleCount }/${ maxCycles } — continuing`);
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

    if (agentStatus === 'done') {
      console.log('[AgentGraph] Agent reported DONE - ending');
      return 'end';
    }

    if (agentStatus === 'blocked') {
      console.log('[AgentGraph] Agent reported BLOCKED - ending');
      return 'end';
    }

    // If the agent executed tool calls this cycle but didn't emit an explicit
    // wrapper (status is 'in_progress'), the LLM expects to see tool results
    // and continue — treat it as an implicit CONTINUE.
    if (agentStatus === 'in_progress' && state.metadata.hadToolCalls) {
      const currentLoopCount = (state.metadata as any).agentLoopCount || 0;
      const newLoopCount = currentLoopCount + 1;
      (state.metadata as any).agentLoopCount = newLoopCount;
      console.log(`[AgentGraph] Agent made tool calls without wrapper — implicit continue (cycle ${ newLoopCount })`);
      return 'agent';
    }

    // Default to DONE: only an explicit <AGENT_CONTINUE> keeps the loop going.
    // This matches LangGraph / OpenAI Assistants behaviour — the turn is over
    // unless the agent explicitly signals it wants to continue.
    if (agentStatus !== 'continue') {
      console.log(`[AgentGraph] Agent status '${ agentStatus || 'unknown' }' is not CONTINUE — defaulting to DONE`);
      (state.metadata as any).agent.status = 'done';
      state.metadata.cycleComplete = true;
      return 'end';
    }

    // Track loop count for diagnostics
    const currentLoopCount = (state.metadata as any).agentLoopCount || 0;
    const newLoopCount = currentLoopCount + 1;
    (state.metadata as any).agentLoopCount = newLoopCount;

    console.log(`[AgentGraph] Agent cycle ${ newLoopCount } - continuing`);
    return 'agent';
  });

  graph.setEntryPoint('input_handler');
  graph.setEndPoints('agent');

  return graph;
}
