/**
 * seedCoreRoutines — boot-time installer for locked core routines.
 *
 * Idempotent and self-healing: for each bundled core routine it calls
 * WorkflowModel.seedCoreRoutine, which inserts an absent routine, silently
 * re-syncs a drifted one from the bundle, and leaves an unchanged one alone —
 * always preserving the human's enabled/disabled choice. After seeding it
 * re-arms the workflow scheduler so any newly-seeded schedule fires without an
 * app restart.
 *
 * Non-fatal by contract: a failure here must never block DB init, so callers
 * wrap it and swallow errors (the routine simply re-seeds next boot).
 */

import { WorkflowModel } from '@pkg/agent/database/models/WorkflowModel';
import { WorkLaneWorkflowBindingModel } from '@pkg/agent/database/models/WorkLaneWorkflowBindingModel';
import { LaneEntryAutomationService } from '@pkg/agent/services/LaneEntryAutomationService';

import { CORE_ROUTINES } from './index';
import { EXECUTE_PROJECT_TODO_ID } from './executeProjectTodo';
import { PLAN_PROJECT_TASK_ID } from './planProjectTask';
import { REVIEW_PROJECT_ARTIFACT_ID } from './reviewProjectArtifact';

const CORE_PIPELINE_BINDINGS = [
  { laneKey: 'planning', workflowId: PLAN_PROJECT_TASK_ID },
  { laneKey: 'blocked', workflowId: PLAN_PROJECT_TASK_ID },
  { laneKey: 'todo', workflowId: EXECUTE_PROJECT_TODO_ID },
  { laneKey: 'in_review', workflowId: REVIEW_PROJECT_ARTIFACT_ID },
] as const;

async function seedCorePipelineBindings(): Promise<number> {
  const current = await WorkLaneWorkflowBindingModel.list({ scope: 'core' });
  let changed = 0;
  for (const desired of CORE_PIPELINE_BINDINGS) {
    const exact = current.find(binding => binding.lane_key === desired.laneKey && binding.semantic_role === null);
    if (exact?.workflow_id === desired.workflowId) continue;
    try {
      await WorkLaneWorkflowBindingModel.set({
        scope:      'core',
        laneKey:    desired.laneKey,
        workflowId: desired.workflowId,
        actor:      'core-seeder',
      });
      changed++;
    } catch (err) {
      // A Human-disabled core workflow intentionally resolves unavailable.
      // One disabled owner must not prevent the other lifecycle bindings from
      // self-healing on the same boot.
      console.warn(`[seedCoreRoutines] skipped core ${ desired.laneKey } binding:`, err);
    }
  }
  return changed;
}

export async function seedCoreRoutines(): Promise<void> {
  let inserted = 0;
  let resynced = 0;
  let unchanged = 0;

  for (const definition of CORE_ROUTINES) {
    try {
      const result = await WorkflowModel.seedCoreRoutine(definition);
      if (result === 'inserted') inserted++;
      else if (result === 'resynced') resynced++;
      else unchanged++;
    } catch (err) {
      console.error(`[seedCoreRoutines] failed for '${ definition.id }':`, err);
    }
  }

  console.log(`[seedCoreRoutines] core routines: ${ inserted } inserted, ${ resynced } re-synced, ${ unchanged } unchanged`);

  // Existing projects predate reusable templates. Protected exact-lane
  // fallbacks make their standard pipeline operational without rewriting
  // project-specific definitions or requiring an empty board.
  try {
    const bindings = await seedCorePipelineBindings();
    const rearmed = await WorkLaneWorkflowBindingModel.rearmCurrentUnautomated();
    for (const entry of rearmed) await LaneEntryAutomationService.dispatchEntry(entry.id);
    console.log(`[seedCoreRoutines] core pipeline bindings: ${ bindings } changed, ${ rearmed.length } current stage(s) re-armed`);
  } catch (err) {
    console.warn('[seedCoreRoutines] core pipeline binding/backfill failed:', err);
  }

  // Re-arm the scheduler so a freshly-seeded schedule trigger is live now,
  // not only after the next restart. Non-fatal.
  if (inserted > 0 || resynced > 0) {
    try {
      const { getWorkflowSchedulerService } = await import('@pkg/agent/services/WorkflowSchedulerService');
      await getWorkflowSchedulerService().refresh();
    } catch (err) {
      console.warn('[seedCoreRoutines] scheduler refresh failed:', err);
    }
  }
}
