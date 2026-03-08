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
 * Resolve workflow file path — prefers .yaml, falls back to legacy .json.
 */
function resolveWorkflowPath(dir: string, workflowId: string): string | null {
  const yamlPath = path.join(dir, `${ workflowId }.yaml`);

  if (fs.existsSync(yamlPath)) return yamlPath;
  const jsonPath = path.join(dir, `${ workflowId }.json`);

  if (fs.existsSync(jsonPath)) return jsonPath;

  return null;
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

  // Get a single workflow by ID
  ipcMainProxy.handle('workflow-get', async(_event: unknown, workflowId: string) => {
    const filePath = resolveWorkflowPath(getWorkflowsDir(), workflowId);

    if (!filePath) {
      throw new Error(`Workflow not found: ${ workflowId }`);
    }

    return parseWorkflowFile(filePath);
  });

  // Save (create or update) a workflow
  ipcMainProxy.handle('workflow-save', async(_event: unknown, workflow: any) => {
    const dir = getWorkflowsDir();

    fs.mkdirSync(dir, { recursive: true });
    workflow.updatedAt = new Date().toISOString();
    if (!workflow.createdAt) {
      workflow.createdAt = workflow.updatedAt;
    }

    const filePath = path.join(dir, `${ workflow.id }.yaml`);

    fs.writeFileSync(filePath, yaml.stringify(workflow, { lineWidth: 0 }), 'utf-8');

    // Remove legacy .json file if it exists
    const legacyPath = path.join(dir, `${ workflow.id }.json`);

    if (fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
    }

    console.log(`[Sulla] Workflow saved: ${ workflow.id }`);

    return true;
  });

  // Delete a workflow
  ipcMainProxy.handle('workflow-delete', async(_event: unknown, workflowId: string) => {
    const dir = getWorkflowsDir();

    for (const ext of ['.yaml', '.json']) {
      const filePath = path.join(dir, `${ workflowId }${ ext }`);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    console.log(`[Sulla] Workflow deleted: ${ workflowId }`);

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
