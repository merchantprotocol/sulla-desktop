/**
 * Workflow IPC event handlers for the visual workflow editor.
 * Manages CRUD operations for workflow definitions stored as YAML files
 * in three subfolders: draft/, production/, archive/.
 *
 * Workflow execution is handled by the agent's graph loop via WorkflowPlaybook —
 * not by these IPC handlers. The frontend triggers workflows by sending messages
 * to the agent (via execute_workflow tool).
 */

import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import type { WorkflowDefinition, WorkflowStatus } from '@pkg/pages/editor/workflow/types';
import Logging from '@pkg/utils/logging';

/**
 * Dynamically import the Postgres-backed WorkflowModel.
 * Kept as a dynamic import so the main process doesn't eagerly pull in the DB layer
 * at startup — matches the pattern used for WorkflowSchedulerService.
 */
async function importWorkflowModel() {
  const mod = await import('@pkg/agent/database/models/WorkflowModel');

  return mod.WorkflowModel;
}

async function importWorkflowHistoryModel() {
  const mod = await import('@pkg/agent/database/models/WorkflowHistoryModel');

  return mod.WorkflowHistoryModel;
}

const console = Logging.background;

/**
 * Refresh WorkflowSchedulerService schedules.
 * Uses dynamic import to avoid bundling the service into the main process at startup.
 */
function refreshWorkflowSchedules(): void {
  import('@pkg/agent/services/WorkflowSchedulerService')
    .then(({ getWorkflowSchedulerService }) => {
      getWorkflowSchedulerService().refresh();
    })
    .catch((err) => {
      console.warn('[Sulla] Failed to refresh workflow schedules:', err);
    });
}
const ipcMainProxy = getIpcMainProxy(console);

const WORKFLOW_SUBFOLDERS: WorkflowStatus[] = ['draft', 'production', 'archive'];

function getWorkflowsDir(): string {
  const { resolveSullaWorkflowsDir } = require('@pkg/agent/utils/sullaPaths');

  return resolveSullaWorkflowsDir();
}

function getSubfolderDirs(): Record<WorkflowStatus, string> {
  const root = getWorkflowsDir();

  return {
    draft:      path.join(root, 'draft'),
    production: path.join(root, 'production'),
    archive:    path.join(root, 'archive'),
  };
}

/**
 * Convert a workflow name to a filesystem-safe slug.
 * e.g. "Blog Production Pipeline" → "blog-production-pipeline"
 */
function slugifyWorkflowName(name: string): string {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'workflow';
}

/**
 * Parse a workflow file (YAML or JSON based on extension).
 */
function parseWorkflowFile(filePath: string): any {
  const raw = fs.readFileSync(filePath, 'utf-8');

  return filePath.endsWith('.json') ? JSON.parse(raw) : yaml.parse(raw);
}

/**
 * Check if a directory entry is a workflow file (.yaml or legacy .json).
 */
function isWorkflowFile(entry: fs.Dirent): boolean {
  return entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.json'));
}

/**
 * Extract workflow ID from filename (strip extension).
 */
function workflowIdFromFilename(name: string): string {
  return name.replace(/\.(yaml|json)$/, '');
}

/**
 * Find a workflow file by its internal id field in a single directory.
 * Returns the file path or null.
 */
function findWorkflowFileById(dir: string, workflowId: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!isWorkflowFile(entry)) continue;
    try {
      const filePath = path.join(dir, entry.name);
      const parsed = parseWorkflowFile(filePath);

      if (parsed.id === workflowId) return filePath;
    } catch { /* skip unparseable files */ }
  }

  return null;
}

/**
 * Find a workflow file across all three subfolders.
 * Returns { filePath, status } or null.
 */
function findWorkflowFileInSubfolders(workflowId: string): { filePath: string; status: WorkflowStatus } | null {
  const dirs = getSubfolderDirs();

  for (const status of WORKFLOW_SUBFOLDERS) {
    const filePath = findWorkflowFileById(dirs[status], workflowId);
    if (filePath) return { filePath, status };
  }

  return null;
}

