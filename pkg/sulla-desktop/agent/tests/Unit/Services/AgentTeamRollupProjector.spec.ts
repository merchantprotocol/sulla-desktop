// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentTeamRollupProjector } from '../../../app/Services/AgentTeamRollupProjector';
import type { FleetJobView, FleetTaskView } from '../../../app/Services/AgentFleetTypes';

const now = Date.parse('2026-11-05T12:00:00.000Z');
const task = (taskIndex: number, status = 'running', overrides: Partial<FleetTaskView> = {}): FleetTaskView => ({ taskIndex, agentId: 'worker', label: 'worker', status, returned: false, startedAt: new Date(now - 60_000).toISOString(), finishedAt: null, returnedAt: null, completionDeliveredAt: null, lastActivityAt: new Date(now - 60_000).toISOString(), threadId: `thread-${ taskIndex }`, parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null, ...overrides });
const job = (jobId: string, parentJobId: string | null, parentTaskIndex: number | null, tasks: FleetTaskView[]): FleetJobView => ({ jobId, status: 'running', createdAt: new Date(now - 60_000).toISOString(), finishedAt: null, parentThreadId: 'root', parentJobId, parentTaskIndex, rootThreadId: 'root', tasks });

describe('AgentTeamRollupProjector', () => {
  it('rolls grandchildren into only their direct manager with state, quiet age, blockers and unprocessed results', () => {
    // risk: cross-team leakage causes a manager to act on a sibling's workers
    const projector = new AgentTeamRollupProjector(() => now);
    const first = job('direct-a', null, null, [task(0)]);
    const second = job('direct-b', null, null, [task(0)]);
    const worker = job('worker-a', 'direct-a', 0, [task(0, 'running', { lastActivityAt: new Date(now - 20 * 60_000).toISOString(), latestCheckin: { step: 'blocked', summary: 'waiting', blockers: ['one', 'two'], time: new Date(now - 20 * 60_000).toISOString() } })]);
    const grandchild = job('grandchild-a', 'worker-a', 0, [task(0, 'completed', { returned: true, completion: { output: 'done' } })]);
    const sibling = job('worker-b', 'direct-b', 0, [task(0)]);
    const output = projector.project([first, second, worker, grandchild, sibling]);
    expect(output.get('direct-a#0')).toEqual({ states: { blocked: 1, done: 1 }, oldestQuietAgeMs: null, openBlockers: 2, unprocessedResults: 1, workerCount: 2 });
    expect(output.get('direct-b#0')).toMatchObject({ states: { working: 1 }, openBlockers: 0, unprocessedResults: 0, workerCount: 1 });
  });
});
