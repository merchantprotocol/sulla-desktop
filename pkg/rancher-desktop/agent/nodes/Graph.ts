// Graph - LangGraph-style workflow orchestrator
// sits on the backend and processes the graphs

import type { AbortService } from '../services/AbortService';
import { throwIfAborted } from '../services/AbortService';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { InputHandlerNode } from './InputHandlerNode';
import { AgentNode } from './AgentNode';
import { HeartbeatNode, type HeartbeatThreadState } from './HeartbeatNode';

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================

const DEFAULT_WS_CHANNEL = 'dreaming-protocol';
const MAX_CONSECTUIVE_LOOP = 40;
const MAX_MESSAGES_IN_THREAD = 120;

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
  };
}

/**
 * AgentGraph-specific thread state interface
 * Minimal state for the independent agent graph (InputHandler → Agent loop)
 */
export interface AgentGraphState extends BaseThreadState {
  metadata: BaseThreadState['metadata'] & {
    agent?: {
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
    options?: { maxIterations: number }
  ): Promise<TState> {
    if (!this.entryPoint) throw new Error('No entry point');

    await this.initialize();

    let state = initialState;
    (state as any).metadata.currentNodeId = entryPointNodeId || this.entryPoint;

    console.log(`[Graph] Start from ${(state as any).metadata.currentNodeId}`);

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
      // Don't re-throw AbortError, just log and continue to send completion signal
      if (error?.name === 'AbortError') {
        console.log('[Graph] Graph execution aborted by user');
      } else {
        // Re-throw non-abort errors
        throw error;
      }
    }

    if ((state as any).metadata.iterations >= maxIterations) {
      console.warn('Max iterations hit');
      (state as any).metadata.maxIterationsReached = true;
      (state as any).metadata.stopReason = 'max_loops';
    }

    // Always send completion signal, whether completed naturally or aborted
    const stopReason = (state as any).metadata.stopReason || null;
    console.log('[Graph] Sending graph_execution_complete signal, stopReason:', stopReason);
    const ws = getWebSocketClientService();
    const connId = (state as any).metadata.wsChannel || 'dreaming-protocol';
    ws.send(connId, {
      type: 'transfer_data',
      data: { role: 'system', content: 'graph_execution_complete', stopReason },
    });
    // Clear stopReason after sending
    (state as any).metadata.stopReason = null;

    return state;
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
 * and by BackendGraphWebSocketService for the dreaming-protocol channel.
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

