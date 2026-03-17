// ── Node categories and subtypes ──

export type WorkflowNodeCategory = 'trigger' | 'agent' | 'routing' | 'flow-control' | 'io';

export type TriggerNodeSubtype = 'calendar' | 'chat-app' | 'heartbeat' | 'sulla-desktop' | 'workbench' | 'chat-completions';
export type AgentNodeSubtype = 'agent' | 'tool-call';
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
  triggerType:        TriggerNodeSubtype;
  /** Used by the WorkflowRegistry to determine if this workflow should handle a given message */
  triggerDescription: string;
}

export interface AgentNodeConfig {
  agentId:            string | null;
  agentName:          string;
  additionalPrompt:   string;
  /** Template string for the user message sent to this agent. Supports {{variable}} syntax. */
  userMessage:        string;
  /** Prompt shown to the orchestrator before the agent executes. Describes what this step should accomplish. */
  beforePrompt:       string;
  /** Criteria the orchestrator uses to validate the agent's output after execution. */
  successCriteria:    string;
  /** Custom completion contract appended to the agent prompt. Overrides the default HAND_BACK format when provided. */
  completionContract: string;
}

export interface ToolCallNodeConfig {
  /** Integration slug (e.g. "anthropic", "apollo") */
  integrationSlug:    string;
  /** Endpoint name from the YAML (e.g. "messages-create") */
  endpointName:       string;
  /** Account ID for the integration connection */
  accountId:          string;
  /** Default parameter values — keys are param names, values support {{variable}} syntax */
  defaults:           Record<string, string>;
  /** Description shown to the orchestrator before the call executes, for parameter validation. */
  preCallDescription: string;
}

export interface RouterNodeConfig {
  classificationPrompt: string;
  routes:               { label: string; description: string }[];
}

export interface ConditionNodeConfig {
  rules:      { field: string; operator: string; value: string }[];
  combinator: 'and' | 'or';
}

export interface WaitNodeConfig {
  delayAmount: number;
  delayUnit:   'seconds' | 'minutes' | 'hours';
}

export interface LoopNodeConfig {
  maxIterations: number;
  condition:     string;
  /** How to evaluate the stop condition: 'template' for {{variable}} matching, 'llm' for orchestrator evaluation */
  conditionMode: 'template' | 'llm';
}

export interface ParallelNodeConfig {
  // Structural node — branching is defined by edges
}

export interface MergeNodeConfig {
  strategy: 'wait-all' | 'first';
}

export interface SubWorkflowNodeConfig {
  workflowId:    string | null;
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

export interface NodeThinkingMessage {
  content:   string;
  role:      'assistant' | 'system';
  kind:      string;
  timestamp: string;
}

export interface WorkflowNodeExecutionState {
  status:            WorkflowNodeStatus;
  threadId?:         string;
  output?:           unknown;
  error?:            string;
  startedAt?:        string;
  completedAt?:      string;
  /** Accumulated thinking/conversation messages from the running agent */
  thinkingMessages?: NodeThinkingMessage[];
}

// ── Node data (stored in vue-flow node.data) ──

export interface WorkflowNodeData {
  subtype:    WorkflowNodeSubtype;
  category:   WorkflowNodeCategory;
  label:      string;
  config:     Record<string, any>;
  /** Runtime-only — present during/after workflow execution */
  execution?: WorkflowNodeExecutionState;
}

// ── Serialized structures for persistence ──

export interface WorkflowNodeSerialized {
  id:       string;
  type:     'workflow';
  position: { x: number; y: number };
  data:     WorkflowNodeData;
}

export interface WorkflowEdgeSerialized {
  id:            string;
  source:        string;
  target:        string;
  sourceHandle?: string;
  targetHandle?: string;
  label?:        string;
  animated?:     boolean;
}

// ── Workflow status (determined by subfolder: draft/, production/, archive/) ──

export type WorkflowStatus = 'draft' | 'production' | 'archive';

// ── Top-level workflow definition (saved as YAML to ~/sulla/workflows/<status>/) ──

export interface WorkflowDefinition {
  id:          string;
  name:        string;
  description: string;
  version:     1;
  createdAt:   string;
  updatedAt:   string;
  nodes:       WorkflowNodeSerialized[];
  edges:       WorkflowEdgeSerialized[];
  viewport?:   { x: number; y: number; zoom: number };
}

// ── Workflow list item (returned by workflow-list IPC) ──

export interface WorkflowListItem {
  id:        string;
  name:      string;
  updatedAt: string;
  status:    WorkflowStatus;
}
