// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  taskForThread: vi.fn(),
  appendCheckin: vi.fn(),
  publish: vi.fn(),
  touch: vi.fn(),
  itemsForTask: vi.fn(),
}));

vi.mock('../../../../database/models/AgentJobMessagingModel', () => ({
  AgentJobMessagingModel: { taskForThread: fakes.taskForThread, appendCheckin: fakes.appendCheckin },
}));
vi.mock('../../../../app/Providers/AgentJobServiceProvider', () => ({
  agentJobProvider: {
    blockerDecisions: { publish: fakes.publish },
    states: { touch: fakes.touch },
    reviewItems: { itemsForTask: fakes.itemsForTask },
  },
}));

import { ReportProgressWorker } from '../../../../tools/agents/report_progress';

class ReportProgressHarness extends ReportProgressWorker {
  run(threadId: string, input: unknown) {
    this.setState({ metadata: { threadId, wsChannel: 'sulla-desktop' } } as any);
    return this._validatedCall(input);
  }
}

describe('ReportProgressWorker blocker publication', () => {
  const receipt = {
    target: { jobId: 'child-job', taskIndex: 2, threadId: 'child-thread', parentChannel: 'sulla-desktop', label: 'worker' },
    checkin: { step: 'blocked', summary: 'Need a choice', blockers: ['Choose the migration schema'], filesTouched: [], createdAt: 10 },
    blockersChanged: true,
  };

  beforeEach(() => vi.clearAllMocks());

  it('waits for the durable decision publisher before reporting success', async() => {
    // risk: parent misses an answerable blocker because the child returns before its decision is persisted.
    let release!: () => void;
    fakes.appendCheckin.mockResolvedValue(receipt);
    fakes.publish.mockImplementation(() => new Promise<void>(resolve => { release = resolve }));
    const worker = new ReportProgressHarness();
    let returned = false;
    const resultPromise = worker.run('child-thread', { summary: 'Need a choice', blockers: ['Choose the migration schema'] }).then(value => {
      returned = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fakes.publish).toHaveBeenCalledWith(receipt, 'child-thread', 'sulla-desktop');
    expect(returned).toBe(false);
    release();
    await expect(resultPromise).resolves.toMatchObject({ successBoolean: true });
    expect(fakes.touch).toHaveBeenCalledOnce();
  });

  it('does not claim success when decision persistence fails', async() => {
    // risk: user communication — a durable check-in alone must not masquerade as a routed parent decision.
    fakes.appendCheckin.mockResolvedValue(receipt);
    fakes.publish.mockRejectedValue(new Error('persistence unavailable'));
    const worker = new ReportProgressHarness();

    await expect(worker.run('child-thread', { summary: 'Need a choice', blockers: ['Choose the migration schema'] }))
      .resolves.toMatchObject({ successBoolean: false, errorCode: 'decision_publish_failed' });
    expect(fakes.touch).toHaveBeenCalledOnce();
  });
});
