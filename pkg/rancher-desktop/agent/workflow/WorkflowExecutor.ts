/**
 * WorkflowExecutor — DAG-based execution engine for visual workflows.
 *
 * Builds an adjacency graph from the workflow definition, resolves a
 * topological execution order, and runs nodes concurrently where the
 * graph allows. Reports status to the UI via a callback.
 */

import type {
  WorkflowDefinition,
  WorkflowNodeSerialized,
  WorkflowEdgeSerialized,
} from '@pkg/pages/editor/workflow/types';

import type {
  WorkflowExecutionContext,
  WorkflowExecutionEvent,
  WorkflowNodeExecutionState,
  WorkflowRunState,
  WorkflowRunStatus,
  NodeOutput,
  NodeHandlerResult,
} from './types';

import { getNodeHandler } from './nodeHandlers';
import { getConversationLogger } from '@pkg/agent/services/ConversationLogger';

// ── Helpers ──

function generateId(): string {
  return `wfx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ── Options ──

export interface WorkflowExecutorOptions {
  parentExecutionId?: string;
  abortSignal?: AbortSignal;
  emitEvent?: (event: Omit<WorkflowExecutionEvent, 'executionId' | 'workflowId' | 'timestamp'>) => void;
  maxSubWorkflowDepth?: number;
  /** The originating WebSocket channel so agent nodes route responses back correctly */
  originChannel?: string;
}

// ── Executor ──

export class WorkflowExecutor {
  private readonly definition: WorkflowDefinition;
  private readonly triggerPayload: unknown;
  private readonly options: WorkflowExecutorOptions;

  private readonly executionId: string;
  private readonly abortController: AbortController;
  private readonly abortSignal: AbortSignal;

  // Adjacency
  private readonly forwardEdges = new Map<string, WorkflowEdgeSerialized[]>();
  private readonly reverseEdges = new Map<string, WorkflowEdgeSerialized[]>();
  private readonly nodeMap = new Map<string, WorkflowNodeSerialized>();

  // Runtime
  private readonly nodeStates = new Map<string, WorkflowNodeExecutionState>();
  private readonly nodePromises = new Map<string, Promise<void>>();
  private readonly nodeResolvers = new Map<string, Array<() => void>>();
  private readonly context: WorkflowExecutionContext;

  // Pause/resume for user-input nodes
  private readonly waitingResolvers = new Map<string, (value: unknown) => void>();

  constructor(
    definition: WorkflowDefinition,
    triggerPayload: unknown,
    options: WorkflowExecutorOptions = {},
  ) {
    this.definition = definition;
    this.triggerPayload = triggerPayload;
    this.options = options;
    this.executionId = options.parentExecutionId
      ? `${options.parentExecutionId}-sub-${generateId()}`
      : generateId();

    // Abort chain: if parent provides a signal, link to it
    this.abortController = new AbortController();
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => this.abortController.abort(), { once: true });
    }
    this.abortSignal = this.abortController.signal;

    // Build context
    this.context = {
      executionId:    this.executionId,
      triggerPayload,
      nodeOutputs:    new Map(),
      variables:      {},
      originChannel:  options.originChannel,
    };

    // Build adjacency maps
    this.buildGraph();
  }

  // ── Public API ──

  get id(): string {
    return this.executionId;
  }

  async execute(): Promise<WorkflowRunState> {
    console.log(`[WorkflowExecutor] execute() — workflow="${this.definition.name}" (${this.definition.id}), executionId=${this.executionId}, originChannel="${this.context.originChannel || '(none)'}", triggerPayload="${String(this.triggerPayload).slice(0, 80)}"`);
    this.emitEvent({ type: 'workflow_started' });

    const convLogger = getConversationLogger();
    convLogger.logWorkflowStarted(this.executionId, this.definition.name, this.definition.id, {
      channel:  this.context.originChannel,
      parentId: this.options.parentExecutionId,
    });

    const startedAt = now();
    let status: WorkflowRunStatus = 'running';
    let error: string | undefined;

    try {
      // Find trigger nodes (entry points)
      const triggerNodes = this.definition.nodes.filter(n => n.data.category === 'trigger');
      console.log(`[WorkflowExecutor] Found ${triggerNodes.length} trigger node(s): ${triggerNodes.map(n => `${n.id}(${n.data.subtype})`).join(', ')}`);
      if (triggerNodes.length === 0) {
        throw new Error('Workflow has no trigger nodes');
      }

      // Initialize all node states as pending
      for (const node of this.definition.nodes) {
        this.nodeStates.set(node.id, { status: 'pending' });
      }

      // Start execution from trigger nodes
      const triggerPromises = triggerNodes.map(n => this.executeNode(n.id));
      await Promise.all(triggerPromises);

      // Wait for all launched nodes to complete
      await Promise.all(Array.from(this.nodePromises.values()));

      status = 'completed';
      this.emitEvent({ type: 'workflow_completed' });
    } catch (err: any) {
      if (this.abortSignal.aborted) {
        status = 'aborted';
        this.emitEvent({ type: 'workflow_aborted' });
      } else {
        status = 'failed';
        error = err.message || String(err);
        this.emitEvent({ type: 'workflow_failed', error });
      }
    }

    convLogger.logWorkflowCompleted(this.executionId, status, error);

    return {
      executionId: this.executionId,
      workflowId:  this.definition.id,
      status,
      nodeStates:  this.nodeStates,
      context:     this.context,
      startedAt,
      completedAt: now(),
      error,
    };
  }

  abort(): void {
    this.abortController.abort();
  }

  /**
   * Resume a paused user-input node with the user's response.
   */
  resume(nodeId: string, userData: unknown): void {
    const resolver = this.waitingResolvers.get(nodeId);
    if (resolver) {
      resolver(userData);
      this.waitingResolvers.delete(nodeId);
    }
  }

  // ── Graph construction ──

  private buildGraph(): void {
    for (const node of this.definition.nodes) {
      this.nodeMap.set(node.id, node);
      this.forwardEdges.set(node.id, []);
      this.reverseEdges.set(node.id, []);
    }

    for (const edge of this.definition.edges) {
      this.forwardEdges.get(edge.source)?.push(edge);
      this.reverseEdges.get(edge.target)?.push(edge);
    }
  }

  // ── Node execution ──

  private async executeNode(nodeId: string): Promise<void> {
    // Prevent duplicate execution
    if (this.nodePromises.has(nodeId)) {
      return this.nodePromises.get(nodeId);
    }

    const promise = this.doExecuteNode(nodeId);
    this.nodePromises.set(nodeId, promise);
    return promise;
  }

  private async doExecuteNode(nodeId: string): Promise<void> {
    if (this.abortSignal.aborted) return;

    const node = this.nodeMap.get(nodeId);
    if (!node) return;

    const nodeData = node.data;
    const incomingEdges = this.reverseEdges.get(nodeId) || [];

    console.log(`[WorkflowExecutor] doExecuteNode "${nodeData.label}" (${nodeId}) — subtype="${nodeData.subtype}", category="${nodeData.category}", upstream=${incomingEdges.length}, config=${JSON.stringify(nodeData.config || {}).slice(0, 200)}`);

    // Wait for all upstream dependencies to complete
    await this.waitForUpstream(nodeId, incomingEdges);

    if (this.abortSignal.aborted) return;

    // Check if any upstream node failed — skip this node if so
    // (Exception: merge nodes with 'first' strategy can proceed with partial results)
    const isMergeFirst = nodeData.subtype === 'merge' && nodeData.config?.strategy === 'first';
    if (!isMergeFirst) {
      for (const edge of incomingEdges) {
        const upstreamState = this.nodeStates.get(edge.source);
        if (upstreamState?.status === 'failed') {
          this.setNodeState(nodeId, { status: 'skipped' });
          this.emitEvent({
            type:      'node_skipped',
            nodeId,
            nodeLabel: nodeData.label,
            status:    'skipped',
          });
          return;
        }
      }
    }

    // Gather upstream outputs
    const upstreamOutputs: NodeOutput[] = [];
    for (const edge of incomingEdges) {
      const output = this.context.nodeOutputs.get(edge.source);
      if (output) upstreamOutputs.push(output);
    }

    // Get the handler
    const handler = getNodeHandler(nodeData.subtype);
    if (!handler) {
      this.setNodeState(nodeId, {
        status: 'failed',
        error:  `No handler for node subtype: ${nodeData.subtype}`,
      });
      this.emitEvent({
        type:      'node_failed',
        nodeId,
        nodeLabel: nodeData.label,
        status:    'failed',
        error:     `No handler for node subtype: ${nodeData.subtype}`,
      });
      return;
    }

    // Mark running
    const startedAt = now();
    this.setNodeState(nodeId, { status: 'running', startedAt });
    this.emitEvent({
      type:      'node_started',
      nodeId,
      nodeLabel: nodeData.label,
      status:    'running',
    });
    getConversationLogger().logNodeEvent(this.executionId, 'node_started', nodeId, nodeData.label, { subtype: nodeData.subtype, category: nodeData.category });

    try {
      // Execute the handler
      let result: NodeHandlerResult = await handler({
        nodeId,
        label:           nodeData.label,
        subtype:         nodeData.subtype,
        category:        nodeData.category,
        config:          nodeData.config,
        context:         this.context,
        abortSignal:     this.abortSignal,
        emitEvent:       this.emitEvent.bind(this),
        upstreamOutputs,
      });

      // Handle user-input pause
      if (result.result && typeof result.result === 'object' && (result.result as any).__waiting) {
        this.setNodeState(nodeId, { status: 'waiting', startedAt });

        const userData = await new Promise<unknown>((resolve) => {
          this.waitingResolvers.set(nodeId, resolve);
        });

        result = { result: userData };
      }

      // Store output in context
      const completedAt = now();
      const nodeOutput: NodeOutput = {
        nodeId,
        label:       nodeData.label,
        subtype:     nodeData.subtype,
        category:    nodeData.category,
        threadId:    result.threadId,
        result:      result.result,
        completedAt,
      };
      this.context.nodeOutputs.set(nodeId, nodeOutput);

      // Mark completed
      this.setNodeState(nodeId, {
        status: 'completed',
        startedAt,
        completedAt,
        threadId: result.threadId,
        output:   result.result,
      });
      this.emitEvent({
        type:      'node_completed',
        nodeId,
        nodeLabel: nodeData.label,
        status:    'completed',
        threadId:  result.threadId,
        output:    this.truncateOutput(result.result),
      });
      getConversationLogger().logNodeEvent(this.executionId, 'node_completed', nodeId, nodeData.label, { threadId: result.threadId, output: this.truncateOutput(result.result) });

      // Follow outgoing edges
      await this.followEdges(nodeId, result.selectedHandle);

    } catch (err: any) {
      if (this.abortSignal.aborted) return;

      const completedAt = now();
      this.setNodeState(nodeId, {
        status: 'failed',
        startedAt,
        completedAt,
        error: err.message || String(err),
      });
      this.emitEvent({
        type:      'node_failed',
        nodeId,
        nodeLabel: nodeData.label,
        status:    'failed',
        error:     err.message || String(err),
      });
      getConversationLogger().logNodeEvent(this.executionId, 'node_failed', nodeId, nodeData.label, { error: err.message || String(err) });
    }
  }

  // ── Edge following ──

  /**
   * After a node completes, launch execution of all downstream nodes.
   * If selectedHandle is provided (router/condition), only follow edges
   * matching that sourceHandle.
   */
  private async followEdges(nodeId: string, selectedHandle?: string): Promise<void> {
    const outgoing = this.forwardEdges.get(nodeId) || [];
    if (outgoing.length === 0) return;

    let edgesToFollow: WorkflowEdgeSerialized[];

    if (selectedHandle) {
      // Router/condition: only follow the matching handle
      edgesToFollow = outgoing.filter(e => e.sourceHandle === selectedHandle);
      // If no match, try the first edge as fallback
      if (edgesToFollow.length === 0) {
        edgesToFollow = [outgoing[0]];
      }
    } else {
      // Follow all outgoing edges (parallel fork)
      edgesToFollow = outgoing;
    }

    // Launch all downstream nodes concurrently
    const downstreamPromises = edgesToFollow.map(edge => this.executeNode(edge.target));
    await Promise.all(downstreamPromises);
  }

  // ── Upstream waiting ──

  /**
   * For a node to execute, all its upstream nodes must have completed.
   * For merge nodes with 'first' strategy, we race instead of waiting for all.
   */
  private async waitForUpstream(nodeId: string, incomingEdges: WorkflowEdgeSerialized[]): Promise<void> {
    if (incomingEdges.length === 0) return;

    const node = this.nodeMap.get(nodeId);
    const isMergeFirst = node?.data.subtype === 'merge' && node?.data.config?.strategy === 'first';

    const upstreamPromises = incomingEdges.map(edge => {
      const state = this.nodeStates.get(edge.source);
      // If upstream already finished, no need to wait
      if (state && (state.status === 'completed' || state.status === 'failed' || state.status === 'skipped')) {
        return Promise.resolve();
      }
      // Otherwise wait for the resolver to fire when upstream completes
      return new Promise<void>(resolve => {
        // Check again in case it completed between the check and now
        const current = this.nodeStates.get(edge.source);
        if (current && (current.status === 'completed' || current.status === 'failed' || current.status === 'skipped')) {
          resolve();
          return;
        }
        const existing = this.nodeResolvers.get(edge.source) || [];
        existing.push(resolve);
        this.nodeResolvers.set(edge.source, existing);
      });
    });

    if (isMergeFirst) {
      await Promise.race(upstreamPromises);
    } else {
      await Promise.all(upstreamPromises);
    }
  }

  // ── State management ──

  private setNodeState(nodeId: string, state: WorkflowNodeExecutionState): void {
    this.nodeStates.set(nodeId, state);

    // Resolve any nodes waiting on this one
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'skipped') {
      const resolvers = this.nodeResolvers.get(nodeId);
      if (resolvers) {
        for (const resolver of resolvers) {
          resolver();
        }
        this.nodeResolvers.delete(nodeId);
      }
    }
  }

  // ── Event emission ──

  private emitEvent(partial: Omit<WorkflowExecutionEvent, 'executionId' | 'workflowId' | 'timestamp'>): void {
    const event: WorkflowExecutionEvent = {
      ...partial,
      executionId: this.executionId,
      workflowId:  this.definition.id,
      timestamp:   now(),
    };

    this.options.emitEvent?.(partial);

    // Also log for debugging
    const tag = partial.nodeId ? ` [${partial.nodeLabel || partial.nodeId}]` : '';
    console.log(`[WorkflowExecutor] ${partial.type}${tag}`);
  }

  // ── Utilities ──

  private truncateOutput(output: unknown): unknown {
    if (typeof output === 'string' && output.length > 500) {
      return output.slice(0, 500) + '...';
    }
    return output;
  }
}
