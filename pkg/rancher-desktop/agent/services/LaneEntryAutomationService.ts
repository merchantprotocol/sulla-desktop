import { WorkLaneWorkflowBindingModel, type LaneEntryAutomationRecord } from '../database/models/WorkLaneWorkflowBindingModel';

import type { RoutineExecutionOptions, RoutineExecutionResult } from '@pkg/main/sullaRoutineTemplateEvents';
import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';
import type { ProposedCustody, ProposedDisposition } from './CanonicalArtifactCustodyService';

export interface LaneEntryTransitionResult {
  created: boolean;
  entry:   LaneEntryAutomationRecord;
}

/** Claims and dispatches the immutable automation snapshot for one real lane transition. */
export class LaneEntryAutomationService {
  static async handleTransition(taskId: string, laneKey: string, actor = 'sulla', custody?: ProposedCustody, disposition?: ProposedDisposition):
  Promise<LaneEntryTransitionResult> {
    if (laneKey === 'in_review') {
      if (!custody || !disposition) throw new Error('lane entry in_review requires structured artifact custody');
      const { WorkItemsModel } = await import('../database/models/WorkItemsModel');
      const task = await WorkItemsModel.getTask(taskId);
      if (!task) throw new Error(`Task not found for in_review lane entry: ${ taskId }`);
      const { CanonicalArtifactCustodyService } = await import('./CanonicalArtifactCustodyService');
      const verified = await CanonicalArtifactCustodyService.verify(task, custody, disposition);
      if (!verified.valid) throw new Error(`artifact custody rejected: ${ verified.error }`);
    }
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
        definitionSnapshot: entry.workflow_snapshot as unknown as WorkflowDefinition,
        executionScope:     { taskId: entry.task_id, generation: entry.generation },
        executionId,
        onSettled:          async(result) => {
          await WorkLaneWorkflowBindingModel.markOutcome(
            entry.id,
            result.executionId,
            result.status,
            result.status === 'completed'
              ? { disposition: 'completed' }
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
