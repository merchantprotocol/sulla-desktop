import { WorkLaneWorkflowBindingModel, type LaneEntryAutomationRecord } from '../database/models/WorkLaneWorkflowBindingModel';

export interface LaneEntryTransitionResult {
  created: boolean;
  entry:   LaneEntryAutomationRecord;
}

/** Claims and dispatches the immutable automation snapshot for one real lane transition. */
export class LaneEntryAutomationService {
  static async handleTransition(taskId: string, laneKey: string, actor = 'sulla'):
  Promise<LaneEntryTransitionResult> {
    const claimed = await WorkLaneWorkflowBindingModel.claimLaneEntry(taskId, laneKey, actor);
    if (!claimed.created || !claimed.entry.workflow_id) return claimed;

    try {
      const { executeRoutine } = await import('@pkg/main/sullaRoutineTemplateEvents');
      let startedEntry: LaneEntryAutomationRecord | null = null;
      const result = await executeRoutine(claimed.entry.workflow_id, JSON.stringify({
        event:        'project.lane.entered',
        taskId,
        laneKey,
        generation:   claimed.entry.generation,
        actor,
        laneContract: (claimed.entry.binding_snapshot as any).lane_contract ?? {},
      }), {
        onStarted: async(executionId) => {
          startedEntry = await WorkLaneWorkflowBindingModel.markStarted(claimed.entry.id, executionId);
        },
        onSettled: async(result) => {
          await WorkLaneWorkflowBindingModel.markOutcome(
            claimed.entry.id,
            result.status,
            result.status === 'completed'
              ? { disposition: 'completed' }
              : { disposition: 'runtime_failed', message: result.error ?? 'Unknown workflow failure' },
          );
        },
      });
      return { created: true, entry: startedEntry ?? { ...claimed.entry, execution_id: result.executionId, status: 'running' } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await WorkLaneWorkflowBindingModel.markOutcome(claimed.entry.id, 'failed', {
        disposition: 'dispatch_failed', message,
      });
      return { created: true, entry: failed ?? claimed.entry };
    }
  }
}
