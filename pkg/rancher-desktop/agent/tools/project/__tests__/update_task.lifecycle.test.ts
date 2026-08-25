import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { LifecycleCapabilityModel } from '../../../database/models/LifecycleCapabilityModel';
import { WorkItemsModel } from '../../../database/models/WorkItemsModel';
import { UpdateTaskWorker } from '../update_task';

describe('update_task lifecycle ownership', () => {
  const call = (input: any) => (new UpdateTaskWorker() as any)._validatedCall(input);
  const task = (status: string) => ({
    id:               'task-1',
    project_id:       'project-1',
    epic_id:          'epic-1',
    title:            'Protected work',
    status,
    priority:         'critical',
    position:         0,
    labels:           [],
    last_moved_at:    new Date('2026-08-23T20:00:00Z'),
    last_activity_at: new Date('2026-08-23T20:00:00Z'),
  }) as any;

  afterEach(() => { jest.restoreAllMocks() });

  it.each([
    ['in_review', 'done'],
    ['planning', 'backlog'],
  ])('does not let Heartbeat escape protected source stage %s via %s', async(source, destination) => {
    jest.spyOn(WorkItemsModel, 'ensureTables').mockResolvedValue(undefined);
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(task(source));
    const update = jest.spyOn(WorkItemsModel, 'updateTask');
    const guard = jest.spyOn(LifecycleCapabilityModel, 'assertActorCanManageTask')
      .mockRejectedValue(new Error(`Lifecycle handoff denied: ${ source } is owned by its routine.`));

    const result = await call({ id: 'task-1', status: destination, actor: 'heartbeat' });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('Lifecycle handoff denied');
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith(source, [], 'heartbeat');
    expect(update).not.toHaveBeenCalled();
  });

  it('checks a distinct protected destination after the current stage owner allows handoff', async() => {
    jest.spyOn(WorkItemsModel, 'ensureTables').mockResolvedValue(undefined);
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(task('todo'));
    const update = jest.spyOn(WorkItemsModel, 'updateTask');
    const guard = jest.spyOn(LifecycleCapabilityModel, 'assertActorCanManageTask')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Lifecycle handoff denied: in-review-verification is owned by verifier-service.'));

    const result = await call({ id: 'task-1', status: 'in_review', actor: 'heartbeat' });

    expect(result.successBoolean).toBe(false);
    expect(guard.mock.calls).toEqual([
      ['todo', [], 'heartbeat'],
      ['in_review', [], 'heartbeat'],
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it('preserves explicit fallback and legacy-rollout moves when both guards allow them', async() => {
    const current = task('planning');
    const updated = { ...current, status: 'backlog' };
    jest.spyOn(WorkItemsModel, 'ensureTables').mockResolvedValue(undefined);
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(current);
    const update = jest.spyOn(WorkItemsModel, 'updateTask').mockResolvedValue(updated);
    const guard = jest.spyOn(LifecycleCapabilityModel, 'assertActorCanManageTask').mockResolvedValue(undefined);

    const result = await call({ id: 'task-1', status: 'backlog', actor: 'heartbeat' });

    expect(result.successBoolean).toBe(true);
    expect(guard.mock.calls).toEqual([
      ['planning', [], 'heartbeat'],
      ['backlog', [], 'heartbeat'],
    ]);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
