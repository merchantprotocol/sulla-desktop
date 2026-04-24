/**
 * WorkflowRecoveryService
 *
 * Handles two lifecycle hooks:
 *
 *  1. gracefulShutdown() — called from sullaEnd() before the DB closes.
 *     Marks every 'running' execution as 'suspended' so boot recovery can
 *     find them on next startup.
 *
 *  2. recoverOnBoot() — called from initSullaEvents() after DB is ready.
 *     Finds all 'suspended' executions and:
 *       • auto_restart = true  → re-activates via the heartbeat graph immediately
 *       • auto_restart = false → stores in pendingSuspended[] for the IPC caller
 *                                to surface to the user
 */

import Logging from '@pkg/utils/logging';

const console = Logging.background;

export interface SuspendedExecution {
  executionId:  string;
  workflowId:   string;
  workflowName: string;
  workflowSlug: string;
  startedAt:    string;
  autoRestart:  boolean;
}

/** Non-auto-restart executions waiting for user decision. Cleared once read. */
let pendingSuspended: SuspendedExecution[] = [];

/** Called from initSullaEvents (main process) after the DB is ready. */
export async function recoverOnBoot(): Promise<void> {
  try {
    const { WorkflowExecutionModel } = await import('../database/models/WorkflowExecutionModel');
    const suspended = await WorkflowExecutionModel.findSuspended();

    if (suspended.length === 0) {
      console.log('[WorkflowRecovery] No suspended executions found — nothing to recover.');
      return;
    }

    console.log(`[WorkflowRecovery] Found ${ suspended.length } suspended execution(s) to recover.`);

    const autoRestarts: SuspendedExecution[] = [];
    const manualResumes: SuspendedExecution[] = [];

    for (const exec of suspended) {
      const a = exec.attributes as any;
      const entry: SuspendedExecution = {
        executionId:  a.execution_id,
        workflowId:   a.workflow_id,
        workflowName: a.workflow_name || a.workflow_id,
        workflowSlug: a.workflow_slug || a.workflow_id,
        startedAt:    a.started_at instanceof Date ? a.started_at.toISOString() : String(a.started_at),
        autoRestart:  a.auto_restart !== false,  // default true — opt-out, not opt-in
      };

      if (entry.autoRestart) {
        autoRestarts.push(entry);
      } else {
        manualResumes.push(entry);
      }
    }

    // Store manual-resume entries for IPC query
    pendingSuspended = manualResumes;

    // Auto-restart: activate each via the heartbeat graph
    if (autoRestarts.length > 0) {
      setImmediate(() => _triggerAutoRestarts(autoRestarts));
    }

    if (manualResumes.length > 0) {
      console.log(`[WorkflowRecovery] ${ manualResumes.length } workflow(s) need manual resume: ${ manualResumes.map(e => e.workflowName).join(', ') }`);
    }
  } catch (err) {
    console.error('[WorkflowRecovery] recoverOnBoot failed:', err);
  }
}

/** Return and clear the list of pending manual-resume executions. */
export function getPendingSuspended(): SuspendedExecution[] {
  const copy = [...pendingSuspended];
  pendingSuspended = [];
  return copy;
}

/** Called from sullaEnd() before DB connections are closed. */
export async function gracefulShutdown(): Promise<void> {
  try {
    const { WorkflowExecutionModel } = await import('../database/models/WorkflowExecutionModel');
    const suspended = await WorkflowExecutionModel.suspendAllRunning();

    if (suspended.length > 0) {
      console.log(`[WorkflowRecovery] Suspended ${ suspended.length } running workflow(s) for boot recovery: ${ suspended.join(', ') }`);
    }
  } catch (err) {
    console.error('[WorkflowRecovery] gracefulShutdown failed:', err);
  }
}

async function _triggerAutoRestarts(executions: SuspendedExecution[]): Promise<void> {
  try {
    const { GraphRegistry }         = await import('../services/GraphRegistry');
    const { activateWorkflowOnState } = await import('../tools/workflow/execute_workflow');

    for (const exec of executions) {
      try {
        console.log(`[WorkflowRecovery] Auto-restarting "${ exec.workflowName }" (executionId: ${ exec.executionId })`);

        const { state } = await GraphRegistry.getOrCreateOverlordGraph(
          'heartbeat',
          `[Recovery] Auto-restarting workflow "${ exec.workflowName }" that was interrupted on last shutdown.`,
        );

        const result = await activateWorkflowOnState(state, {
          workflowId:        exec.workflowSlug,
          resumeExecutionId: exec.executionId,
        });

        if (result.ok) {
          console.log(`[WorkflowRecovery] Auto-restart activated: ${ exec.workflowName }`);
        } else {
          console.warn(`[WorkflowRecovery] Auto-restart failed for "${ exec.workflowName }": ${ result.responseString }`);
        }
      } catch (err) {
        console.error(`[WorkflowRecovery] Auto-restart error for "${ exec.executionId }":`, err);
      }
    }
  } catch (err) {
    console.error('[WorkflowRecovery] _triggerAutoRestarts failed:', err);
  }
}
