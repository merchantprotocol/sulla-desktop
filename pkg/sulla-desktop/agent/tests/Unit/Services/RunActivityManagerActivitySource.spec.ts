// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { RunActivityManagerActivitySource } from '../../../app/Services/RunActivityManagerActivitySource';
import { StrandedManagerDetector } from '../../../app/Services/StrandedManagerDetector';
import type { FleetJobView, FleetTaskView } from '../../../app/Services/AgentFleetTypes';

const now = Date.parse('2026-11-05T12:00:00.000Z');
const stale = new Date(now - 60 * 60_000).toISOString();
const task = (overrides: Partial<FleetTaskView> = {}): FleetTaskView => ({ taskIndex: 0, agentId: 'manager', label: 'Manager', status: 'parked', state: 'parked', returned: false,
  startedAt: stale, finishedAt: null, returnedAt: null, completionDeliveredAt: null, lastActivityAt: stale, threadId: 'manager-thread', parentJobId: null,
  parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null, ...overrides });

describe('RunActivityManagerActivitySource', () => {
  it('keeps only the task with live model/tool activity out of stranded detection despite a stale durable timestamp', () => {
    // risk: an actively executing manager is falsely escalated as stranded
    const activity = new Map([['manager-job#0', now - 1_000]]);
    const source = new RunActivityManagerActivitySource({ lastActivityAt: key => activity.get(key) });
    const manager: FleetJobView = { jobId: 'manager-job', status: 'parked', createdAt: stale, finishedAt: null, parentThreadId: 'parent-thread', parentChannel: 'sulla-desktop',
      parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', tasks: [task()] };
    const child: FleetJobView = { jobId: 'child-job', status: 'completed', createdAt: stale, finishedAt: stale, parentThreadId: 'manager-thread', parentChannel: 'sulla-desktop',
      parentJobId: 'manager-job', parentTaskIndex: 0, rootThreadId: 'root', tasks: [task({ taskIndex: 0, agentId: 'worker', label: 'Worker', status: 'completed', returned: true,
        returnedAt: stale, finishedAt: stale, threadId: 'child-thread', parentJobId: 'manager-job', parentTaskIndex: 0 })] };

    expect(new StrandedManagerDetector(() => now, source).detect([manager, child])).toEqual([]);
    expect(source.isActive('manager-job', 1, task({ taskIndex: 1 }), now)).toBe(false);
  });
});
