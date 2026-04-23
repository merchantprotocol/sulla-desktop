// Graph - Generic DAG executor for agent graphs.
// Playbook/workflow orchestration is in controllers/PlaybookController.ts.

import { AgentNode } from './AgentNode';
import { HeartbeatNode } from './HeartbeatNode';
import { InputHandlerNode } from './InputHandlerNode';
import { SubconsciousAgentNode } from './SubconsciousAgentNode';
import { PlaybookController } from '../controllers/PlaybookController';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { throwIfAborted } from '../services/AbortService';
import { getConversationLogger } from '../services/ConversationLogger';
import { getWebSocketClientService } from '../services/WebSocketClientService';

import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import type { AbortService } from '../services/AbortService';
import type { WorkflowPlaybookState } from '../workflow/types';

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

const DEFAULT_WS_CHANNEL = 'heartbeat';
const MAX_CONSECTUIVE_LOOP = 40;

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

  // Tools found dynamically (accumulates across multiple calls)
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

    /** Wall-clock timestamp (ms) of the most recent real signal from the
     *  agent — an LLM token, a tool call dispatch/return, or a thinking
     *  event. Read by PlaybookController's sub-agent inactivity watchdog
     *  to decide whether to bump an idle agent with a user nudge. */
    lastActivityMs?: number;

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
    workflowStack?: { playbook: WorkflowPlaybookState; nodeId: string }[];
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
      excludeSoul?:  boolean;         // if true, skip the global soul prompt from settings

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

// Back-compat aliases — heartbeat now uses AgentGraphState
export type HeartbeatThreadState = AgentGraphState;
export type OverlordThreadState = AgentGraphState;

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

  // ── Playbook orchestration (delegated to PlaybookController) ──
  private playbookController = new PlaybookController<TState>(this);

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
   * Get the entry point node ID. Used by PlaybookController for agent loop re-entry.
   */
  getEntryPoint(): string | null {
    return this.entryPoint;
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

    // On playbook reentry, reset cycle flags so the agent loop can run
    // multiple turns (e.g. file_search → exec → final answer) instead of
    // exiting immediately because cycleComplete was set from a prior cycle.
    if (isReentry) {
      const prevCycle = (state as any).metadata.cycleComplete;
      const prevWaiting = (state as any).metadata.waitingForUser;
      (state as any).metadata.cycleComplete = false;
      (state as any).metadata.waitingForUser = false;
      console.log(`[Graph] execute_reentry_reset: prevCycleComplete=${ prevCycle }, prevWaitingForUser=${ prevWaiting }, currentNodeId=${ (state as any).metadata.currentNodeId }`);
    }
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

        if ((state as any).metadata.cycleComplete) {
          // Debug: cycle complete break
          break;
        }

        if ((state as any).metadata.waitingForUser && (state as any).metadata.currentNodeId === 'input_handler') {
          // Debug: waiting for user break
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
          const hasActiveWorkflow = !!(state as any).metadata?.activeWorkflow?.status &&
            (state as any).metadata.activeWorkflow.status === 'running';
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
        }
      } else {
        if (convId) {
          getConversationLogger().logGraphCompleted(convId, 'failed', { error: error?.message || String(error) });
        }
        // Re-throw non-abort errors
        throw error;
      }
    }

    const hasActiveWorkflowPostLoop = !!(state as any).metadata?.activeWorkflow?.status &&
      (state as any).metadata.activeWorkflow.status === 'running';
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
      state = await this.playbookController.processWorkflowPlaybook(state);
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

  // ── Playbook methods have been extracted to PlaybookController ──

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
export function createHeartbeatGraph(): Graph<AgentGraphState> {
  const graph = new Graph<AgentGraphState>();

  graph.addNode(new InputHandlerNode<AgentGraphState>());
  graph.addNode(new HeartbeatNode());

  // InputHandler cleans up the initial prompt message, then → heartbeat
  graph.addEdge('input_handler', 'heartbeat');

  // Heartbeat conditional edge: mirrors AgentGraph routing via agent.status
  graph.addConditionalEdge('heartbeat', state => {
    const agentMeta = (state.metadata as any).agent || {};
    const agentStatus = String(agentMeta.status || '').trim().toLowerCase();

    if (agentStatus === 'done') {
      console.log('[HeartbeatGraph] Agent reported DONE — ending');
      return 'end';
    }

    if (agentStatus === 'blocked') {
      console.log('[HeartbeatGraph] Agent reported BLOCKED — ending');
      return 'end';
    }

    // Implicit continue for tool calls without wrapper
    if (agentStatus === 'in_progress' && (state.metadata as any).hadToolCalls) {
      const newLoopCount = ((state.metadata as any).agentLoopCount || 0) + 1;
      (state.metadata as any).agentLoopCount = newLoopCount;
      // Consume the flag — it describes "this cycle had tool calls". Once
      // we've used it to route the next step, clear it so a later cycle
      // that emits pure text (no wrapper, no tools) falls through to the
      // DONE path instead of looping forever on the stale signal. The
      // agent node resets this at the top of each LLM turn anyway, but
      // the assistant-already-responded short-circuit in normalizedChat
      // bypasses that reset — leading to a 4ms-per-cycle runaway where
      // the LLM never fires.
      state.metadata.hadToolCalls = false;
      console.log(`[HeartbeatGraph] Tool calls without wrapper — implicit continue (cycle ${ newLoopCount })`);
      return 'heartbeat';
    }

    // Explicit CONTINUE keeps the loop going
    if (agentStatus === 'continue') {
      const newLoopCount = ((state.metadata as any).agentLoopCount || 0) + 1;
      (state.metadata as any).agentLoopCount = newLoopCount;
      console.log(`[HeartbeatGraph] Cycle ${ newLoopCount } — continuing`);
      return 'heartbeat';
    }

    // Unknown status — default to done
    console.log(`[HeartbeatGraph] Status '${ agentStatus || 'unknown' }' — defaulting to DONE`);
    (state.metadata as any).agent = { ...(state.metadata as any).agent, status: 'done' };
    state.metadata.cycleComplete = true;
    return 'end';
  });

  graph.setEntryPoint('input_handler');
  graph.setEndPoints('heartbeat');

  return graph;
}

