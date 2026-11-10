// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentFleetTreeFormatter } from '../../../app/Formatters/AgentFleetTreeFormatter';
import { PullRequestReferenceExtractor } from '../../../app/Formatters/PullRequestReferenceExtractor';
import type { FleetJobView, FleetTaskView } from '../../../app/Services/AgentFleetTypes';

const now = Date.parse('2026-11-05T12:00:00.000Z');
const task = (overrides: Partial<FleetTaskView> = {}): FleetTaskView => ({ taskIndex: 0, agentId: 'worker', label: 'worker', status: 'running', state: 'working', returned: false, startedAt: new Date(now - 60_000).toISOString(), finishedAt: null, returnedAt: null, completionDeliveredAt: null, lastActivityAt: new Date(now - 60_000).toISOString(), threadId: 'worker-thread', parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null, ...overrides });
const job = (overrides: Partial<FleetJobView> = {}): FleetJobView => ({ jobId: 'manager', status: 'running', createdAt: new Date(now - 60_000).toISOString(), finishedAt: null, parentThreadId: 'root', parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', tasks: [task()], ...overrides });

describe('AgentFleetTreeFormatter', () => {
  it('nests tasks, derives operational state, blockers, returns and persisted PR references', () => {
    // risk: fleet supervision reports the wrong worker or hides a blocker/result
    const formatter = new AgentFleetTreeFormatter(new PullRequestReferenceExtractor(), () => now);
    const manager = job();
    const child = job({ jobId: 'child', parentJobId: 'manager', parentTaskIndex: 0, createdAt: new Date(now - 50_000).toISOString(), tasks: [task({ label: 'quiet worker', state: 'blocked', returned: true, lastActivityAt: new Date(now - 16 * 60_000).toISOString(), latestCheckin: { step: 'review', summary: 'ready https://github.com/merchantprotocol/sulla-desktop/pull/2028', blockers: ['CI'], time: new Date(now - 16 * 60_000).toISOString() } })] });
    const output = formatter.format([child, manager]);
    expect(output.tasks).toHaveLength(2);
    expect(output.tasks[1]).toMatchObject({ ref: 'child#0', parent: 'manager#0', depth: 1, state: 'blocked', blockers: 1, returned: true, pr: 'https://github.com/merchantprotocol/sulla-desktop/pull/2028' });
  });

  it('enforces the 400 UTF-8 byte cap with huge Unicode free text and identifiers', () => {
    // risk: oversized tool payloads crowd out the parent agent context
    const formatter = new AgentFleetTreeFormatter(new PullRequestReferenceExtractor(), () => now);
    const huge = '🧪'.repeat(2_000);
    const output = formatter.format([job({ jobId: huge, tasks: [task({ label: huge, latestCheckin: { step: huge, summary: huge, blockers: [huge], time: new Date(now).toISOString() } })] })]);
    expect(Buffer.byteLength(JSON.stringify(output.tasks[0]), 'utf8')).toBeLessThanOrEqual(400);
    expect(output.tasks[0].truncated).toBe(true);
  });

  it('walks each manager task depth-first even when a sibling manager was created first', () => {
    // risk: a manager's worker is separated from its team and attributed to the wrong manager
    const formatter = new AgentFleetTreeFormatter(new PullRequestReferenceExtractor(), () => now);
    const managerA = job({ jobId: 'A', createdAt: new Date(now - 60_000).toISOString() });
    const managerB = job({ jobId: 'B', createdAt: new Date(now - 50_000).toISOString() });
    const workerA1 = job({ jobId: 'A1', parentJobId: 'A', parentTaskIndex: 0, createdAt: new Date(now - 40_000).toISOString() });
    expect(formatter.format([managerA, managerB, workerA1]).tasks.map(line => line.ref)).toEqual(['A#0', 'A1#0', 'B#0']);
  });

  it('emits orphaned and cyclic jobs once without recursing forever', () => {
    // risk: corrupt lineage makes fleet supervision omit agents or crash
    const formatter = new AgentFleetTreeFormatter(new PullRequestReferenceExtractor(), () => now);
    const orphan = job({ jobId: 'orphan', parentJobId: 'missing', parentTaskIndex: 0 });
    const cycleA = job({ jobId: 'cycle-a', parentJobId: 'cycle-b', parentTaskIndex: 0 });
    const cycleB = job({ jobId: 'cycle-b', parentJobId: 'cycle-a', parentTaskIndex: 0 });
    expect(formatter.format([cycleB, orphan, cycleA]).tasks.map(line => line.ref).sort()).toEqual(['cycle-a#0', 'cycle-b#0', 'orphan#0']);
  });
});
