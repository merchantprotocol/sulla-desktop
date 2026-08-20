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

import { CORE_ROUTINES } from './index';

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
