import type { ArtifactId } from '../types/chat';

/** Kind dictates which pane renders it inside ArtifactSidebar. */
export type ArtifactKind = 'workflow' | 'html' | 'code';

export type ArtifactStatus = 'working' | 'done' | 'error' | 'viewing' | 'editing';

export interface Artifact {
  id:        ArtifactId;
  kind:      ArtifactKind;
  name:      string;
  status:    ArtifactStatus;
  createdAt: number;
  updatedAt: number;
  /** Free-form payload; each pane interprets its own. See below for typed variants. */
  payload?:  unknown;
}

// ─── Workflow payload ─────────────────────────────────────────────
export interface WorkflowPayload {
  nodes:  WorkflowNode[];
  edges:  WorkflowEdge[];
  activeNodeId?: string;
  /** Backend workflow run correlation id, if this artifact is driven by a live run. */
  workflowRunId?: string;
}
export interface WorkflowNode {
  id:          string;
  x:           number;
  y:           number;
  kicker:      string;
  name:        string;
  state:       'idle' | 'active' | 'done' | 'error' | 'start';
  /** Order the node appears in the workflow run (from backend). */
  nodeIndex?:  number;
}
export interface WorkflowEdge {
  from:   string;
  to:     string;
  state:  'idle' | 'active' | 'done';
}

// ─── HTML payload ─────────────────────────────────────────────────
export interface HtmlPayload {
  html:       string;  // sanitized at service layer
  description?: string;
}

// ─── Code payload ─────────────────────────────────────────────────
export interface CodePayload {
  path:     string;
  language: string;   // 'typescript' | 'javascript' | 'css' | …
  lines:    CodeLine[];
  cursor?:  { line: number; col?: number };
}
export interface CodeLine {
  n:        number;
  text:     string;
  op?:      'add' | 'remove' | 'context';
}

// ─── Narrowing helpers ────────────────────────────────────────────
export const isWorkflow = (a: Artifact): a is Artifact & { payload: WorkflowPayload } =>
  a.kind === 'workflow';
export const isHtml = (a: Artifact): a is Artifact & { payload: HtmlPayload } =>
  a.kind === 'html';
export const isCode = (a: Artifact): a is Artifact & { payload: CodePayload } =>
  a.kind === 'code';
