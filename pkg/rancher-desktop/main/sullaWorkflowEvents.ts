/**
 * Workflow IPC event handlers for the visual workflow editor.
 * Manages CRUD operations and execution for workflow definitions stored as YAML files.
 */

import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

import { BrowserWindow } from 'electron';

import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';
import type { WorkflowExecutionEvent, WorkflowRunState } from '@pkg/agent/workflow/types';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

// ── Active execution registry ──

interface ActiveExecution {
  executor: InstanceType<typeof import('@pkg/agent/workflow/WorkflowExecutor').WorkflowExecutor>;
  runState?: WorkflowRunState;
}

const activeExecutions = new Map<string, ActiveExecution>();

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

  // ── Execution handlers ──

  // Execute a workflow — returns executionId immediately, sends events via WebSocket
  ipcMainProxy.handle('workflow-execute', async(_event: unknown, workflowId: string, triggerPayload: unknown) => {
    const filePath = resolveWorkflowPath(getWorkflowsDir(), workflowId);

    if (!filePath) {
      throw new Error(`Workflow not found: ${ workflowId }`);
    }

    const definition: WorkflowDefinition = parseWorkflowFile(filePath);

    // Dynamic import to avoid bundling workflow engine into renderer
    const { WorkflowExecutor } = await import('@pkg/agent/workflow/WorkflowExecutor');
    const { getWebSocketClientService } = await import('@pkg/agent/services/WebSocketClientService');

    const wsService = getWebSocketClientService();

    const emitEvent = (partial: Omit<WorkflowExecutionEvent, 'executionId' | 'workflowId' | 'timestamp'>) => {
      const event: WorkflowExecutionEvent = {
        ...partial,
        executionId: executor.id,
        workflowId,
        timestamp: new Date().toISOString(),
      };

      // Send via WebSocket on a dedicated channel for this execution
      const channel = `workflow-exec-${ executor.id }`;
      wsService.send(channel, {
        type: 'workflow_execution_event',
        data: event,
        id:   `${ event.type }-${ event.nodeId || 'workflow' }-${ Date.now() }`,
      }).catch(() => {});

      // Send to renderer process(es) via IPC
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(`workflow-execution-event-${ executor.id }`, event);
      }
    };

    const executor = new WorkflowExecutor(definition, triggerPayload, { emitEvent });
    const executionId = executor.id;

    activeExecutions.set(executionId, { executor });

    // Run in the background — don't await
    executor.execute().then((runState) => {
      const entry = activeExecutions.get(executionId);
      if (entry) {
        entry.runState = runState;
      }
      // Clean up after 5 minutes
      setTimeout(() => activeExecutions.delete(executionId), 5 * 60 * 1000);
    }).catch((err) => {
      console.error(`[Sulla] Workflow execution failed: ${ executionId }`, err);
      setTimeout(() => activeExecutions.delete(executionId), 5 * 60 * 1000);
    });

    console.log(`[Sulla] Workflow execution started: ${ workflowId } -> ${ executionId }`);

    return { executionId };
  });

  // Get execution status
  ipcMainProxy.handle('workflow-execution-status', async(_event: unknown, executionId: string) => {
    const entry = activeExecutions.get(executionId);
    if (!entry) {
      return null;
    }

    if (entry.runState) {
      return {
        executionId,
        status:      entry.runState.status,
        startedAt:   entry.runState.startedAt,
        completedAt: entry.runState.completedAt,
        error:       entry.runState.error,
      };
    }

    return { executionId, status: 'running' };
  });

  // Abort a running execution
  ipcMainProxy.handle('workflow-execution-abort', async(_event: unknown, executionId: string) => {
    const entry = activeExecutions.get(executionId);
    if (entry) {
      entry.executor.abort();
      console.log(`[Sulla] Workflow execution aborted: ${ executionId }`);

      return true;
    }

    return false;
  });

  // Resume a paused execution (user-input node)
  ipcMainProxy.handle('workflow-execution-resume', async(_event: unknown, executionId: string, nodeId: string, userData: unknown) => {
    const entry = activeExecutions.get(executionId);
    if (entry) {
      entry.executor.resume(nodeId, userData);
      console.log(`[Sulla] Workflow execution resumed: ${ executionId } node ${ nodeId }`);

      return true;
    }

    return false;
  });

  // ── Registry dispatch handler ──
  // Used by external trigger sources (calendar, chat apps, heartbeat, API)
  // to route a message to the right workflow based on trigger type.
  ipcMainProxy.handle('workflow-dispatch', async(
    _event: unknown,
    triggerType: string,
    message: string,
    workflowId?: string,
  ) => {
    const { getWorkflowRegistry } = await import('@pkg/agent/workflow/WorkflowRegistry');
    const registry = getWorkflowRegistry();

    const emitEvent = (partial: Omit<WorkflowExecutionEvent, 'executionId' | 'workflowId' | 'timestamp'>) => {
      // Build the full event — executionId/workflowId will be filled by the executor
      const event: WorkflowExecutionEvent = {
        ...partial,
        executionId: '',
        workflowId:  '',
        timestamp:   new Date().toISOString(),
      };

      // Send to renderer
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('workflow-dispatch-event', event);
      }
    };

    const result = await registry.dispatch({
      triggerType: triggerType as any,
      message,
      workflowId,
      emitEvent,
    });

    if (!result) {
      console.log(`[Sulla] No workflow matched for trigger: ${ triggerType }`);

      return null;
    }

    // Track the execution
    activeExecutions.set(result.executionId, { executor: result.executor });
    setTimeout(() => activeExecutions.delete(result.executionId), 5 * 60 * 1000);

    console.log(`[Sulla] Dispatched "${ message.slice(0, 80) }" -> workflow "${ result.workflowName }"`);

    return {
      executionId:  result.executionId,
      workflowId:   result.workflowId,
      workflowName: result.workflowName,
    };
  });

  console.log('[Sulla] Workflow IPC event handlers initialized');
}
