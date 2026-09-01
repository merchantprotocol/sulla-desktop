import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const send = jest.fn<(channel: string, message: unknown) => Promise<boolean>>(async() => true);
const markCompletionDelivered = jest.fn<(jobId: string) => Promise<void>>(async() => undefined);
const getPendingCompletions = jest.fn(async() => [{
  jobId: 'agent-job-recovered',
  status: 'completed',
  createdAt: 1,
  finishedAt: 2,
  taskCount: 1,
  parentChannel: 'sulla-desktop',
  parentThreadId: 'parent-thread',
  results: [{ label: 'worker', status: 'completed', output: 'done', threadId: 'worker-thread' }],
}]);

jest.unstable_mockModule('../WebSocketClientService', () => ({
  getWebSocketClientService: jest.fn(() => ({ send })),
}));
jest.unstable_mockModule('../../tools/agents/jobRegistry', () => ({
  getPendingCompletions,
  markCompletionDelivered,
}));

describe('AgentCompletionRecoveryService', () => {
  beforeEach(() => {
    send.mockClear();
    markCompletionDelivered.mockClear();
    getPendingCompletions.mockClear();
  });

  it('replays the durable report and acknowledges only after the wake send', async() => {
    const { recoverPendingAgentCompletions } = await import('../AgentCompletionRecoveryService');

    await recoverPendingAgentCompletions();

    expect(send).toHaveBeenCalledWith('sulla-desktop', expect.objectContaining({
      type: 'user_message',
      data: expect.objectContaining({
        threadId: 'parent-thread',
        metadata: expect.objectContaining({
          jobId: 'agent-job-recovered',
          recovered: true,
        }),
        content: expect.stringContaining('done'),
      }),
    }));
    expect(markCompletionDelivered).toHaveBeenCalledWith('agent-job-recovered');
  });
});
