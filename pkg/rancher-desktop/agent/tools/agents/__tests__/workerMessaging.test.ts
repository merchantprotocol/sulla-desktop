import { afterEach, describe, expect, it, jest } from '@jest/globals';

const { AgentJobMessagingModel } = await import('../../../database/models/AgentJobMessagingModel');
const { prepareWorkerTurnPrompt } = await import('../workerMessaging');

afterEach(() => jest.restoreAllMocks());

describe('worker messaging prompt boundary', () => {
  it('labels queued orchestrator messages and records delivery', async() => {
    jest.spyOn(AgentJobMessagingModel, 'pendingMessagesForThread').mockResolvedValue([{
      id: 'message-1',
      jobId: 'agent-job-1',
      taskIndex: 0,
      message: 'Use the additive registry path.',
      createdAt: Date.now(),
    }]);
    const delivered = jest.spyOn(AgentJobMessagingModel, 'markMessagesDelivered').mockResolvedValue(undefined);
    const state = {
      metadata: { isSubAgent: true, threadId: 'worker-thread-1' },
      messages: [],
    };

    const prompt = await prepareWorkerTurnPrompt(state, 'Original task');

    expect(prompt).toContain('Call report_progress');
    expect(prompt).toContain('[Message from orchestrator]\nUse the additive registry path.');
    expect(delivered).toHaveBeenCalledWith(['message-1'], 'worker-thread-1');
  });

  it('does not duplicate a message already injected into graph state', async() => {
    jest.spyOn(AgentJobMessagingModel, 'pendingMessagesForThread').mockResolvedValue([{
      id: 'message-2',
      jobId: 'agent-job-1',
      taskIndex: 0,
      message: 'Already in the transcript',
      createdAt: Date.now(),
    }]);
    jest.spyOn(AgentJobMessagingModel, 'markMessagesDelivered').mockResolvedValue(undefined);
    const state = {
      metadata: { isSubAgent: true, threadId: 'worker-thread-1' },
      messages: [{ role: 'user', content: '[Message from orchestrator]\nAlready in the transcript', metadata: { jobMessageId: 'message-2' } }],
    };

    const prompt = await prepareWorkerTurnPrompt(state, 'Already in the transcript');

    expect(prompt.match(/Already in the transcript/g)).toHaveLength(1);
  });
});
