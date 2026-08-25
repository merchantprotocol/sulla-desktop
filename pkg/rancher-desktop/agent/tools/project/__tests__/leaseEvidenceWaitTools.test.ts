/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getProjectsApplicationService } from '../../../projects/application/ProjectsApplicationService';
import { AttachTaskEvidenceWorker } from '../attach_task_evidence';
import { ClaimTaskLeaseWorker } from '../claim_task_lease';
import { HeartbeatTaskLeaseWorker } from '../heartbeat_task_lease';
import { projectToolManifests } from '../manifests';
import { ReleaseTaskLeaseWorker } from '../release_task_lease';
import { SettleTaskWaitWorker } from '../settle_task_wait';

describe('lease/evidence/wait manifests', () => {
  it('registers all five new node names', () => {
    const names = new Set(projectToolManifests.map(tool => tool.name));
    for (const name of [
      'claim_task_lease', 'release_task_lease', 'heartbeat_task_lease',
      'attach_task_evidence', 'settle_task_wait',
    ]) expect(names.has(name)).toBe(true);
  });

  it('loads every new worker through its manifest loader', async() => {
    const targets = projectToolManifests.filter(tool => [
      'claim_task_lease', 'release_task_lease', 'heartbeat_task_lease',
      'attach_task_evidence', 'settle_task_wait',
    ].includes(tool.name));
    expect(targets).toHaveLength(5);
    for (const tool of targets) {
      const module = await tool.loader();
      expect(Object.values(module).some((value: any) =>
        typeof value === 'function' && typeof value.prototype?._validatedCall === 'function')).toBe(true);
    }
  });
});

const projects = getProjectsApplicationService() as any;
const claimTaskLease = jest.spyOn(projects, 'claimTaskLease');
const releaseTaskLease = jest.spyOn(projects, 'releaseTaskLease');
const heartbeatTaskLease = jest.spyOn(projects, 'heartbeatTaskLease');
const attachEvidence = jest.spyOn(projects, 'attachEvidence');
const settleWait = jest.spyOn(projects, 'settleWait');
const call = (tool: any, input: any) => tool._validatedCall(input);

describe('task lease control workflow tools', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('requires task_id, owner, and runtime_instance_id to claim', async() => {
    expect((await call(new ClaimTaskLeaseWorker(), { task_id: 'task-1' })).successBoolean).toBe(false);
    expect(claimTaskLease).not.toHaveBeenCalled();
  });

  it('claims through the application boundary and reports the claim outcome', async() => {
    claimTaskLease.mockResolvedValue({ claimed: true, claim: { id: 'stage-1' } });
    const result = await call(new ClaimTaskLeaseWorker(), {
      task_id: 'task-1', owner: 'dispatcher', runtime_instance_id: 'rt-1',
    });
    expect(result.successBoolean).toBe(true);
    expect(claimTaskLease).toHaveBeenCalledWith({ taskId: 'task-1', owner: 'dispatcher', runtimeInstanceId: 'rt-1' });
  });

  it('surfaces a denied claim as a failed tool result without throwing', async() => {
    claimTaskLease.mockResolvedValue({ claimed: false, reason: 'owned by heartbeat' });
    const result = await call(new ClaimTaskLeaseWorker(), {
      task_id: 'task-1', owner: 'dispatcher', runtime_instance_id: 'rt-1',
    });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('owned by heartbeat');
  });

  it('requires claim_id to release', async() => {
    expect((await call(new ReleaseTaskLeaseWorker(), {})).successBoolean).toBe(false);
    expect(releaseTaskLease).not.toHaveBeenCalled();
  });

  it('releases with a default status of released', async() => {
    releaseTaskLease.mockResolvedValue(undefined);
    const result = await call(new ReleaseTaskLeaseWorker(), { claim_id: 'stage-1' });
    expect(result.successBoolean).toBe(true);
    expect(releaseTaskLease).toHaveBeenCalledWith({ claimId: 'stage-1', status: 'released' });
  });

  it('heartbeats an active claim', async() => {
    heartbeatTaskLease.mockResolvedValue({ id: 'stage-1', status: 'active' });
    const result = await call(new HeartbeatTaskLeaseWorker(), { claim_id: 'stage-1' });
    expect(result.successBoolean).toBe(true);
    expect(heartbeatTaskLease).toHaveBeenCalledWith({ claimId: 'stage-1' });
  });

  it('reports failure when heartbeating a claim that is no longer active', async() => {
    heartbeatTaskLease.mockResolvedValue(null);
    const result = await call(new HeartbeatTaskLeaseWorker(), { claim_id: 'stage-1' });
    expect(result.successBoolean).toBe(false);
  });
});

describe('attach_task_evidence workflow tool', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('requires task_id and event_type', async() => {
    expect((await call(new AttachTaskEvidenceWorker(), { task_id: 'task-1' })).successBoolean).toBe(false);
    expect(attachEvidence).not.toHaveBeenCalled();
  });

  it('passes generation context through the application boundary', async() => {
    attachEvidence.mockResolvedValue({ receipt: { id: 'evidence-1' }, created: true, stage: 'in_review', generation: 3 });
    const result = await call(new AttachTaskEvidenceWorker(), {
      task_id: 'task-1', event_type: 'review-verified', expected_generation: 3, actor: 'review-routine',
    });
    expect(result.successBoolean).toBe(true);
    expect(attachEvidence).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', eventType: 'review-verified', expectedGeneration: 3,
    }), { actor: 'review-routine', source: 'routine' });
  });

  it('surfaces a stale-generation rejection as a failed tool result', async() => {
    attachEvidence.mockRejectedValue(new Error('Stale stage generation for task task-1'));
    const result = await call(new AttachTaskEvidenceWorker(), {
      task_id: 'task-1', event_type: 'review-verified', expected_generation: 1,
    });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('Stale stage generation');
  });
});

describe('settle_task_wait workflow tool', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('requires id, a valid outcome, and a summary', async() => {
    expect((await call(new SettleTaskWaitWorker(), { id: 'wait-1', outcome: 'pending', summary: 'x' })).successBoolean).toBe(false);
    expect((await call(new SettleTaskWaitWorker(), { id: 'wait-1', outcome: 'satisfied' })).successBoolean).toBe(false);
    expect(settleWait).not.toHaveBeenCalled();
  });

  it('settles through the application boundary', async() => {
    settleWait.mockResolvedValue({ changed: true, wait: { id: 'wait-1', status: 'satisfied' } });
    const result = await call(new SettleTaskWaitWorker(), {
      id: 'wait-1', outcome: 'satisfied', summary: 'checks green', actor: 'review-routine',
    });
    expect(result.successBoolean).toBe(true);
    expect(settleWait).toHaveBeenCalledWith({
      id: 'wait-1', outcome: 'satisfied', summary: 'checks green', fingerprint: undefined, nextCheckAt: undefined,
    }, { actor: 'review-routine', source: 'routine' });
  });
});
