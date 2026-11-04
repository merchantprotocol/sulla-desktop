// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentJob } from '../../../../tools/agents/jobRegistry';

const fixture = vi.hoisted(() => {
  const checkins = new Map([['parked-manager', [{ id: 'checkin-1' }]]]);
  const messages = new Map([['parked-manager', [{ id: 'message-1' }]]]);
  return { checkins, messages, deleteJob: vi.fn() };
});

vi.mock('../../../../tools/agents/jobRegistry', () => ({
  getJob: vi.fn(),
  getJobsForList: vi.fn(),
  deleteJob: fixture.deleteJob,
}));
vi.mock('../../../../database/models/AgentJobMessagingModel', () => ({
  AgentJobMessagingModel: {
    telemetryForJob: vi.fn(async() => ({})),
    latestTelemetryForJobs: vi.fn(async() => ({})),
  },
}));

import { CheckAgentJobsWorker } from '../../../../tools/agents/check_agent_jobs';
import { getJob, getJobsForList } from '../../../../tools/agents/jobRegistry';

class CheckAgentJobsHarness extends CheckAgentJobsWorker {
  call(input: unknown) { return this._validatedCall(input); }
}

const parkedManager: AgentJob = {
  jobId: 'parked-manager', status: 'completed', createdAt: 1, finishedAt: 2,
  taskCount: 1, results: [{ label: 'manager', status: 'completed', output: 'parked', threadId: 'manager-thread' }],
  tasks: [{ agentId: 'coding-manager', label: 'manager', prompt: 'manage', status: 'completed', threadId: 'manager-thread' }],
  completionDeliveredAt: 3,
};

describe('check_agent_jobs retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.checkins.set('parked-manager', [{ id: 'checkin-1' }]);
    fixture.messages.set('parked-manager', [{ id: 'message-1' }]);
    vi.mocked(getJob).mockResolvedValue(parkedManager);
    vi.mocked(getJobsForList).mockResolvedValue([parkedManager]);
  });

  it('leaves a finished delivered job and its telemetry intact after ten by-id reads', async() => {
    // risk: a supervision read cascades away the job, check-ins, and messages
    const worker = new CheckAgentJobsHarness();
    for (let index = 0; index < 10; index++) await worker.call({ jobId: 'parked-manager' });
    expect(getJob).toHaveBeenCalledTimes(10);
    expect(fixture.deleteJob).not.toHaveBeenCalled();
    expect(fixture.checkins.get('parked-manager')).toEqual([{ id: 'checkin-1' }]);
    expect(fixture.messages.get('parked-manager')).toEqual([{ id: 'message-1' }]);
  });

  it('keeps a parked-looking manager visible through list and by-id reads', async() => {
    // risk: completed parent is erased while child work remains live
    const worker = new CheckAgentJobsHarness();
    const listed = await worker.call({});
    const found = await worker.call({ jobId: 'parked-manager' });
    expect(listed.responseString).toContain('parked-manager');
    expect(found.responseString).toContain('parked-manager');
    expect(fixture.deleteJob).not.toHaveBeenCalled();
  });
});
