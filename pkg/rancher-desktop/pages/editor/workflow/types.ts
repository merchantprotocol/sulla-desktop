// ── Node categories and subtypes ──

export type WorkflowNodeCategory = 'trigger' | 'agent' | 'routing' | 'flow-control' | 'io';

export type TriggerNodeSubtype = 'calendar' | 'chat-app' | 'heartbeat' | 'sulla-desktop' | 'chat-completions';
export type AgentNodeSubtype = 'agent';
export type RoutingNodeSubtype = 'router' | 'condition';
export type FlowControlNodeSubtype = 'wait' | 'loop' | 'parallel' | 'merge' | 'sub-workflow';
export type IONodeSubtype = 'user-input' | 'response' | 'transfer';

export type WorkflowNodeSubtype =
  | TriggerNodeSubtype
  | AgentNodeSubtype
  | RoutingNodeSubtype
  | FlowControlNodeSubtype
  | IONodeSubtype;

// ── Per-node config types ──

export interface TriggerNodeConfig {
  triggerType: TriggerNodeSubtype;
  /** Used by the WorkflowRegistry to determine if this workflow should handle a given message */
  triggerDescription: string;
}

export interface AgentNodeConfig {
  agentId: string | null;
  agentName: string;
  additionalPrompt: string;
  /** Template string for the user message sent to this agent. Supports {{variable}} syntax. */
  userMessage: string;
}

export interface RouterNodeConfig {
  classificationPrompt: string;
  routes: { label: string; description: string }[];
}

export interface ConditionNodeConfig {
  rules: { field: string; operator: string; value: string }[];
  combinator: 'and' | 'or';
}

export interface WaitNodeConfig {
  delayAmount: number;
  delayUnit: 'seconds' | 'minutes' | 'hours';
}

export interface LoopNodeConfig {
  maxIterations: number;
  condition: string;
}

export interface ParallelNodeConfig {
  // Structural node — branching is defined by edges
}

export interface MergeNodeConfig {
  strategy: 'wait-all' | 'first';
}

export interface SubWorkflowNodeConfig {
  workflowId: string | null;
  awaitResponse: boolean;
}

export interface UserInputNodeConfig {
  promptText: string;
}

export interface ResponseNodeConfig {
  /** Template string for the response. Supports {{variable}} syntax. When empty, passes through upstream output. */
  responseTemplate: string;
}

export interface TransferNodeConfig {
  targetWorkflowId: string | null;
}

// ── Runtime execution state (never serialized to JSON) ──

export type WorkflowNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting';

export interface WorkflowNodeExecutionState {
  status: WorkflowNodeStatus;
  threadId?: string;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ── Node data (stored in vue-flow node.data) ──

export interface WorkflowNodeData {
  subtype: WorkflowNodeSubtype;
  category: WorkflowNodeCategory;
  label: string;
  config: Record<string, any>;
  /** Runtime-only — present during/after workflow execution */
  execution?: WorkflowNodeExecutionState;
}

// ── Serialized structures for persistence ──

export interface WorkflowNodeSerialized {
  id: string;
  type: 'workflow';
  position: { x: number; y: number };
  data: WorkflowNodeData;
}

export interface WorkflowEdgeSerialized {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  animated?: boolean;
}

// ── Top-level workflow definition (saved as JSON to ~/sulla/workflows/) ──

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: 1;
  /** When true, the workflow is active and will be triggered by the WorkflowRegistry in production */
  enabled?: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowNodeSerialized[];
  edges: WorkflowEdgeSerialized[];
  viewport?: { x: number; y: number; zoom: number };
}

// ── Workflow list item (returned by workflow-list IPC) ──

export interface WorkflowListItem {
  id: string;
  name: string;
  updatedAt: string;
}
