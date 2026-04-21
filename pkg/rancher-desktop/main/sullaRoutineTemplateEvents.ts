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
  slug:        string;
  name:        string;
  description: string;
  version:     string;
  section:     string;
  category:    string;
  runtime:     string | null;
  tags:        string[];
  inputCount:  number;
  outputCount: number;
  permissions: string;
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

function toSummary(slug: string, manifest: TemplateManifest): TemplateSummaryRow {
  return {
    slug,
    name:        String(manifest.name ?? slug),
    description: String(manifest.description ?? '').trim().replace(/\s+/g, ' '),
    version:     String(manifest.version ?? '0.0.0'),
    section:     String(manifest.section ?? 'Uncategorized'),
    category:    String(manifest.category ?? 'ops'),
    runtime:     manifest.spec?.runtime ? String(manifest.spec.runtime) : null,
    tags:        Array.isArray(manifest.tags) ? manifest.tags.map(String) : [],
    inputCount:  Object.keys(manifest.spec?.inputs ?? {}).length,
    outputCount: Object.keys(manifest.spec?.outputs ?? {}).length,
    permissions: summarizePermissions(manifest.spec),
  };
}

// ─── Workflow wrapping ────────────────────────────────────────────
// When a template is instantiated, we scaffold a minimal workflow
// graph around it: one manual trigger + one routine node executing
// the template. The user can then extend the graph in the editor.

interface WrapOptions {
  slug:     string;
  manifest: TemplateManifest;
}

function newId(prefix: string): string {
  return `${ prefix }-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`;
}

function buildWorkflowFromTemplate({ slug, manifest }: WrapOptions): Record<string, unknown> {
  const workflowId = newId(`workflow-${ slug }`);
  const triggerId = newId('trigger');
  const routineId = newId('routine');
  const now = new Date().toISOString();

  // Flatten the manifest description to a single-line tagline — the
  // routine node uses this as its subtitle on the canvas, matching
  // what library-drawer cards show for their role line.
  const tagline = String(manifest.description ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(/[.!?]\s/)[0]
    .slice(0, 140);

  return {
    id:          workflowId,
    name:        `${ manifest.name ?? slug } · new routine`,
    description: manifest.description ?? `Workflow based on the ${ slug } template.`,
    version:     '0.1.0',
    enabled:     true,
    createdAt:   now,
    updatedAt:   now,
    _status:     'draft',
    nodes: [
      {
        id:       triggerId,
        type:     'routine',
        position: { x: 80, y: 140 },
        data:     {
          subtype:  'manual-trigger',
          category: 'trigger',
          title:    'Manual Trigger',
          kicker:   'Trigger',
          role:     'Fires when the user runs this routine.',
        },
      },
      {
        id:       routineId,
        type:     'routine',
        position: { x: 400, y: 140 },
        data:     {
          // Category is 'agent' because that's the canonical type for
          // "something that does work" in the workflow runtime — lets
          // the display pipeline assign proper avatar colors + code
          // letters. The `subtype` + `kicker` preserve the "routine"
          // identity at the display layer.
          subtype:      'template-routine',
          category:     'agent',
          title:        manifest.name ?? slug,
          kicker:       'Routine',
          role:         tagline || `Executes the ${ slug } template.`,
          quote:        manifest.category ? `"${ manifest.section ?? 'Core' } · ${ manifest.category }"` : undefined,
          templateSlug: slug,
          templateId:   manifest.id ?? null,
          config:       {}, // user fills in required inputs via the config panel
        },
      },
    ],
    edges: [
      {
        id:     newId('edge'),
        source: triggerId,
        target: routineId,
        type:   'smoothstep',
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
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
      const manifestPath = path.join(root, entry.name, 'routine.yaml');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = readManifest(manifestPath);
      if (!manifest) continue;
      summaries.push(toSummary(entry.name, manifest));
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

    const workflow = buildWorkflowFromTemplate({ slug, manifest });

    // DB-first write. The runtime still scans disk for execution, so a
    // YAML materialization will happen when the user hits save in the
    // editor (Phase 4 — workflow-save handler dual-writes disk + DB).
    const WorkflowModel = await importWorkflowModel();

    await WorkflowModel.upsertFromDefinition(workflow, {
      status:       'draft',
      changeReason: `instantiated from template:${ slug }`,
    });

    console.log(`[Sulla] Instantiated template "${ slug }" as workflow "${ workflow.id }"`);

    return { id: workflow.id as string, name: workflow.name as string };
  });

  // ── Direct routine execution ──
  // Previously a routine was kicked off by sending a chat message like
  // "Let's run X" — the agent parsed it, called the execute_workflow
  // tool, and that tool primed the playbook. This handler drops the
  // chat step entirely: it spins up a fresh agent graph on the default
  // `sulla-desktop` channel, primes the playbook with
  // `activateWorkflowOnState`, and kicks the graph loop. The agent is
  // still the orchestrator — we're just removing the natural-language
  // handoff from the trigger path.
  ipcMainProxy.handle('routines-execute', async(_event: unknown, workflowId: string, triggerPayload?: string) => {
    if (!workflowId) {
      throw new Error('routines-execute: workflowId is required');
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
  });

  console.log('[Sulla] Routine template IPC handlers initialized');
}