export function initSullaWorkflowEvents(): void {
  // Ensure subfolders exist
  const dirs = getSubfolderDirs();
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // List all workflows from all subfolders (returns array of { id, name, updatedAt, status })
  ipcMainProxy.handle('workflow-list', async() => {
    const dirs = getSubfolderDirs();
    const workflows: { id: string; name: string; updatedAt: string; status: WorkflowStatus }[] = [];

    for (const status of WORKFLOW_SUBFOLDERS) {
      const dir = dirs[status];
      if (!fs.existsSync(dir)) continue;

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!isWorkflowFile(entry)) continue;
        try {
          const filePath = path.join(dir, entry.name);
          const parsed = parseWorkflowFile(filePath);

          workflows.push({
            id:        parsed.id || workflowIdFromFilename(entry.name),
            name:      parsed.name || workflowIdFromFilename(entry.name),
            updatedAt: parsed.updatedAt || '',
            status,
          });
        } catch (err) {
          console.error(`[Sulla] Failed to parse workflow file ${ entry.name }:`, err);
        }
      }
    }

    return workflows;
  });

  // Get a single workflow by ID (searches all subfolders)
  ipcMainProxy.handle('workflow-get', async(_event: unknown, workflowId: string) => {
    const found = findWorkflowFileInSubfolders(workflowId);

    if (!found) {
      throw new Error(`Workflow not found: ${ workflowId }`);
    }

    const definition = parseWorkflowFile(found.filePath);
    definition._status = found.status;

    return definition;
  });

  // ── Workflow mutations — DB-only ──
  // YAML files were removed in the Phase 1 cutover. Postgres is the only
  // writer now; the runtime (Phase 2) queries the workflows table directly.
  // Errors propagate to the caller — we don't log-and-swallow any more
  // because there's no redundant path left to hide behind.

  ipcMainProxy.handle('workflow-save', async(_event: unknown, workflow: any) => {
    if (!workflow?.id) {
      throw new Error('workflow-save: workflow.id is required');
    }

    workflow.updatedAt = new Date().toISOString();
    if (!workflow.createdAt) {
      workflow.createdAt = workflow.updatedAt;
    }

    // Strip runtime execution state from nodes before persisting —
    // execution state belongs in workflow_checkpoints, not in the
    // definition JSONB. Writing it here corrupts config edits.
    if (Array.isArray(workflow.nodes)) {
      for (const node of workflow.nodes) {
        if (node.data?.execution) {
          delete node.data.execution;
        }
      }
    }

    const WorkflowModel = await importWorkflowModel();
    // Let the model reuse the row's existing status when this is an
    // update; only brand-new rows default to 'draft' via upsertFromDefinition.
    const existing = await WorkflowModel.findById(workflow.id);
    const status = (existing?.attributes.status ?? workflow._status ?? 'draft') as WorkflowStatus;

    await WorkflowModel.upsertFromDefinition(workflow, { status });

    console.log(`[Sulla] Workflow saved: ${ workflow.name ?? workflow.id } (id: ${ workflow.id }, status: ${ status })`);

    // Kick the scheduler — Phase 2 rewrites this to read from the DB too.
    refreshWorkflowSchedules();

    return true;
  });

  ipcMainProxy.handle('workflow-delete', async(_event: unknown, workflowId: string) => {
    if (!workflowId) throw new Error('workflow-delete: workflowId is required');

    const WorkflowModel = await importWorkflowModel();
    const deleted = await WorkflowModel.deleteById(workflowId);

    if (deleted) {
      console.log(`[Sulla] Workflow deleted: ${ workflowId }`);
    } else {
      console.log(`[Sulla] Workflow not found for deletion: ${ workflowId }`);
    }

    refreshWorkflowSchedules();

    return deleted;
  });

  ipcMainProxy.handle('workflow-move', async(_event: unknown, workflowId: string, targetStatus: WorkflowStatus) => {
    if (!workflowId) throw new Error('workflow-move: workflowId is required');

    const WorkflowModel = await importWorkflowModel();
    const updated = await WorkflowModel.updateStatus(workflowId, targetStatus);

    if (!updated) {
      throw new Error(`Workflow not found: ${ workflowId }`);
    }

    console.log(`[Sulla] Workflow moved: ${ workflowId } -> ${ targetStatus }`);

    // Schedules care about the draft/production boundary — refresh.
    refreshWorkflowSchedules();

    return { success: true, newStatus: targetStatus };
  });

  // Duplicate an existing workflow. Copies its definition into a fresh
  // id with " (copy)" appended to the name; always lands in draft.
  ipcMainProxy.handle('workflow-duplicate', async(_event: unknown, workflowId: string) => {
    if (!workflowId) throw new Error('workflow-duplicate: workflowId is required');

    const WorkflowModel = await importWorkflowModel();
    const original = await WorkflowModel.findById(workflowId);

    if (!original) {
      throw new Error(`Workflow not found: ${ workflowId }`);
    }

    const originalDef = original.attributes.definition as Record<string, unknown>;
    const newId = `workflow-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 8) }`;
    const now = new Date().toISOString();

    const duplicate: Record<string, unknown> = {
      ...originalDef,
      id:        newId,
      name:      `${ String(originalDef.name ?? original.attributes.name ?? 'Untitled') } (copy)`,
      createdAt: now,
      updatedAt: now,
      _status:   'draft',
    };

    await WorkflowModel.upsertFromDefinition(duplicate, {
      status:       'draft',
      changeReason: `duplicated from ${ workflowId }`,
    });

    console.log(`[Sulla] Workflow duplicated: ${ workflowId } -> ${ newId }`);

    refreshWorkflowSchedules();

    return { id: newId, name: duplicate.name as string };
  });

  // ── DB-backed read handlers (Phase 1 verification path) ──
  // These read from Postgres directly, bypassing the filesystem. Used to verify
  // the dual-write from workflow-save lands correctly. YAML handlers above remain
  // the primary read path until Phase 2 cuts reads over to the DB.

  ipcMainProxy.handle('workflow-db-list', async() => {
    // Do NOT swallow errors here — returning [] silently makes the
    // playbill look empty when the real problem is a broken query or a
    // dead DB connection. The renderer catches into useRoutines.error
    // and can surface a diagnostic to the user.
    const WorkflowModel = await importWorkflowModel();

    return WorkflowModel.listAll();
  });

  ipcMainProxy.handle('workflow-db-get', async(_event: unknown, workflowId: string) => {
    try {
      const WorkflowModel = await importWorkflowModel();
      const model = await WorkflowModel.findById(workflowId);

      if (!model) return null;

      const definition = model.attributes.definition as Record<string, unknown>;

      return {
        ...definition,
        _status: model.attributes.status,
      };
    } catch (err) {
      console.warn('[Sulla] workflow-db-get failed:', err);

      return null;
    }
  });

  ipcMainProxy.handle('workflow-history-get', async(_event: unknown, workflowId: string, limit?: number) => {
    try {
      const WorkflowHistoryModel = await importWorkflowHistoryModel();
      const rows = await WorkflowHistoryModel.findByWorkflow(workflowId, limit ?? 50);

      return rows.map(r => ({
        id:                r.attributes.id!,
        workflowId:        r.attributes.workflow_id!,
        changedBy:         r.attributes.changed_by ?? null,
        changeReason:      r.attributes.change_reason ?? null,
        createdAt:         r.attributes.created_at instanceof Date
          ? r.attributes.created_at.toISOString()
          : String(r.attributes.created_at ?? ''),
        definitionBefore:  r.attributes.definition_before ?? null,
        definitionAfter:   r.attributes.definition_after ?? null,
      }));
    } catch (err) {
      console.warn('[Sulla] workflow-history-get failed:', err);

      return [];
    }
  });

  // ── Registry dispatch handler ──
  // Used by external trigger sources (calendar, chat apps, heartbeat, API)
  // to find the right workflow based on trigger type.
  // Returns the definition — execution happens through the agent's graph loop.
  ipcMainProxy.handle('workflow-dispatch', async(
    _event: unknown,
    triggerType: string,
    message: string,
    workflowId?: string,
  ) => {
    const { getWorkflowRegistry } = await import('@pkg/agent/workflow/WorkflowRegistry');
    const registry = getWorkflowRegistry();

    const result = await registry.dispatch({
      triggerType: triggerType as any,
      message,
      workflowId,
    });

    if (!result) {
      console.log(`[Sulla] No workflow matched for trigger: ${ triggerType }`);

      return null;
    }

    console.log(`[Sulla] Dispatched "${ message.slice(0, 80) }" -> workflow "${ result.workflowName }"`);

    return {
      executionId:  `wfd-${ Date.now() }-${ Math.random().toString(36).slice(2, 8) }`,
      workflowId:   result.workflowId,
      workflowName: result.workflowName,
    };
  });

  // ── File change watching ──
  // Watches workflow directories for changes and notifies the renderer.
  let watcher: fs.FSWatcher | null = null;

  ipcMainProxy.handle('workflow-watch-start', async() => {
    if (watcher) return true;

    const root = getWorkflowsDir();
    const { BrowserWindow } = await import('electron');

    function notifyRenderer() {
      const wins = BrowserWindow.getAllWindows();
      for (const win of wins) {
        win.webContents.send('workflow-files-changed');
      }
    }

    // Debounce to avoid rapid-fire events
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    function debouncedNotify() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(notifyRenderer, 500);
    }

    // Watch all three subfolders
    for (const status of WORKFLOW_SUBFOLDERS) {
      const dir = path.join(root, status);
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.watch(dir, { persistent: false }, debouncedNotify);
      } catch (err) {
        console.warn(`[Sulla] Failed to watch ${ dir }:`, err);
      }
    }

    watcher = {} as fs.FSWatcher; // sentinel
    console.log('[Sulla] Workflow file watcher started');

    return true;
  });

  ipcMainProxy.handle('workflow-watch-stop', async() => {
    watcher = null;

    return true;
  });

  // Check if a workflow file on disk differs from what the editor has.
  // Returns { changed: boolean, diskUpdatedAt: string } so the renderer can decide.
  ipcMainProxy.handle('workflow-check-updated', async(_event: unknown, workflowId: string, editorUpdatedAt: string) => {
    const found = findWorkflowFileInSubfolders(workflowId);

    if (!found) return { changed: false, diskUpdatedAt: '' };

    try {
      const parsed = parseWorkflowFile(found.filePath);
      const diskUpdatedAt = parsed.updatedAt || '';
      const changed = diskUpdatedAt !== editorUpdatedAt;

      return { changed, diskUpdatedAt };
    } catch {
      return { changed: false, diskUpdatedAt: '' };
    }
  });

  console.log('[Sulla] Workflow IPC event handlers initialized');
}
