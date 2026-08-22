import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { SendAgentMessageWorker } from '../send_agent_message';
import { SpawnAgentWorker } from '../spawn_agent';
import { StartAgentConversationWorker } from '../start_agent_conversation';

describe('legacy agent conversation compatibility', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes start_agent_conversation through the canonical async spawn worker', async() => {
    const runValidated = jest.spyOn(SpawnAgentWorker.prototype, 'runValidated').mockResolvedValue({
      successBoolean: true,
      responseString: JSON.stringify({ mode: 'async', jobId: 'agent-job-123' }),
    });
    const state = { metadata: { wsChannel: 'heartbeat', threadId: 'parent-thread' } };
    const worker = new StartAgentConversationWorker();

    worker.setState(state);
    const result = await (worker as any)._validatedCall({
      prompt:  'Do the bounded task',
      agentId: 'worker',
      label:   'compat',
    });
    const body = JSON.parse(result.responseString);

    expect(runValidated).toHaveBeenCalledWith({
      tasks:    [{ prompt: 'Do the bounded task', agentId: 'worker', label: 'compat' }],
      parallel: false,
      async:    true,
    }, state);
    expect(body).toMatchObject({
      conversationId: 'agent-job-123',
      jobId:          'agent-job-123',
      status:         'running',
      deprecated:     true,
    });
    expect(body.hint).toContain('check_agent_jobs');
  });

  it('preserves spawn validation failures', async() => {
    jest.spyOn(SpawnAgentWorker.prototype, 'runValidated').mockResolvedValue({
      successBoolean: false,
      responseString: 'depth limit reached',
    });
    const worker = new StartAgentConversationWorker();
    const result = await (worker as any)._validatedCall({ prompt: 'task' });

    expect(result).toEqual({ successBoolean: false, responseString: 'depth limit reached' });
  });

  it('fails follow-ups clearly instead of running the retired conversation path', async() => {
    const worker = new SendAgentMessageWorker();
    const result = await (worker as any)._validatedCall({
      conversationId: 'agent-job-123',
      message:        'continue',
    });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('send_agent_message is deprecated');
    expect(result.responseString).toContain('spawn_agent');
    expect(result.responseString).toContain('check_agent_jobs');
  });
});
