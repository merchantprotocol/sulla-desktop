/**
 * Routine-template IPC event handlers.
 *
 * The "My Templates" tab in RoutinesHome.vue is backed by the template
 * registry at ~/sulla/routines/<slug>/routine.yaml — each template is
 * its own git repo with a manifest, functions, and optional resources.
 *
 * Two handlers here:
 *   - `routines-template-list`      → scan the registry, parse manifests,
 *                                     return summary rows.
 *   - `routines-template-instantiate` → clone a template into a fresh row
 *                                       in the workflows table so the user
 *                                       can edit it on the canvas. Returns
 *                                       the new routine id.
 *
 * Kept in its own file (rather than bolted onto sullaWorkflowEvents.ts)
 * because templates are a distinct domain from workflows: the registry
 * is read-only, the IDs/statuses differ, and the lifecycles don't overlap.
 */

import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

/**
 * Dynamic import of WorkflowModel — keeps the Postgres layer out of the
 * main-process startup bundle, matching the pattern in sullaWorkflowEvents.
 */
async function importWorkflowModel() {
  const mod = await import('@pkg/agent/database/models/WorkflowModel');

  return mod.WorkflowModel;
}

function getRoutinesDir(): string {
  const { resolveSullaRoutinesDir } = require('@pkg/agent/utils/sullaPaths');

  return resolveSullaRoutinesDir();
}

// ─── Manifest parsing ─────────────────────────────────────────────
// The shape we project out to the renderer. Loose typing on the
// manifest side since routine.yaml can carry extra fields (author,
// license, trust, etc.) that the UI doesn't need right now.

interface TemplateManifest {
  id?:          string;
  name?:        string;
  description?: string;
  slug?:        string;
  version?:     string;
  section?:     string;
  category?:    string;
  tags?:        string[];
  spec?: {
    runtime?:     string;
    inputs?:      Record<string, unknown>;
    outputs?:     Record<string, unknown>;
    permissions?: Record<string, unknown>;
  };
}

export interface TemplateSummaryRow {
  slug:         string;
  id:           string;
  name:         string;
  description:  string;
  version:      string;
  nodeCount:    number;
  edgeCount:    number;
  /** Subtypes of every node whose `data.category === 'trigger'`. */
  triggerTypes: string[];
  updatedAt:    string;

  // ─── AGENT.md metadata (all optional — present only when the template
  // ships an AGENT.md with parseable YAML frontmatter) ────────────────
  hasAgentMd?:           boolean;
  /** One-line pitch from AGENT.md frontmatter `summary`. Falls back to `description`. */
  summary?:              string;
  /** Integration slugs the routine needs available. */
  requiredIntegrations?: string[];
  /** Function slugs that must exist at ~/sulla/functions/<slug>/. */
  requiredFunctions?:    string[];
}

/**
 * AGENT.md is a markdown file with optional YAML frontmatter between
 * `---` fences. We only care about the frontmatter — the body is
 * orchestrator-facing prose, not summary material.
 */
interface AgentFrontmatter {
  name?:                     string;
  summary?:                  string;
  triggers?:                 string[];
  required_integrations?:    string[];
  required_vault_accounts?:  string[];
  required_functions?:       string[];
  entry_node?:               string;
}

function readAgentMd(templateDir: string): AgentFrontmatter | null {
  const agentPath = path.join(templateDir, 'AGENT.md');
  if (!fs.existsSync(agentPath)) return null;

  try {
    const raw = fs.readFileSync(agentPath, 'utf-8');
    // Frontmatter must start at byte 0 (leading --- newline) to count.
    // Anything else and we treat the file as body-only markdown.
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {}; // file exists but no frontmatter — still "has AGENT.md"

    const parsed = yaml.parse(match[1]);

    return (parsed && typeof parsed === 'object') ? parsed as AgentFrontmatter : {};
  } catch (err) {
    console.warn(`[Sulla] Failed to parse AGENT.md at ${ agentPath }:`, err);

    return null;
  }
}

