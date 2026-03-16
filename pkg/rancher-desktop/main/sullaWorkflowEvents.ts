/**
 * Workflow IPC event handlers for the visual workflow editor.
 * Manages CRUD operations for workflow definitions stored as YAML files.
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

import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

function getWorkflowsDir(): string {
  const { resolveSullaWorkflowsDir } = require('@pkg/agent/utils/sullaPaths');

  return resolveSullaWorkflowsDir();
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
 * Find a workflow file by its internal id field (scans all files in directory).
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

export function initSullaWorkflowEvents(): void {
  // List all workflows (returns array of { id, name, updatedAt })
  ipcMainProxy.handle('workflow-list', async() => {
    const dir = getWorkflowsDir();

    if (!fs.existsSync(dir)) {
      return [];
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const workflows: { id: string; name: string; updatedAt: string }[] = [];

    for (const entry of entries) {
      if (!isWorkflowFile(entry)) {
        continue;
      }
      try {
        const filePath = path.join(dir, entry.name);
        const parsed = parseWorkflowFile(filePath);

        workflows.push({
          id:        parsed.id || workflowIdFromFilename(entry.name),
          name:      parsed.name || workflowIdFromFilename(entry.name),
          updatedAt: parsed.updatedAt || '',
        });
      } catch (err) {
        console.error(`[Sulla] Failed to parse workflow file ${ entry.name }:`, err);
      }
    }

    return workflows;
  });

  // Get a single workflow by ID (scans by internal id since filenames are name-slugs)
  ipcMainProxy.handle('workflow-get', async(_event: unknown, workflowId: string) => {
    const dir = getWorkflowsDir();
    const filePath = findWorkflowFileById(dir, workflowId);

    if (!filePath) {
      throw new Error(`Workflow not found: ${ workflowId }`);
    }

    return parseWorkflowFile(filePath);
  });

  // Save (create or update) a workflow — filename is derived from the workflow name slug
  ipcMainProxy.handle('workflow-save', async(_event: unknown, workflow: any) => {
    const dir = getWorkflowsDir();

    fs.mkdirSync(dir, { recursive: true });
    workflow.updatedAt = new Date().toISOString();
    if (!workflow.createdAt) {
      workflow.createdAt = workflow.updatedAt;
    }

    // Remove old file if it exists under a different name (handles renames)
    const oldPath = findWorkflowFileById(dir, workflow.id);
    const newFilePath = path.join(dir, `${ slugifyWorkflowName(workflow.name) }.yaml`);

    if (oldPath && oldPath !== newFilePath) {
      fs.unlinkSync(oldPath);
      console.log(`[Sulla] Workflow renamed: ${ path.basename(oldPath) } -> ${ path.basename(newFilePath) }`);
    }

    fs.writeFileSync(newFilePath, yaml.stringify(workflow, { lineWidth: 0 }), 'utf-8');

    console.log(`[Sulla] Workflow saved: ${ path.basename(newFilePath) } (id: ${ workflow.id })`);

    return true;
  });

  // Delete a workflow (finds file by internal id)
  ipcMainProxy.handle('workflow-delete', async(_event: unknown, workflowId: string) => {
    const dir = getWorkflowsDir();
    const filePath = findWorkflowFileById(dir, workflowId);

    if (filePath) {
      fs.unlinkSync(filePath);
      console.log(`[Sulla] Workflow deleted: ${ path.basename(filePath) } (id: ${ workflowId })`);
    } else {
      console.log(`[Sulla] Workflow not found for deletion: ${ workflowId }`);
    }

    return true;
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

  console.log('[Sulla] Workflow IPC event handlers initialized');
}
