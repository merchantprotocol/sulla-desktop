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

// ─── Routine document parsing ─────────────────────────────────────
// Each template at ~/sulla/routines/<slug>/routine.yaml is a full
// routine DAG: top-level metadata plus `nodes`, `edges`, and
// `viewport`. We only project the fields My Templates needs into the
// summary row; the rest of the document is passed through verbatim
// when the user instantiates the template.

interface RoutineNodeLike {
  id?:       string;
  type?:     string;
  position?: { x: number; y: number };
  data?:     {
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

function newId(prefix: string): string {
  return `${ prefix }-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`;
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

    const docPath = path.join(getRoutinesDir(), slug, 'routine.yaml');
    if (!fs.existsSync(docPath)) {
      throw new Error(`Template not found: ${ slug }`);
    }

    const doc = readRoutineDoc(docPath);
    if (!doc) {
      throw new Error(`Template is unreadable: ${ slug }`);
    }

    // Deep-clone the full routine document into a fresh DB row. Nodes,
    // edges and viewport are passed through verbatim — the instantiated
    // routine is a true editable copy of the template, not a scaffold.
    // Only identity + timestamps are minted fresh so two users of the
    // same template don't collide on id.
    const newRoutineId = newId(`routine-${ slug }`);
    const now = new Date().toISOString();

    const routine: Record<string, unknown> = {
      ...doc,
      id:          newRoutineId,
      name:        String(doc.name ?? slug),
      description: String(doc.description ?? ''),
      version:     doc.version ?? 1,
      enabled:     doc.enabled !== false,
      createdAt:   now,
      updatedAt:   now,
      _status:     'draft',
      nodes:       Array.isArray(doc.nodes) ? doc.nodes : [],
      edges:       Array.isArray(doc.edges) ? doc.edges : [],
      viewport:    doc.viewport ?? { x: 0, y: 0, zoom: 1 },
    };

    const WorkflowModel = await importWorkflowModel();

    await WorkflowModel.upsertFromDefinition(routine, {
      status:             'draft',
      changeReason:       `instantiated from template:${ slug }`,
      sourceTemplateSlug: slug,
    });

    console.log(`[Sulla] Instantiated template "${ slug }" as routine "${ newRoutineId }" (${ (routine.nodes as unknown[]).length } nodes, ${ (routine.edges as unknown[]).length } edges)`);

    return { id: newRoutineId, name: routine.name as string };
  });

  // ── Direct routine execution ──
  // Thin IPC wrapper around `executeRoutine` — the real work is below
  // so the scheduler (and anything else that needs to kick a routine
  // without a user click) can call the same code path.
  ipcMainProxy.handle('routines-execute', async(_event: unknown, workflowId: string, triggerPayload?: string) => {
    return await executeRoutine(workflowId, triggerPayload);
  });

  // ── User-initiated abort ──
  // Flip the active playbook's status to 'aborted' so the next pass
  // through PlaybookController's walker loop exits cleanly, and emit
  // the `workflow_aborted` WS event so the UI clears its run state
  // immediately — before the walker even notices. The in-flight LLM
  // call or tool invocation isn't interrupted; it finishes and then
  // the loop winds down. Best-effort; never throws.
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

  // ── Run history ──
  // The canvas persists per-node snapshots to `workflow_checkpoints`
  // during every run (WorkflowCheckpointModel.saveCheckpoint). These
  // two handlers expose that for a run-history drawer in the UI so the
  // user can pick any past run and inspect its final state.

  /** List recent runs for a given workflow — most-recent-first.
   *  Returns one summary row per execution_id, plus the latest checkpoint's
   *  node label and timestamp so the UI can caption each row. */
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

  /** Full snapshot for a single run. Returns every checkpoint in order +
   *  a convenience map of nodeId → {label, output, completedAt} so the
   *  renderer can hydrate node cards directly without walking checkpoints. */
  ipcMainProxy.handle('routines-load-run', async(_event: unknown, executionId: string) => {
    if (!executionId) return null;
    try {
      const { WorkflowCheckpointModel } = await import('@pkg/agent/database/models/WorkflowCheckpointModel');
      const checkpoints = await WorkflowCheckpointModel.findByExecution(executionId);
      if (checkpoints.length === 0) return null;

      const nodeOutputs: Record<string, { nodeId: string; label: string; output: unknown; completedAt: string }> = {};
      for (const cp of checkpoints) {
        const a = cp.attributes as any;
        // Keep the last output per node id — retries / re-runs overwrite
        // naturally since checkpoints are sequence-ordered.
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
        checkpoints:     checkpoints.map(cp => {
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

// ─── Execution helper ─────────────────────────────────────────────
// Previously a routine was kicked off by sending a chat message like
// "Let's run X" — the agent parsed it, called the execute_workflow
// tool, and that tool primed the playbook. This helper drops the chat
// step entirely: it spins up a fresh agent graph on the default
// `sulla-desktop` channel, primes the playbook with
// `activateWorkflowOnState`, and kicks the graph loop. The agent is
// still the orchestrator — we're just removing the natural-language
// handoff from the trigger path.
//
// Exported so both the `routines-execute` IPC handler and the
// WorkflowSchedulerService cron callbacks share a single code path.

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

  // Fresh thread per execution so concurrent runs of the same routine
  // keep their state and event streams cleanly separated.
  const executionId = `routine-exec-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`;

  // sulla-desktop is the default agent for every graph. This is
  // intentional — there is no per-routine agent assignment, and
  // there doesn't need to be.
  const WS_CHANNEL = 'sulla-desktop';

  const { GraphRegistry } = await import('@pkg/agent/services/GraphRegistry');
  const { activateWorkflowOnState } = await import('@pkg/agent/tools/workflow/execute_workflow');

  const graphResult = await GraphRegistry.getOrCreateAgentGraph(WS_CHANNEL, executionId);
  const graph = (graphResult as { graph: unknown }).graph as { execute: (state: unknown) => Promise<unknown> };
  const state = (graphResult as { state: Record<string, any> }).state;

  // Scope the thread to this workflow so the agent doesn't wander off
  // and pick up unrelated routines. `activateWorkflowOnState` honours
  // this — it'll refuse to activate anything else.
  state.metadata = state.metadata ?? {};
  state.metadata.scopedWorkflowId = workflowId;

  // Trigger payload becomes the "user message" threaded into the
  // playbook state. A direct click of Play doesn't carry a natural
  // language intent, so we synthesize one the downstream nodes can
  // lean on if they need it.
  const message = (triggerPayload ?? '').trim() || `Run routine ${ workflowId }`;

  const activation = await activateWorkflowOnState(state as any, {
    workflowId,
    message,
  });

  if (!activation.ok) {
    throw new Error(activation.responseString);
  }

  // Fire-and-forget — the renderer subscribes to the WebSocket event
  // stream for progress. Surfacing errors here only helps the main
  // process logs; the UI will see the failure via `workflow_aborted`
  // / `node_failed` events that PlaybookController already emits.
  void graph.execute(state).catch((err) => {
    console.error(`[Sulla] routine execution ${ executionId } failed:`, err);
  });

  console.log(`[Sulla] Executing routine "${ workflowId }" as ${ executionId } on channel ${ WS_CHANNEL }`);

  return { executionId, workflowId };
}
