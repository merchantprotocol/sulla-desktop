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
/** Manual-resume executions the user has already been told about. */
const notifiedManualResumes = new Set<string>();

/**
 * A suspended run that needs a manual decision also blocks every future run
 * of a singleton routine. getPendingSuspended() has no caller, so these used
 * to wait silently forever (a scheduled routine went dark for 9+ hours).
 * Tell the user once per execution.
 */
async function notifyManualResumes(executions: SuspendedExecution[]): Promise<void> {
  const fresh = executions.filter(e => !notifiedManualResumes.has(e.executionId));
  if (fresh.length === 0) return;
  for (const exec of fresh) notifiedManualResumes.add(exec.executionId);
  console.warn(`[WorkflowRecovery] ${ fresh.length } workflow run(s) paused and waiting for you: ${ fresh.map(e => `${ e.workflowName } (${ e.executionId })`).join(', ') }`);
  try {
    const { getChromeApi } = await import('@pkg/main/chromeApi/ChromeApiService');
    for (const exec of fresh) {
      await getChromeApi().notifications.create(`workflow-paused-${ exec.executionId }`, {
        title:   `Routine paused: ${ exec.workflowName }`,
        message: 'It stopped mid-run and needs a decision before it can run again. Open Routines to resume or stop it.',
      });
    }
  } catch (err) {
    console.warn('[WorkflowRecovery] could not show paused-routine notification:', err);
  }
}
let leaseRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
/** Re-check interval when the earliest lease is already expired but unclaimable. */
const STALE_RECHECK_MS = 30_000;

async function scheduleNextLeaseRecovery(WorkflowExecutionModel: any): Promise<void> {
  const next = await WorkflowExecutionModel.nextLeaseExpiry();
  if (!next) return;
  if (leaseRecoveryTimer) clearTimeout(leaseRecoveryTimer);
  // A lease that is ALREADY expired right after a recovery pass is one this
  // pass could not claim (another worker holds it, or it's not ours to
  // recover). Re-check at a sane pace instead of spinning every second.
  const untilExpiry = next.getTime() - Date.now();
  const delay = untilExpiry <= 0 ? STALE_RECHECK_MS : Math.max(1_000, untilExpiry + 250);
  leaseRecoveryTimer = setTimeout(() => {
    leaseRecoveryTimer = null;
    void recoverOnBoot();
  }, delay);
  (leaseRecoveryTimer as any).unref?.();
}

/** Called from initSullaEvents (main process) after the DB is ready. */
export async function recoverOnBoot(): Promise<void> {
  try {
    const { WorkflowExecutionModel } = await import('../database/models/WorkflowExecutionModel');
    const stale = await WorkflowExecutionModel.findStaleExecutions();
    const recovered = [] as SuspendedExecution[];
    for (const candidate of stale) {
      const result = await WorkflowExecutionModel.recover(candidate.attributes.execution_id!);
      if (!result) continue; // another worker won, or the retry ceiling failed it
      const a = result.execution.attributes as any;
      recovered.push({
        executionId: a.execution_id,
        workflowId: a.workflow_id,
        workflowName: a.workflow_name || a.workflow_id,
        workflowSlug: a.workflow_slug || a.workflow_id,
        startedAt: a.started_at instanceof Date ? a.started_at.toISOString() : String(a.started_at),
        autoRestart: a.auto_restart !== false,
      });
    }
    // Legacy suspended rows predate leases; retain their existing path, but
    // never use wall-clock age to classify a leased execution as stale.
    const suspended = await WorkflowExecutionModel.findSuspended();

    if (suspended.length === 0 && recovered.length === 0) {
      console.log('[WorkflowRecovery] No suspended executions found — nothing to recover.');
      await scheduleNextLeaseRecovery(WorkflowExecutionModel);
      return;
    }

    if (recovered.length > 0 || suspended.some(e => !notifiedManualResumes.has((e.attributes as any).execution_id))) {
      console.log(`[WorkflowRecovery] Found ${ suspended.length } legacy suspended and ${ recovered.length } stale execution(s) to recover.`);
    }

    const autoRestarts: SuspendedExecution[] = recovered.filter(entry => entry.autoRestart);
    const manualResumes: SuspendedExecution[] = recovered.filter(entry => !entry.autoRestart);

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
      await notifyManualResumes(manualResumes);
    }
    await scheduleNextLeaseRecovery(WorkflowExecutionModel);
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
