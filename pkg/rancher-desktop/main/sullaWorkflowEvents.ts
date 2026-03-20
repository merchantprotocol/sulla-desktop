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
import Logging from '@pkg/utils/logging';

import type { WorkflowDefinition, WorkflowStatus } from '@pkg/pages/editor/workflow/types';

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

  // Save (create or update) a workflow — saves in-place if exists, otherwise to draft/
  ipcMainProxy.handle('workflow-save', async(_event: unknown, workflow: any) => {
    workflow.updatedAt = new Date().toISOString();
    if (!workflow.createdAt) {
      workflow.createdAt = workflow.updatedAt;
    }

    // Strip runtime execution state from nodes before persisting —
    // execution state belongs in PostgreSQL (workflow_checkpoints table),
    // not in the YAML definition file. Writing it here corrupts config edits.
    if (Array.isArray(workflow.nodes)) {
      for (const node of workflow.nodes) {
        if (node.data?.execution) {
          delete node.data.execution;
        }
      }
    }

    // Find existing file to determine which subfolder it's in
    const existing = findWorkflowFileInSubfolders(workflow.id);
    const targetDir = existing ? path.dirname(existing.filePath) : getSubfolderDirs().draft;

    fs.mkdirSync(targetDir, { recursive: true });

    // Remove old file if it exists under a different name (handles renames)
    const newFilePath = path.join(targetDir, `${ slugifyWorkflowName(workflow.name) }.yaml`);

    if (existing && existing.filePath !== newFilePath) {
      fs.unlinkSync(existing.filePath);
      console.log(`[Sulla] Workflow renamed: ${ path.basename(existing.filePath) } -> ${ path.basename(newFilePath) }`);
    }

    fs.writeFileSync(newFilePath, yaml.stringify(workflow, { lineWidth: 0 }), 'utf-8');

    console.log(`[Sulla] Workflow saved: ${ path.basename(newFilePath) } (id: ${ workflow.id })`);

    // Refresh workflow schedules in case a schedule trigger was added/changed
    refreshWorkflowSchedules();

    return true;
  });

  // Delete a workflow (searches all subfolders)
  ipcMainProxy.handle('workflow-delete', async(_event: unknown, workflowId: string) => {
    const found = findWorkflowFileInSubfolders(workflowId);

    if (found) {
      fs.unlinkSync(found.filePath);
      console.log(`[Sulla] Workflow deleted: ${ path.basename(found.filePath) } (id: ${ workflowId })`);
    } else {
      console.log(`[Sulla] Workflow not found for deletion: ${ workflowId }`);
    }

    refreshWorkflowSchedules();

    return true;
  });

  // Move a workflow between subfolders (draft ↔ production ↔ archive)
  ipcMainProxy.handle('workflow-move', async(_event: unknown, workflowId: string, targetStatus: WorkflowStatus) => {
    const found = findWorkflowFileInSubfolders(workflowId);

    if (!found) {
      throw new Error(`Workflow not found: ${ workflowId }`);
    }

    if (found.status === targetStatus) {
      return { success: true, newStatus: targetStatus };
    }

    const targetDir = getSubfolderDirs()[targetStatus];
    fs.mkdirSync(targetDir, { recursive: true });

    const newFilePath = path.join(targetDir, path.basename(found.filePath));
    fs.renameSync(found.filePath, newFilePath);

    console.log(`[Sulla] Workflow moved: ${ path.basename(found.filePath) } (${ found.status } -> ${ targetStatus })`);

    // Refresh schedules when workflows move to/from production
    refreshWorkflowSchedules();

    return { success: true, newStatus: targetStatus };
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
