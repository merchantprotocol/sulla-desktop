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
//
// Shape mirrors `routine.yaml` exactly — same field names, same nesting —
// so there's zero mapping between the routine on disk and what the
// artifact renderer consumes. Runtime execution state layers onto these
// objects via the optional `runtimeState` field; the renderer falls back
// to `idle` coloring when it's absent (authoring mode).
//
// If the YAML schema changes, update these types in lockstep and the
// renderer / PersonaAdapter emitters with it. Keep them identical.

export type WorkflowRuntimeState = 'idle' | 'active' | 'done' | 'error' | 'start';
export type WorkflowEdgeRuntimeState = 'idle' | 'active' | 'done';

export interface WorkflowPayload {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Optional canvas viewport carried over from the routine YAML. */
  viewport?: { x: number; y: number; zoom: number };
  /** Id of the node currently running (set during execution). */
  activeNodeId?: string;
  /** Backend workflow run correlation id, if driven by a live run. */
  workflowRunId?: string;
  /** Workflow identity from the routine manifest (for display). */
  id?:          string;
  name?:        string;
  description?: string;
  _status?:     'draft' | 'production' | 'archive';
}

export interface WorkflowNode {
  id:       string;
  /** React Flow expects 'workflow' for every node; preserved here so the
   *  same payload can be round-tripped back to the editor without loss. */
  type:     string;
  position: { x: number; y: number };
  data: {
    subtype:  string;
    category: string;
    label:    string;
    config?:  Record<string, unknown>;
  };
  /** Runtime overlay — populated only while the workflow is executing.
   *  Absent in the authoring artifact; renderer treats absence as `idle`. */
  runtimeState?: WorkflowRuntimeState;
  /** Order in which this node has fired during the current run. Absent in
   *  authoring mode. */
  nodeIndex?: number;
}

export interface WorkflowEdge {
  id:            string;
  source:        string;
  target:        string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?:        string;
  animated?:     boolean;
  /** Runtime overlay. Absent → renderer treats as `idle`. */
  runtimeState?: WorkflowEdgeRuntimeState;
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
