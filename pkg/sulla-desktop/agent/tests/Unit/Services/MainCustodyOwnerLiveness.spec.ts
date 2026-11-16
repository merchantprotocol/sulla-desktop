// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({}));
import { MainStrandedOwnerDetector } from '../../../app/Services/MainCustodyOwnerLiveness';

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
