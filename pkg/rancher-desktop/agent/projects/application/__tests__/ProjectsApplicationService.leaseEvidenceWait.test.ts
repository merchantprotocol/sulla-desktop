import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ArtifactReceiptModel } from '../../../database/models/ArtifactReceiptModel';
import { LifecycleCapabilityModel } from '../../../database/models/LifecycleCapabilityModel';
import { WorkLaneWorkflowBindingModel } from '../../../database/models/WorkLaneWorkflowBindingModel';
import { WorkTaskWaitModel } from '../../../database/models/WorkTaskWaitModel';
import { ProjectsApplicationService } from '../ProjectsApplicationService';

const current = {
  id:               'task-1',
  project_id:       'project-1',
  epic_id:          'epic-1',
  parent_id:        null,
  slug:             null,
  title:            'Protected work',
  description:      '',
  status:           'todo',
  priority:         'critical',
  due_at:           null,
  start_at:         null,
  milestone_at:     null,
  github_issue:     null,
  assignee:         'dispatcher',
  labels:           [],
  position:         0,
  source:           'agent',
  source_ref:       null,
  created_at:       '',
  updated_at:       null,
  last_moved_at:    '',
  last_activity_at: '',
  created_by:       null,
  last_moved_by:    null,
  completed_at:     null,
  archived:         false,
};

function repository(overrides: Partial<typeof current> = {}) {
  return {
    getTask: jest.fn(() => Promise.resolve({ ...current, ...overrides })),
  } as any;
}

describe('ProjectsApplicationService task lease controls', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('derives the capability and stage from the live task, never from the caller', async() => {
    const repo = repository({ status: 'todo' });
    const claimStage = jest.spyOn(LifecycleCapabilityModel, 'claimStage')
      .mockResolvedValue({ claimed: true, claim: { id: 'stage-1' } as any });
    const service = new ProjectsApplicationService(repo);

    const result = await service.claimTaskLease({ taskId: 'task-1', owner: 'dispatcher', runtimeInstanceId: 'rt-1' });

    expect(claimStage).toHaveBeenCalledWith('task-1', 'todo-execution', 'todo', 'dispatcher', 'rt-1');
    expect(result).toEqual({ claimed: true, claim: { id: 'stage-1' } });
  });

  it('surfaces authorization denial from the model without throwing (fails closed, not silently)', async() => {
    const repo = repository({ status: 'in_review' });
    jest.spyOn(LifecycleCapabilityModel, 'claimStage')
      .mockResolvedValue({ claimed: false, reason: 'in-review-verification is owned by review-routine' });
    const service = new ProjectsApplicationService(repo);

    await expect(service.claimTaskLease({ taskId: 'task-1', owner: 'heartbeat', runtimeInstanceId: 'rt-2' }))
      .resolves.toEqual({ claimed: false, reason: 'in-review-verification is owned by review-routine' });
  });

  it('rejects a claim for a stage with no lease-governed capability', async() => {
    const repo = repository({ status: 'backlog' });
    const service = new ProjectsApplicationService(repo);

    await expect(service.claimTaskLease({ taskId: 'task-1', owner: 'dispatcher', runtimeInstanceId: 'rt-1' }))
      .rejects.toThrow('no lease-governed capability');
  });

  it('rejects a claim for a missing task', async() => {
    const repo = { getTask: jest.fn(() => Promise.resolve(null)) } as any;
    const service = new ProjectsApplicationService(repo);

    await expect(service.claimTaskLease({ taskId: 'task-missing', owner: 'dispatcher', runtimeInstanceId: 'rt-1' }))
      .rejects.toThrow('Task not found');
  });

  it('releases a claim by id, defaulting to released', async() => {
    const releaseStage = jest.spyOn(LifecycleCapabilityModel, 'releaseStage').mockResolvedValue(undefined);
    const service = new ProjectsApplicationService(repository());

    await service.releaseTaskLease({ claimId: 'stage-1' });

    expect(releaseStage).toHaveBeenCalledWith('stage-1', 'released');
  });

  it('heartbeats a claim by id', async() => {
    const heartbeatStage = jest.spyOn(LifecycleCapabilityModel, 'heartbeatStage')
      .mockResolvedValue({ id: 'stage-1', status: 'active' } as any);
    const service = new ProjectsApplicationService(repository());

    await expect(service.heartbeatTaskLease({ claimId: 'stage-1' })).resolves.toMatchObject({ id: 'stage-1' });
    expect(heartbeatStage).toHaveBeenCalledWith('stage-1');
  });
});

