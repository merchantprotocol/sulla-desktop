import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkLaneWorkflowBindingModel } from '../../../database/models/WorkLaneWorkflowBindingModel';
import { appendTaskTransitionEvent } from '../appendTaskTransitionEvent';

describe('appendTaskTransitionEvent', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('binds one lane generation and appends one event through the caller transaction', async() => {
    const entry = { id: 'lane-entry-4', generation: 4, status: 'pending' } as any;
    const claim = jest.spyOn(WorkLaneWorkflowBindingModel, 'claimLaneEntryInTransaction')
      .mockResolvedValue({ created: true, entry });
    const query = jest.fn<any>().mockResolvedValue({ rows: [{ id: 'event-4' }] });
    const client = { query } as any;

    await appendTaskTransitionEvent(
      client,
      { id: 'task-1', status: 'in_review' } as any,
      'in_progress',
      'dispatcher',
      'task-dispatch-finalize',
    );

    expect(claim).toHaveBeenCalledWith(client, 'task-1', 'in_review', 'dispatcher');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('INSERT INTO work_project_domain_events');
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'projects-event-task-1-4-transition',
      'projects.task.transitioned:task-1:4',
      'projects.task.transitioned',
    ]));
  });

  it('does nothing when no lane transition occurred', async() => {
    const claim = jest.spyOn(WorkLaneWorkflowBindingModel, 'claimLaneEntryInTransaction');
    await appendTaskTransitionEvent(
      { query: jest.fn() } as any,
      { id: 'task-1', status: 'todo' } as any,
      'todo',
      'dispatcher',
      'noop',
    );
    expect(claim).not.toHaveBeenCalled();
  });
});