function readManifest(manifestPath: string): TemplateManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');

    return yaml.parse(raw) as TemplateManifest;
  } catch (err) {
    console.warn(`[Sulla] Failed to parse template manifest ${ manifestPath }:`, err);

    return null;
  }
}

// ─── DAG-shape parsing (routine.yaml as a graph doc) ────────────────
// routine.yaml is overloaded — it's both an asset manifest AND a DAG
// document (nodes/edges/viewport). The scanner reads it as a DAG to
// project nodeCount/edgeCount/triggerTypes into the template summary;
// the instantiate handler reads it as a manifest via readManifest().

interface RoutineNodeLike {
  id?:       string;
  type?:     string;
  position?: { x: number; y: number };
  data?: {
    subtype?:  string;
    category?: string;
    label?:    string;
    [k: string]: unknown;
  };
}

interface RoutineEdgeLike {
  id?:     string;
  source?: string;
  target?: string;
  [k: string]: unknown;
}

interface RoutineDocument {
  id?:          string;
  name?:        string;
  description?: string;
  version?:     string | number;
  createdAt?:   string;
  updatedAt?:   string;
  enabled?:     boolean;
  nodes?:       RoutineNodeLike[];
  edges?:       RoutineEdgeLike[];
  viewport?:    { x: number; y: number; zoom: number };
  [k: string]:  unknown;
}

function readRoutineDoc(docPath: string): RoutineDocument | null {
  try {
    const raw = fs.readFileSync(docPath, 'utf-8');

    return yaml.parse(raw) as RoutineDocument;
  } catch (err) {
    console.warn(`[Sulla] Failed to parse routine document ${ docPath }:`, err);

    return null;
  }
}

function extractTriggerTypes(doc: RoutineDocument): string[] {
  const seen = new Set<string>();
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  for (const node of nodes) {
    if (node?.data?.category === 'trigger' && typeof node.data.subtype === 'string') {
      seen.add(node.data.subtype);
    }
  }

  return Array.from(seen);
}

/** Render the permissions map into a compact single-line hint. */
function summarizePermissions(spec?: TemplateManifest['spec']): string {
  const perms = spec?.permissions ?? {};
  const parts: string[] = [];
  const network = (perms as Record<string, unknown>).network;
  if (Array.isArray(network) && network.length > 0) {
    const first = String(network[0]);
    parts.push(`network: ${ first === '*' ? '*' : first }`);
  }
  const env = (perms as Record<string, unknown>).env;
  if (Array.isArray(env) && env.length > 0) parts.push(`env: ${ env.length }`);
  const secrets = (perms as Record<string, unknown>).secrets;
  if (Array.isArray(secrets) && secrets.length > 0) parts.push(`secrets: ${ secrets.length }`);
  if (parts.length === 0) return 'none';

  return parts.join(' · ');
}

function toSummary(slug: string, doc: RoutineDocument, templateDir: string): TemplateSummaryRow {
  const agent = readAgentMd(templateDir);

  // AGENT.md wins on display name / summary when present — it's the
  // orchestrator-curated copy, whereas `doc.name` / `doc.description`
  // come from whatever the canvas dumped. Fall back cleanly.
  const name = (agent?.name && agent.name.trim()) || String(doc.name ?? slug);
  const description = String(doc.description ?? '').trim().replace(/\s+/g, ' ');
  const summary = (agent?.summary && agent.summary.trim()) || description;

  // AGENT.md's `triggers:` is a hint list, not a source of truth. The
  // real triggers are the nodes in the DAG. We still extract
  // extractTriggerTypes() below for the card's quick-glance badge row.
  const triggerTypes = extractTriggerTypes(doc);

  const row: TemplateSummaryRow = {
    slug,
    id:           String(doc.id ?? slug),
    name,
    description,
    version:      doc.version != null ? String(doc.version) : '1',
    nodeCount:    Array.isArray(doc.nodes) ? doc.nodes.length : 0,
    edgeCount:    Array.isArray(doc.edges) ? doc.edges.length : 0,
    triggerTypes,
    updatedAt:    String(doc.updatedAt ?? ''),
  };

  if (agent !== null) {
    row.hasAgentMd = true;
    if (summary && summary !== description) row.summary = summary;
    if (Array.isArray(agent.required_integrations) && agent.required_integrations.length > 0) {
      row.requiredIntegrations = agent.required_integrations.map(String);
    }
    if (Array.isArray(agent.required_functions) && agent.required_functions.length > 0) {
      row.requiredFunctions = agent.required_functions.map(String);
    }
  }

  return row;
}

