// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const enqueueAgentCompletion = jest.fn(() => true);
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

jest.unstable_mockModule('../AgentCompletionInbox', () => ({
  enqueueAgentCompletion,
}));
jest.unstable_mockModule('../../tools/agents/jobRegistry', () => ({
  getPendingCompletions,
}));

describe('AgentCompletionRecoveryService', () => {
  beforeEach(() => {
    enqueueAgentCompletion.mockClear();
    getPendingCompletions.mockClear();
  });

  it('replays the durable report into the completion inbox without acknowledging early', async() => {
    const { recoverPendingAgentCompletions } = await import('../AgentCompletionRecoveryService');

    await recoverPendingAgentCompletions();

    expect(enqueueAgentCompletion).toHaveBeenCalledWith('sulla-desktop', 'parent-thread', expect.objectContaining({
      jobId: 'agent-job-recovered',
    }));
  });
});
