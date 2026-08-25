import { WorkLaneWorkflowBindingModel, type LaneEntryAutomationRecord } from '../database/models/WorkLaneWorkflowBindingModel';

import type { RoutineExecutionOptions, RoutineExecutionResult } from '@pkg/main/sullaRoutineTemplateEvents';
import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';

export interface LaneEntryTransitionResult {
  created: boolean;
  entry:   LaneEntryAutomationRecord;
}

/** Claims and dispatches the immutable automation snapshot for one real lane transition. */
export class LaneEntryAutomationService {
  static async handleTransition(taskId: string, laneKey: string, actor = 'sulla'):
  Promise<LaneEntryTransitionResult> {
    const claimed = await WorkLaneWorkflowBindingModel.claimLaneEntry(taskId, laneKey, actor);
    if (claimed.created && claimed.entry.workflow_id) {
      return { created: true, entry: await LaneEntryAutomationService.dispatchEntry(claimed.entry.id) };
    }
    return claimed;
  }

  static async dispatchEntry(entryId: string): Promise<LaneEntryAutomationRecord> {
    const entry = await WorkLaneWorkflowBindingModel.getLaneEntry(entryId);
    if (!entry) throw new Error(`Lane entry not found: ${ entryId }`);
    if (entry.status !== 'pending' || !entry.workflow_id) return entry;

    const executionId = `lane-exec-${ entry.task_id }-${ entry.generation }`;
    const started = await WorkLaneWorkflowBindingModel.markStarted(entry.id, executionId);
    if (!started) return (await WorkLaneWorkflowBindingModel.getLaneEntry(entry.id)) ?? entry;

    try {
      const result = await LaneEntryAutomationService.executeRoutine(entry.workflow_id, JSON.stringify({
        event:        'project.lane.entered',
        taskId:       entry.task_id,
        laneKey:      entry.lane_key,
        generation:   entry.generation,
        actor:         entry.actor ?? 'sulla',
        laneContract: (entry.binding_snapshot as any).lane_contract ?? {},
      }), {
        routineKind:        'other',
        definitionSnapshot: entry.workflow_snapshot as unknown as WorkflowDefinition,
        executionScope:     { taskId: entry.task_id, generation: entry.generation },
        executionId,
        onSettled:          async(result) => {
          const outcome = result.outcome && typeof result.outcome === 'object'
            ? result.outcome as Record<string, any>
            : {};
          let transitionReceipt: unknown = null;
          if (result.status === 'completed' && outcome.transition) {
            const transition = outcome.transition as { mode?: string; stageKey?: string };
            const { getProjectsApplicationService } = await import('../projects/application/ProjectsApplicationService');
            const projects = getProjectsApplicationService();
            const context = { actor: 'sulla' as const, source: 'routine' as const };
            if (transition.mode === 'next') {
              transitionReceipt = await projects.transitionTaskRelative({
                taskId: entry.task_id, direction: 'next', expectedGeneration: entry.generation,
                custody: outcome.custody,
              }, context);
            } else if (transition.mode === 'specific' && typeof transition.stageKey === 'string') {
              transitionReceipt = await projects.transitionTaskStage({
                taskId: entry.task_id, stageKey: transition.stageKey, expectedGeneration: entry.generation,
                custody: outcome.custody,
              }, context);
            } else {
              throw new Error('Lane workflow returned an invalid transition outcome.');
            }
          }
          await WorkLaneWorkflowBindingModel.markOutcome(
            entry.id,
            result.executionId,
            result.status,
            result.status === 'completed'
              ? { disposition: 'completed', workflowOutcome: outcome, transitionReceipt }
              : { disposition: 'runtime_failed', message: result.error ?? 'Unknown workflow failure' },
          );
        },
      });
      if (result.executionId !== executionId) {
        throw new Error(`Lane execution identity mismatch: expected ${ executionId }, received ${ result.executionId }.`);
      }
      return (await WorkLaneWorkflowBindingModel.getLaneEntry(entry.id)) ?? started;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await WorkLaneWorkflowBindingModel.markOutcome(entry.id, executionId, 'failed', {
        disposition: 'dispatch_failed', message,
      });
      return failed ?? started;
    }
  }

  /** Drain committed lane-entry outbox rows after a crash or app restart. */
  static async drainRecoverable(limit = 50, includeInterrupted = false): Promise<LaneEntryAutomationRecord[]> {
    const recoverable = await WorkLaneWorkflowBindingModel.listRecoverable(limit, includeInterrupted);
    const results: LaneEntryAutomationRecord[] = [];
    for (const entry of recoverable) {
      if (entry.status === 'running' && entry.execution_id) {
        if (entry.workflow_execution_status === 'completed' || entry.workflow_execution_status === 'failed') {
          const settled = await WorkLaneWorkflowBindingModel.markOutcome(
            entry.id,
            entry.execution_id,
            entry.workflow_execution_status,
            entry.workflow_execution_status === 'completed'
              ? { disposition: 'completed', recovered: true }
              : { disposition: 'runtime_failed', message: entry.workflow_execution_error ?? 'Unknown workflow failure', recovered: true },
          );
          if (settled) results.push(settled);
          continue;
        }
        const reset = entry.workflow_execution_status === 'running' || entry.workflow_execution_status === 'suspended'
          ? await WorkLaneWorkflowBindingModel.resetInterruptedExecution(entry.id, entry.execution_id)
          : await WorkLaneWorkflowBindingModel.resetMissingExecution(entry.id, entry.execution_id);
        if (!reset) continue;
      }
      results.push(await LaneEntryAutomationService.dispatchEntry(entry.id));
    }
    return results;
  }

  private static async executeRoutine(workflowId: string, triggerPayload: string,
    options: RoutineExecutionOptions): Promise<RoutineExecutionResult> {
    const runtime = await import('@pkg/main/sullaRoutineTemplateEvents');
    return runtime.executeRoutine(workflowId, triggerPayload, options);
  }
}
