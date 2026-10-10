import { afterEach, describe, expect, it, jest } from '@jest/globals';

const { postgresClient } = await import('../../PostgresClient');
const { AgentJobMessagingModel } = await import('../AgentJobMessagingModel');

afterEach(() => jest.restoreAllMocks());

describe('AgentJobMessagingModel', () => {
  it('binds check-ins to the job task owning the current thread', async() => {
    const query = jest.spyOn(postgresClient, 'query')
      .mockResolvedValueOnce([{
        job_id: 'agent-job-1',
        job_status: 'running',
        task_index: 0,
        task_status: 'running',
        thread_id: 'worker-thread-1',
      }] as any)
      .mockResolvedValueOnce([{
        step: 'review',
        summary: 'Diff checked',
        files_touched: ['one.ts'],
        blockers: [],
        percent: 80,
        created_at: new Date(),
      }] as any);

    const result = await AgentJobMessagingModel.appendCheckin('worker-thread-1', {
      step: 'review',
      summary: 'Diff checked',
      filesTouched: ['one.ts'],
      percent: 80,
    });

    expect(result?.target).toEqual(expect.objectContaining({ jobId: 'agent-job-1', taskIndex: 0 }));
    expect(result?.checkin).toEqual(expect.objectContaining({ step: 'review', percent: 80 }));
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO agent_job_checkins');
    expect(query.mock.calls[1][1]).toEqual(expect.arrayContaining(['agent-job-1', 0, 'review', 'Diff checked']));
  });
});