describe('ProjectsApplicationService.attachEvidence', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('attaches evidence scoped to the current stage-entry generation', async() => {
    const repo = repository({ status: 'in_review' });
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries').mockResolvedValue([
      { generation: 3, lane_key: 'in_review' },
    ] as any);
    const insertIfAbsent = jest.spyOn(ArtifactReceiptModel, 'insertIfAbsent').mockResolvedValue({
      inserted: true,
      row:      { id: 'evidence-1', task_id: 'task-1', generation: 3 } as any,
    });
    const service = new ProjectsApplicationService(repo);

    const result = await service.attachEvidence({
      taskId: 'task-1', eventType: 'review-verified', evidenceKind: 'workflow_execution', evidenceRef: 'exec-1',
    }, { actor: 'review-routine', source: 'routine' });

    expect(insertIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', eventType: 'review-verified', actor: 'review-routine', generation: 3,
    }));
    expect(result).toEqual({ receipt: { id: 'evidence-1', task_id: 'task-1', generation: 3 }, created: true, stage: 'in_review', generation: 3 });
  });

  it('rejects a stale expected_generation before writing any receipt', async() => {
    const repo = repository({ status: 'in_review' });
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries').mockResolvedValue([
      { generation: 5, lane_key: 'in_review' },
    ] as any);
    const insertIfAbsent = jest.spyOn(ArtifactReceiptModel, 'insertIfAbsent');
    const service = new ProjectsApplicationService(repo);

    await expect(service.attachEvidence({
      taskId: 'task-1', eventType: 'review-verified', expectedGeneration: 4,
    })).rejects.toThrow('Stale stage generation');
    expect(insertIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects evidence for a missing task', async() => {
    const repo = { getTask: jest.fn(() => Promise.resolve(null)) } as any;
    const service = new ProjectsApplicationService(repo);

    await expect(service.attachEvidence({ taskId: 'task-missing', eventType: 'x' })).rejects.toThrow('Task not found');
  });
});

describe('ProjectsApplicationService.settleWait', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('settles a satisfied wait with a synthesized fingerprint when none is supplied', async() => {
    const observe = jest.spyOn(WorkTaskWaitModel, 'observe').mockResolvedValue({
      changed: true, wait: { id: 'wait-1', status: 'satisfied' } as any,
    });
    const service = new ProjectsApplicationService(repository());

    const result = await service.settleWait({
      id: 'wait-1', outcome: 'satisfied', summary: 'checks green',
    }, { actor: 'review-routine', source: 'routine' });

    expect(observe).toHaveBeenCalledTimes(1);
    const [id, observation] = observe.mock.calls[0] as [string, any];
    expect(id).toBe('wait-1');
    expect(observation).toMatchObject({ outcome: 'satisfied', summary: 'checks green' });
    expect(typeof observation.fingerprint).toBe('string');
    expect(observation.fingerprint.length).toBeGreaterThan(0);
    expect(observation.nextCheckAt).toBeInstanceOf(Date);
    expect(result).toEqual({ changed: true, wait: { id: 'wait-1', status: 'satisfied' } });
  });

  it('rejects settlement when the wait is not active/found', async() => {
    jest.spyOn(WorkTaskWaitModel, 'observe').mockResolvedValue({ changed: false, wait: null });
    const service = new ProjectsApplicationService(repository());

    await expect(service.settleWait({ id: 'wait-missing', outcome: 'failed', summary: 'timed out' }))
      .rejects.toThrow('No active task wait found');
  });

  it('rejects an invalid outcome before calling the model', async() => {
    const observe = jest.spyOn(WorkTaskWaitModel, 'observe');
    const service = new ProjectsApplicationService(repository());

    await expect(service.settleWait({ id: 'wait-1', outcome: 'pending' as any, summary: 'x' }))
      .rejects.toThrow("outcome must be 'satisfied' or 'failed'");
    expect(observe).not.toHaveBeenCalled();
  });
});
