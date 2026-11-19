// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { ResultTrackingService } from '../../../services/ResultTrackingService';

import type { AgentJob } from '../../../tools/agents/jobRegistry';

function fixture() {
  const jobs = new Map(['old', 'new', 'other'].map(jobId => [jobId, { jobId, parentThreadId: jobId === 'other' ? 'other-chat' : 'manager', status: 'parked', tasks: [{ status: 'parked', threadId: `thread-${ jobId }`, waitReason: 'CI' }] } as AgentJob]));
  const writes: unknown[] = [];
  const store = {
    job:      (id: string) => Promise.resolve(jobs.get(id)),
    decision: (id: string) => Promise.resolve(id === 'q' ? { id, conversationId: 'manager' } as any : undefined),
    update:   (id: string, index: number, patch: any) => { writes.push(patch); Object.assign(jobs.get(id)!.tasks[index], patch); return Promise.resolve() },
  };
  const service = new ResultTrackingService(store);
  return { service, jobs, writes, store };
}
describe('explicit result links', () => {
  it('records metadata without altering execution, wait or settlement fields', async() => {
    const { service, jobs, writes } = fixture();
    await service.link({ jobId: 'new', taskIndex: 0 }, { followUpOf: { jobId: 'old', taskIndex: 0 }, decisionIds: ['q'] }, 'manager');
    expect(writes).toEqual([{ followUpOf: { jobId: 'old', taskIndex: 0 }, decisionIds: ['q'] }]);
    expect(jobs.get('new')).toMatchObject({ status: 'parked', tasks: [{ status: 'parked', waitReason: 'CI' }] });
  });
  it('serializes concurrent reciprocal links and reassignment across service instances', async() => {
    const { service, jobs, store } = fixture();
    const second = new ResultTrackingService(store);
    const outcomes = await Promise.allSettled([
      service.link({ jobId: 'new', taskIndex: 0 }, { followUpOf: { jobId: 'old', taskIndex: 0 } }, 'manager'),
      second.link({ jobId: 'old', taskIndex: 0 }, { followUpOf: { jobId: 'new', taskIndex: 0 } }, 'manager'),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(jobs.get('old')!.tasks[0].followUpOf).toBeUndefined();
  });
  it('rejects another conversation, unknown decision, reassignment and cycles', async() => {
    const { service, jobs } = fixture();
    const target = { jobId: 'new', taskIndex: 0 };
    await expect(service.link(target, { followUpOf: { jobId: 'other', taskIndex: 0 } }, 'manager')).rejects.toThrow('manager conversation');
    await expect(service.link(target, { decisionIds: ['missing'] }, 'manager')).rejects.toThrow('Decision must');
    await expect(service.link(target, { followUpOf: target }, 'manager')).rejects.toThrow('cycle');
    jobs.get('old')!.tasks[0].followUpOf = target;
    await expect(service.link(target, { followUpOf: { jobId: 'old', taskIndex: 0 } }, 'manager')).rejects.toThrow('cycle');
    jobs.get('old')!.tasks[0].followUpOf = undefined;
    await service.link(target, { followUpOf: { jobId: 'old', taskIndex: 0 } }, 'manager');
    await expect(service.link(target, { followUpOf: { jobId: 'new', taskIndex: 0 } }, 'manager')).rejects.toThrow();
  });
});
