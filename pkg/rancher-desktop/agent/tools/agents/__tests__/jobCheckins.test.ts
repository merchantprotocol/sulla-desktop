import { describe, expect, it } from '@jest/globals';

const { jobTaskViews } = await import('../check_agent_jobs');

describe('check_agent_jobs task detail', () => {
  it('returns latest and last three check-ins with queued-message count', () => {
    const createdAt = Date.now() - 60_000;
    const job: any = {
      jobId: 'agent-job-1',
      status: 'running',
      createdAt,
      finishedAt: null,
      taskCount: 1,
      results: [],
      tasks: [{ agentId: 'codex-sol-worker', label: 'backend', prompt: 'work', status: 'running', startedAt: createdAt }],
    };
    const checkin = {
      step: 'implementation',
      summary: 'Persistence is wired',
      filesTouched: ['AgentJobMessagingModel.ts'],
      blockers: [],
      percent: 50,
      createdAt: Date.now(),
    };

    const [task] = jobTaskViews(job, {
      0: { latestCheckin: checkin, checkins: [checkin], undeliveredMessages: 2 },
    });

    expect(task).toEqual(expect.objectContaining({
      taskIndex: 0,
      status: 'running',
      undeliveredOrchestratorMessages: 2,
      latestCheckin: expect.objectContaining({ step: 'implementation', percent: 50 }),
      checkins: [expect.objectContaining({ summary: 'Persistence is wired' })],
    }));
  });
});
