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

function toSummary(slug: string, doc: RoutineDocument): TemplateSummaryRow {
  return {
    slug,
    id:           String(doc.id ?? slug),
    name:         String(doc.name ?? slug),
    description:  String(doc.description ?? '').trim().replace(/\s+/g, ' '),
    version:      doc.version != null ? String(doc.version) : '1',
    nodeCount:    Array.isArray(doc.nodes) ? doc.nodes.length : 0,
    edgeCount:    Array.isArray(doc.edges) ? doc.edges.length : 0,
    triggerTypes: extractTriggerTypes(doc),
    updatedAt:    String(doc.updatedAt ?? ''),
  };
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
      const docPath = path.join(root, entry.name, 'routine.yaml');
      if (!fs.existsSync(docPath)) continue;
      const doc = readRoutineDoc(docPath);
      if (!doc) continue;
      summaries.push(toSummary(entry.name, doc));
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
      status:       'draft',
      changeReason: `instantiated from template:${ slug }`,
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
