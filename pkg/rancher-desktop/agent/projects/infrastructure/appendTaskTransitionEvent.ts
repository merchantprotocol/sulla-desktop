import { WorkLaneWorkflowBindingModel } from '../../database/models/WorkLaneWorkflowBindingModel';

import { createPostgresProjectsRepositories } from './PostgresProjectsRepositories';

import type { WorkTaskRecord } from '../../database/models/WorkItemsModel';
import type { PoolClient } from 'pg';

/**
 * Claim the exact lane generation and append its orchestration event through
 * the caller's transaction. Every task-status writer uses this boundary so a
 * committed transition can never exist without a recoverable handoff.
 */
export async function appendTaskTransitionEvent(
  client: PoolClient,
  task: WorkTaskRecord,
  previousStatus: string,
  actor: string,
  source: string,
): Promise<void> {
  if (task.status === previousStatus) return;
  const claimed = await WorkLaneWorkflowBindingModel.claimLaneEntryInTransaction(
    client, task.id, task.status, actor,
  );
  await createPostgresProjectsRepositories(client).events.append({
    id:             `projects-event-${ task.id }-${ claimed.entry.generation }-transition`,
    taskId:         task.id,
    generation:     claimed.entry.generation,
    eventType:      'projects.task.transitioned',
    idempotencyKey: `projects.task.transitioned:${ task.id }:${ claimed.entry.generation }`,
    occurredAt:     new Date(),
    payload:        {
      actor,
      source,
      fromLane:      previousStatus,
      toLane:        task.status,
      laneEntryId:   claimed.entry.id,
      laneAutomated: claimed.entry.status === 'pending',
    },
  });
}
