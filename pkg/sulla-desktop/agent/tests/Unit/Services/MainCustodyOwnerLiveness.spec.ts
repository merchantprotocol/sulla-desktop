// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({}));
import { MainCustodyOwnerLiveness, MainStrandedOwnerDetector } from '../../../app/Services/MainCustodyOwnerLiveness';

describe('MainCustodyOwnerLiveness', () => {
  it('treats a live thread with a different agent identity as missing', async () => { // risk: wrong agent inherits custody by thread collision
    const liveness = new MainCustodyOwnerLiveness({ findTaskByThread: vi.fn().mockResolvedValue({ job: { tasks: [{ agentId: 'actual-agent', status: 'running' }] }, taskIndex: 0 }) } as any, { isTerminal: () => false }, { matches: async () => true }, { isStranded: async () => false });
    await expect(liveness.status({ channel: 'chat', threadId: 'thread', agentId: 'claimed-agent' })).resolves.toBe('missing');
  });
});

describe('MainStrandedOwnerDetector', () => {
  it('uses the bounded open-child repository read for terminal owners', async () => { // risk: unbounded job-table scan on custody authorization
    const locator = { findTaskByThread: vi.fn().mockResolvedValue({ job: { tasks: [{ status: 'completed' }] }, taskIndex: 0 }) };
    const jobs = { openChildrenForThread: vi.fn().mockResolvedValue(2), allJobs: vi.fn(() => { throw new Error('unbounded read'); }) };
    const detector = new MainStrandedOwnerDetector(locator as any, jobs as any);
    await expect(detector.isStranded({ channel: 'chat', threadId: 'owner-thread', agentId: 'owner' })).resolves.toBe(true);
    expect(jobs.openChildrenForThread).toHaveBeenCalledWith('owner-thread');
    expect(jobs.allJobs).not.toHaveBeenCalled();
  });
});