// ─── Workflow instantiation ───────────────────────────────────────
// A template's routine.yaml is itself a full DAG (nodes/edges/viewport).
// Instantiating = cloning that DAG into a fresh workflow row the user
// can edit. We re-ID every node and rewrite every edge's source/target
// to the new ids so two instantiations of the same template never
// collide, while preserving positions, data, and viewport verbatim.
//
// A template with zero nodes is a hard error — we throw instead of
// silently scaffolding a stub. The user installed a specific template
// and expects its graph, not a surprise two-node placeholder.

interface WrapOptions {
  slug:     string;
  manifest: TemplateManifest;
  doc:      RoutineDocument;
}

function newId(prefix: string): string {
  return `${ prefix }-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`;
}

function buildWorkflowFromTemplate({ slug, manifest, doc }: WrapOptions): Record<string, unknown> {
  const workflowId = newId(`workflow-${ slug }`);
  const now = new Date().toISOString();
  const name = manifest.name ?? doc.name ?? slug;
  const description = manifest.description ?? doc.description ?? `Workflow based on the ${ slug } template.`;
  const viewport = doc.viewport ?? { x: 0, y: 0, zoom: 1 };

  const srcNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const srcEdges = Array.isArray(doc.edges) ? doc.edges : [];

  if (srcNodes.length === 0) {
    throw new Error(
      `Template "${ slug }" has no nodes in routine.yaml — refusing to instantiate an empty graph.`,
    );
  }

  // Re-ID every node, keep a remap so edges point at the new ids.
  const idMap = new Map<string, string>();
  const nodes = srcNodes.map((n) => {
    const oldId = typeof n.id === 'string' && n.id ? n.id : newId('node');
    const freshId = newId('node');
    idMap.set(oldId, freshId);

    return {
      ...n,
      id:       freshId,
      // Spread preserves type/position/data/style/measured/etc. — anything
      // the template author included on the node carries through.
    };
  });

  const edges = srcEdges
    .map((e) => {
      const src = typeof e.source === 'string' ? idMap.get(e.source) : undefined;
      const tgt = typeof e.target === 'string' ? idMap.get(e.target) : undefined;
      // Drop dangling edges (source or target missing from the remap) —
      // better than a React Flow render crash on unknown node ids.
      if (!src || !tgt) return null;

      return { ...e, id: newId('edge'), source: src, target: tgt };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return {
    id:          workflowId,
    name:        `${ name } · new routine`,
    description,
    version:     '0.1.0',
    enabled:     true,
    createdAt:   now,
    updatedAt:   now,
    _status:     'draft',
    nodes,
    edges,
    viewport,
  };
}

// ─── Handler registration ─────────────────────────────────────────

export function initSullaRoutineTemplateEvents(): void {
  ipcMainProxy.handle('routines-template-list', () => {
    const root = getRoutinesDir();
    if (!fs.existsSync(root)) return [];

    const entries = fs.readdirSync(root, { withFileTypes: true });
    const summaries: TemplateSummaryRow[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const templateDir = path.join(root, entry.name);
      const docPath = path.join(templateDir, 'routine.yaml');
      if (!fs.existsSync(docPath)) continue;
      const doc = readRoutineDoc(docPath);
      if (!doc) continue;
      summaries.push(toSummary(entry.name, doc, templateDir));
    }

    // Stable ordering — alphabetical by display name.
    summaries.sort((a, b) => a.name.localeCompare(b.name));

    return summaries;
  });

  ipcMainProxy.handle('routines-create-blank', async() => {
    // Scaffold an empty workflow and land it in the workflows table as
    // a draft. Gives the user an id to navigate to on the canvas where
    // the first real save will dual-write YAML alongside the DB row.
    const id = newId('workflow-blank');
    const now = new Date().toISOString();
    const workflow: Record<string, unknown> = {
      id,
      name:        'Untitled Routine',
      description: '',
      version:     '0.1.0',
      enabled:     true,
      createdAt:   now,
      updatedAt:   now,
      _status:     'draft',
      nodes:       [],
      edges:       [],
      viewport:    { x: 0, y: 0, zoom: 1 },
    };

    const WorkflowModel = await importWorkflowModel();

    await WorkflowModel.upsertFromDefinition(workflow, {
      status:       'draft',
      changeReason: 'created blank routine',
    });

    console.log(`[Sulla] Created blank routine "${ id }"`);

    return { id, name: workflow.name as string };
  });

  ipcMainProxy.handle('routines-template-instantiate', async(_event: unknown, slug: string) => {
    if (!slug || typeof slug !== 'string') {
      throw new Error('routines-template-instantiate: slug is required');
    }

    const manifestPath = path.join(getRoutinesDir(), slug, 'routine.yaml');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Template not found: ${ slug }`);
    }

    const manifest = readManifest(manifestPath);
    if (!manifest) {
      throw new Error(`Template manifest is unreadable: ${ slug }`);
    }

    // Same file, read twice — once as a typed manifest (metadata) and
    // once as a RoutineDocument (full DAG). Cheap (tiny YAML) and keeps
    // the two code paths type-distinct.
    const doc = readRoutineDoc(manifestPath);
    if (!doc) {
      throw new Error(`Template routine document is unreadable: ${ slug }`);
    }

    const workflow = buildWorkflowFromTemplate({ slug, manifest, doc });

    // DB-first write. The runtime still scans disk for execution, so a
    // YAML materialization will happen when the user hits save in the
    // editor (Phase 4 — workflow-save handler dual-writes disk + DB).
    const WorkflowModel = await importWorkflowModel();

    await WorkflowModel.upsertFromDefinition(workflow, {
      status:             'draft',
      changeReason:       `instantiated from template:${ slug }`,
      sourceTemplateSlug: slug,
    });

    console.log(`[Sulla] Instantiated template "${ slug }" as workflow "${ workflow.id }"`);

    return { id: workflow.id as string, name: workflow.name as string };
  });

  ipcMainProxy.handle('routines-execute', async(_event: unknown, workflowId: string, triggerPayload?: string) => {
    return await executeRoutine(workflowId, triggerPayload);
  });

  ipcMainProxy.handle('routines-abort', async(_event: unknown, executionId: string) => {
    if (!executionId) return { aborted: false, reason: 'missing-execution-id' };

    try {
      const { GraphRegistry }   = await import('@pkg/agent/services/GraphRegistry');
      const { abortPlaybook }   = await import('@pkg/agent/workflow/WorkflowPlaybook');
      const { getWebSocketClientService } = await import('@pkg/agent/services/WebSocketClientService');

      const cached = GraphRegistry.get(executionId) as { state?: Record<string, any> } | null;
      const state = cached?.state;

      if (!state) {
        console.warn(`[routines-abort] no cached state for executionId=${ executionId }`);

        return { aborted: false, reason: 'not-found' };
      }

      const meta = (state.metadata ??= {});
      if (meta.activeWorkflow) {
        meta.activeWorkflow = abortPlaybook(meta.activeWorkflow);
      }

      // Signal the AbortService so any in-flight LLM fetch, tool call,
      // or sub-agent graph unwinds immediately. Flipping playbook.status
      // alone only stops the walker at the NEXT processNextStep boundary —
      // which can be many seconds later if a long LLM response is streaming.
      const abortService = meta.options?.abort;
      if (abortService && typeof abortService.abort === 'function' && !abortService.aborted) {
        try {
          abortService.abort();
        } catch (err) {
          console.warn('[routines-abort] abortService.abort() threw:', err);
        }
      }

      // Fan-out abort to every sub-agent PlaybookController spawned off
      // this routine. Each sub-agent runs on its own graph state (own
      // AbortService), so parent abort doesn't reach them automatically.
      // PlaybookController.executeSubAgent registers every threadId on
      // meta.activeSubAgentThreadIds and removes it on return; snapshot
      // the list so the array mutating under us (finishing sub-agents)
      // doesn't trip the iteration.
      const subThreadIds: string[] = Array.isArray(meta.activeSubAgentThreadIds)
        ? [...meta.activeSubAgentThreadIds]
        : [];
      for (const subThreadId of subThreadIds) {
        try {
          const subCached = GraphRegistry.get(subThreadId) as { state?: Record<string, any> } | null;
          const subAbort = subCached?.state?.metadata?.options?.abort;
          if (subAbort && typeof subAbort.abort === 'function' && !subAbort.aborted) {
            subAbort.abort();
          }
        } catch (err) {
          console.warn(`[routines-abort] sub-agent abort failed for threadId=${ subThreadId }:`, err);
        }
      }
      if (subThreadIds.length > 0) {
        console.log(`[routines-abort] fanned-out abort to ${ subThreadIds.length } sub-agent(s)`);
      }

      const channel = meta.wsChannel || 'sulla-desktop';

      try {
        getWebSocketClientService().send(channel, {
          type:      'workflow_execution_event',
          data:      {
            type:      'workflow_aborted',
            thread_id: executionId,
            timestamp: new Date().toISOString(),
            reason:    'user_requested',
          },
          timestamp: Date.now(),
        });
      } catch { /* WS best-effort */ }

      console.log(`[routines-abort] ← ok executionId=${ executionId }`);

      return { aborted: true };
    } catch (err) {
      console.error(`[routines-abort] ✗ executionId=${ executionId }`, err);

      return { aborted: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMainProxy.handle('routines-list-runs', async(_event: unknown, workflowId: string, limit?: number) => {
    if (!workflowId) return [];
    try {
      const { postgresClient } = await import('@pkg/agent/database/PostgresClient');
      const rows = await postgresClient.queryAll(
        `WITH latest AS (
           SELECT DISTINCT ON (execution_id)
             execution_id,
             workflow_id,
             workflow_name,
             node_id,
             node_label,
             sequence,
             created_at
           FROM workflow_checkpoints
           WHERE workflow_id = $1
           ORDER BY execution_id, sequence DESC
         ),
         counts AS (
           SELECT execution_id, COUNT(*)::int AS checkpoint_count, MIN(created_at) AS started_at
           FROM workflow_checkpoints
           WHERE workflow_id = $1
           GROUP BY execution_id
         )
         SELECT l.*, c.checkpoint_count, c.started_at
         FROM latest l
         JOIN counts c USING (execution_id)
         ORDER BY l.created_at DESC
         LIMIT $2`,
        [workflowId, typeof limit === 'number' && limit > 0 ? limit : 25],
      );

      return rows.map((row: any) => ({
        executionId:     row.execution_id,
        workflowId:      row.workflow_id,
        workflowName:    row.workflow_name,
        lastNodeId:      row.node_id,
        lastNodeLabel:   row.node_label,
        checkpointCount: Number(row.checkpoint_count ?? 0),
        startedAt:       row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
        endedAt:         row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      }));
    } catch (err) {
      console.error('[routines-list-runs] failed:', err);

      return [];
    }
  });

  ipcMainProxy.handle('routines-load-run', async(_event: unknown, executionId: string) => {
    if (!executionId) return null;
    try {
      const { WorkflowCheckpointModel } = await import('@pkg/agent/database/models/WorkflowCheckpointModel');
      const checkpoints = await WorkflowCheckpointModel.findByExecution(executionId);
      if (checkpoints.length === 0) return null;

      const nodeOutputs: Record<string, { nodeId: string; label: string; output: unknown; completedAt: string }> = {};
      for (const cp of checkpoints) {
        const a = cp.attributes as any;
        nodeOutputs[a.node_id] = {
          nodeId:      a.node_id,
          label:       a.node_label,
          output:      a.node_output,
          completedAt: a.created_at instanceof Date ? a.created_at.toISOString() : a.created_at,
        };
      }

      const first = checkpoints[0].attributes as any;
      const last = checkpoints[checkpoints.length - 1].attributes as any;

      return {
        executionId,
        workflowId:      first.workflow_id,
        workflowName:    first.workflow_name,
        startedAt:       first.created_at instanceof Date ? first.created_at.toISOString() : first.created_at,
        endedAt:         last.created_at instanceof Date ? last.created_at.toISOString() : last.created_at,
        checkpointCount: checkpoints.length,
        nodeOutputs,
        checkpoints:     checkpoints.map((cp) => {
          const a = cp.attributes as any;

          return {
            sequence:    a.sequence,
            nodeId:      a.node_id,
            nodeLabel:   a.node_label,
            nodeSubtype: a.node_subtype,
            nodeOutput:  a.node_output,
            createdAt:   a.created_at instanceof Date ? a.created_at.toISOString() : a.created_at,
          };
        }),
      };
    } catch (err) {
      console.error('[routines-load-run] failed:', err);

      return null;
    }
  });

  console.log('[Sulla] Routine template IPC handlers initialized');
}

export interface RoutineExecutionResult {
  executionId: string;
  workflowId:  string;
}

export async function executeRoutine(
  workflowId: string,
  triggerPayload?: string,
): Promise<RoutineExecutionResult> {
  if (!workflowId) {
    throw new Error('executeRoutine: workflowId is required');
  }

  const executionId = `routine-exec-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`;
  const WS_CHANNEL = 'sulla-desktop';

  const { GraphRegistry } = await import('@pkg/agent/services/GraphRegistry');
  const { activateWorkflowOnState } = await import('@pkg/agent/tools/workflow/execute_workflow');

  const graphResult = await GraphRegistry.getOrCreateAgentGraph(WS_CHANNEL, executionId);
  const graph = (graphResult as { graph: unknown }).graph as { execute: (state: unknown) => Promise<unknown> };
  const state = (graphResult as { state: Record<string, any> }).state;

  state.metadata = state.metadata ?? {};
  state.metadata.scopedWorkflowId = workflowId;

  // Pass through the user payload as-is. When empty, the playbook's
  // createPlaybookState will substitute the routine framing into the
  // trigger node's output. Do NOT synthesize a "Run routine X" string —
  // LLMs misread that as an imperative and trigger recursive workflow calls.
  const message = (triggerPayload ?? '').trim();

  const activation = await activateWorkflowOnState(state as any, {
    workflowId,
    message,
  });

  if (!activation.ok) {
    throw new Error(activation.responseString);
  }

  void graph.execute(state).catch((err) => {
    console.error(`[Sulla] routine execution ${ executionId } failed:`, err);
  });

  console.log(`[Sulla] Executing routine "${ workflowId }" as ${ executionId } on channel ${ WS_CHANNEL }`);

  return { executionId, workflowId };
}
