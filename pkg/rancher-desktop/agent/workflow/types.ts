/**
 * Workflow execution types.
 * These are runtime-only types used by the WorkflowExecutor — they are NOT
 * persisted in the workflow JSON files (those live in pages/editor/workflow/types.ts).
 */

import type { WorkflowNodeSubtype, WorkflowNodeCategory } from '@pkg/pages/editor/workflow/types';

// ── Node execution status (pushed to UI via WebSocket) ──

export type WorkflowNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting';   // paused for user-input

export interface WorkflowNodeExecutionState {
  status: WorkflowNodeStatus;
  threadId?: string;       // agent conversation thread ID — reloadable
  output?: unknown;        // the data this node produced
  error?: string;          // populated when status === 'failed'
  startedAt?: string;
  completedAt?: string;
}

// ── Per-node output stored in the shared context ──

export interface NodeOutput {
  nodeId: string;
  label: string;
  subtype: WorkflowNodeSubtype;
  category: WorkflowNodeCategory;
  threadId?: string;
  result: unknown;
  completedAt: string;
}

// ── Shared execution context (flows through the DAG) ──

export interface WorkflowExecutionContext {
  /** Unique ID for this execution run */
  executionId: string;

  /** The payload that triggered the workflow (e.g. user message) */
  triggerPayload: unknown;

  /** Cumulative node outputs keyed by nodeId — any downstream node can read any upstream output */
  nodeOutputs: Map<string, NodeOutput>;

  /** Global variables any node can read/write */
  variables: Record<string, unknown>;

  /** The originating WebSocket channel (e.g. 'sulla-desktop') so agent nodes send responses back to the right place */
  originChannel?: string;
}

// ── Overall workflow run state ──

export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'waiting';

export interface WorkflowRunState {
  executionId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  nodeStates: Map<string, WorkflowNodeExecutionState>;
  context: WorkflowExecutionContext;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

// ── WebSocket events sent to the UI ──

export type WorkflowExecutionEventType =
  | 'workflow_started'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'workflow_aborted'
  | 'workflow_waiting'
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_skipped'
  | 'node_waiting';

export interface WorkflowExecutionEvent {
  type: WorkflowExecutionEventType;
  executionId: string;
  workflowId: string;
  nodeId?: string;
  nodeLabel?: string;
  status?: WorkflowNodeStatus;
  threadId?: string;
  output?: unknown;
  error?: string;
  timestamp: string;
}

// ── Node handler interface ──

export interface NodeHandlerArgs {
  nodeId: string;
  label: string;
  subtype: WorkflowNodeSubtype;
  category: WorkflowNodeCategory;
  config: Record<string, unknown>;
  context: WorkflowExecutionContext;
  abortSignal: AbortSignal;
  emitEvent: (event: Omit<WorkflowExecutionEvent, 'executionId' | 'workflowId' | 'timestamp'>) => void;
  /** Upstream node outputs that feed into this node (resolved from edges) */
  upstreamOutputs: NodeOutput[];
}

export interface NodeHandlerResult {
  result: unknown;
  /** For agent nodes — the conversation thread ID */
  threadId?: string;
  /** For router/condition nodes — which output handle to follow */
  selectedHandle?: string;
}

export type NodeHandler = (args: NodeHandlerArgs) => Promise<NodeHandlerResult>;
