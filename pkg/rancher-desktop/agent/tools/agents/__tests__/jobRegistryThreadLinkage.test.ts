import { describe, expect, it, jest } from '@jest/globals';

const { postgresClient } = await import('../../../database/PostgresClient');
const { WorkTaskOwnershipModel } = await import('../../../database/models/WorkTaskOwnershipModel');
const { createJob, dismissJobTask, getJobsForParentThread } = await import('../jobRegistry');

describe('jobRegistry parent-thread cards', () => {
  it('keeps task identity on its parent thread and dismisses one card at a time', async() => {
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([] as any);
    jest.spyOn(WorkTaskOwnershipModel, 'releaseSweptJobs').mockResolvedValue(undefined);
    const parent = `thread-${ Date.now() }`;
    const job = await createJob([
      { agentId: 'codex-sol-worker', label: 'Backend', prompt: 'Build it', status: 'queued' },
      { agentId: 'codex-luna-worker', label: 'UI', prompt: 'Render it', status: 'queued' },
    ], 'sulla-desktop', parent);

    const linked = await getJobsForParentThread(parent);

    expect(linked).toEqual([expect.objectContaining({
      jobId:          job.jobId,
      parentChannel:  'sulla-desktop',
      parentThreadId: parent,
      tasks:          expect.arrayContaining([
        expect.objectContaining({ agentId: 'codex-sol-worker', label: 'Backend' }),
        expect.objectContaining({ agentId: 'codex-luna-worker', label: 'UI' }),
      ]),
    })]);

    await dismissJobTask(job.jobId, parent, 0);
    expect((await getJobsForParentThread(parent))[0].tasks[0].dismissed).toBe(true);
    expect((await getJobsForParentThread(parent))[0].tasks[1].dismissed).not.toBe(true);
    expect(query.mock.calls.some(([sql, params]) => String(sql).includes('parent_thread_id') && (params)?.includes(parent))).toBe(true);
  });
});