// Back-compat alias
export function createOverlordGraph(): Graph<AgentGraphState> {
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
    // BUT: during a playbook reentry (_isPlaybookReentry), the workflow is
    // already running and we're executing on behalf of the walker. In that
    // case, DON'T bail — let the agent finish its multi-turn tool chain
    // (e.g. file_search → exec → text answer) before returning control.
    const isPlaybookReentry = !!(state.metadata as any)._isPlaybookReentry;
    if ((state.metadata as any).activeWorkflow?.status === 'running' && !isPlaybookReentry) {
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
      // Consume the flag so this decision is not sticky. normalizedChat
      // resets hadToolCalls at the top of each LLM turn, but its
      // last-message-is-assistant short-circuit returns BEFORE that reset
      // — leaving the flag stuck true and looping this branch forever
      // with no LLM activity (observed at ~4ms per cycle, thousands of
      // iterations). If the next cycle really does run tools, ToolExecutor
      // sets the flag back to true at the top of executeToolCalls.
      state.metadata.hadToolCalls = false;
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

/**
 * Subconscious Graph — minimal multi-turn tool-calling loop.
 *
 * Single node (SubconsciousAgentNode), no InputHandler.
 * Loops on tool calls or explicit AGENT_CONTINUE, exits on AGENT_DONE
 * or when the LLM stops calling tools.
 */
export function createSubconsciousGraph(): Graph<BaseThreadState> {
  const graph = new Graph<BaseThreadState>();

  graph.addNode(new SubconsciousAgentNode());  // id: 'subconscious'

  graph.addConditionalEdge('subconscious', (state) => {
    const agentMeta = (state.metadata as any).agent || {};
    const agentStatus = String(agentMeta.status || '').trim().toLowerCase();

    if (agentStatus === 'done') return 'end';
    if (agentStatus === 'continue') return 'subconscious';
    if (agentStatus === 'in_progress' && state.metadata.hadToolCalls) {
      // Consume — see AgentGraph branch above for rationale.
      state.metadata.hadToolCalls = false;
      return 'subconscious';
    }

    // Default: done
    return 'end';
  });

  graph.setEntryPoint('subconscious');
  graph.setEndPoints('subconscious');

  return graph;
}
