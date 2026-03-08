/**
 * Workflow types — used by WorkflowPlaybook and the agent's graph loop.
 * Runtime-only types that are NOT persisted in workflow JSON/YAML files
 * (those live in pages/editor/workflow/types.ts).
 */

import type {
  WorkflowNodeSubtype,
  WorkflowNodeCategory,
  WorkflowDefinition,
} from '@pkg/pages/editor/workflow/types';

// ── Workflow Playbook State (lives in agent's BaseThreadState.metadata) ──

export type WorkflowPlaybookStatus = 'running' | 'completed' | 'failed' | 'aborted';

/**
 * Serializable workflow playbook state stored in the orchestrating agent's
 * state.metadata.activeWorkflow. The agent's graph loop checks this after
 * each cycle and processes the next workflow step.
 */
export interface WorkflowPlaybookState {
  workflowId: string;
  executionId: string;
  definition: WorkflowDefinition;
  /** Node IDs currently ready to execute (the "frontier") */
  currentNodeIds: string[];
  /** Node IDs that have finished executing */
  completedNodeIds: string[];
  /** Results from completed nodes, keyed by nodeId */
  nodeOutputs: Record<string, PlaybookNodeOutput>;
  status: WorkflowPlaybookStatus;
  /** When a router/condition node needs the agent to decide, this holds the pending prompt */
  pendingDecision?: {
    nodeId: string;
    subtype: WorkflowNodeSubtype;
    prompt: string;
    /** For routers: the available routes */
    routes?: { label: string; description: string; handleId: string }[];
    /** For conditions: the rules being evaluated */
    rules?: { field: string; operator: string; value: string }[];
  };
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface PlaybookNodeOutput {
  nodeId: string;
  label: string;
  subtype: WorkflowNodeSubtype;
  category: WorkflowNodeCategory;
  result: unknown;
  threadId?: string;
  completedAt: string;
}

// ── Node execution status (pushed to UI via WebSocket) ──

export type WorkflowNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting';   // paused for user-input

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
