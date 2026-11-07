// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { StrandedManagerDetector } from '../../../app/Services/StrandedManagerDetector';
import type { FleetJobView, FleetTaskView } from '../../../app/Services/AgentFleetTypes';

const now = Date.parse('2026-11-05T12:00:00.000Z');
const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
const task = (taskIndex: number, overrides: Partial<FleetTaskView> = {}): FleetTaskView => ({
  taskIndex, agentId: 'worker', label: 'worker', status: 'completed', state: 'done', returned: true,
  startedAt: iso(40 * 60_000), finishedAt: iso(20 * 60_000), returnedAt: iso(20 * 60_000),
  completionDeliveredAt: null, lastActivityAt: iso(20 * 60_000), threadId: `thread-${ taskIndex }`,
  parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null, ...overrides,
});
const manager = (activityAgoMs = 31 * 60_000, overrides: Partial<FleetTaskView> = {}): FleetJobView => ({
  jobId: 'manager-job', status: 'parked', createdAt: iso(60 * 60_000), finishedAt: null,
  parentThreadId: 'grandparent-thread', parentChannel: 'sulla-desktop', parentJobId: null,
  parentTaskIndex: null, rootThreadId: 'root', tasks: [task(0, { agentId: 'manager', label: 'Manager', status: 'parked', state: 'parked', returned: false,
    finishedAt: null, returnedAt: null, lastActivityAt: iso(activityAgoMs), threadId: 'manager-thread', ...overrides })],
});
const child = (overrides: Partial<FleetTaskView> = {}): FleetJobView => ({
  jobId: 'child-job', status: 'completed', createdAt: iso(25 * 60_000), finishedAt: iso(20 * 60_000),
  parentThreadId: 'manager-thread', parentJobId: 'manager-job', parentTaskIndex: 0, rootThreadId: 'root',
  tasks: [task(0, overrides)],
});

describe('StrandedManagerDetector', () => {
  it('detects a parked manager after 30 minutes without live children and targets its parent', () => {
    // risk: a stranded manager remains invisible to the only agent that can recover it.
    const [found] = new StrandedManagerDetector(() => now).detect([manager(), child({ completionDeliveredAt: iso(19 * 60_000) })]);
    expect(found).toMatchObject({ managerJobId: 'manager-job', managerTaskIndex: 0, reasonKind: 'parked-without-live-children',
      parentThreadId: 'grandparent-thread', parentChannel: 'sulla-desktop' });
  });

  it('does not fire before 30 minutes or for a task that never managed a child', () => {
    // risk: false alerts train parents to ignore real stranded-manager notices.
    const detector = new StrandedManagerDetector(() => now);
    expect(detector.detect([manager(29 * 60_000 + 59_000), child({ completionDeliveredAt: iso(19 * 60_000) })])).toEqual([]);
    expect(detector.detect([manager()])).toEqual([]);
  });

  it('detects an unprocessed child result at ten minutes and resets after manager activity', () => {
    // risk: a failed wake strands completed work without escalating it.
    const detector = new StrandedManagerDetector(() => now);
    expect(detector.detect([manager(15 * 60_000), child({ finishedAt: iso(10 * 60_000), returnedAt: iso(10 * 60_000) })])[0]?.reasonKind).toBe('result-not-woken');
    expect(detector.detect([manager(5 * 60_000), child({ finishedAt: iso(10 * 60_000), returnedAt: iso(10 * 60_000) })])).toEqual([]);
  });

  it('treats a future agents/wait child and a future-waiting manager as intentionally live', () => {
    // risk: a worker parked in agents/wait for 20 minutes falsely strands its manager.
    const detector = new StrandedManagerDetector(() => now);
    const waitingChild = child({ status: 'parked', returned: false, finishedAt: null, returnedAt: null, wakeAt: new Date(now + 20 * 60_000).toISOString() });
    waitingChild.status = 'parked';
    expect(detector.detect([manager(), waitingChild])).toEqual([]);
    expect(detector.detect([manager(31 * 60_000, { wakeAt: new Date(now + 20 * 60_000).toISOString() }), child()])).toEqual([]);
  });

  it('changes the episode fingerprint when child state changes', () => {
    // risk: a later stranded episode is suppressed by an earlier persisted alert.
    const detector = new StrandedManagerDetector(() => now);
    const first = detector.detect([manager(15 * 60_000), child({ finishedAt: iso(10 * 60_000), returnedAt: iso(10 * 60_000) })])[0];
    const second = detector.detect([manager(15 * 60_000), child({ finishedAt: iso(11 * 60_000), returnedAt: iso(11 * 60_000) })])[0];
    expect(first.stateKey).not.toBe(second.stateKey);
  });
});
