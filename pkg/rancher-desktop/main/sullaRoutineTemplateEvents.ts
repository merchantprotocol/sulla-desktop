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

    const workflow = buildWorkflowFromTemplate({ slug, manifest });

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

  console.log('[Sulla] Routine template IPC handlers initialized');
}
