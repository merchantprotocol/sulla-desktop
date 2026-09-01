import type { PoolClient } from 'pg';

/** Record the lane-entry generation and transition outbox event for direct task updates. */
export async function recordTaskTransitionWithClient(
  client: PoolClient,
  taskId: string,
  previousLaneKey: string,
  nextLaneKey: string,
  actor: string,
  source: string,
): Promise<void> {
  const { WorkLaneWorkflowBindingModel } = await import('./WorkLaneWorkflowBindingModel');
  const claimed = await WorkLaneWorkflowBindingModel.claimLaneEntryInTransaction(
    client, taskId, nextLaneKey, actor,
  );
  const { createPostgresProjectsRepositories } = await import('../../projects/infrastructure/PostgresProjectsRepositories');
  await createPostgresProjectsRepositories(client).events.append({
    id:             `projects-event-${ taskId }-${ claimed.entry.generation }-transition`,
    taskId,
    generation:     claimed.entry.generation,
    eventType:      'projects.task.transitioned',
    idempotencyKey: `projects.task.transitioned:${ taskId }:${ claimed.entry.generation }`,
    occurredAt:     new Date(),
    payload: {
      actor,
      source,
      fromLane:      previousLaneKey,
      toLane:        nextLaneKey,
      laneEntryId:   claimed.entry.id,
      laneAutomated: claimed.entry.status === 'pending',
    },
  });
}
