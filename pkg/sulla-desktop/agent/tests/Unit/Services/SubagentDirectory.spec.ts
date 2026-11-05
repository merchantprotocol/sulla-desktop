// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentTeamRollupProjector } from '../../../app/Services/AgentTeamRollupProjector';
import type { FleetJobView, FleetTaskView } from '../../../app/Services/AgentFleetTypes';
import { SUBAGENT_DIRECTORY_MAX_CHARS, SubagentDirectoryBuilder } from '../../../services/SubagentDirectory';

const now = Date.parse('2026-11-05T12:00:00.000Z');
const task = (index: number, label: string): FleetTaskView => ({ taskIndex: index, agentId: label, label, status: 'running', returned: false, startedAt: new Date(now - 60_000).toISOString(), finishedAt: null, returnedAt: null, completionDeliveredAt: null, lastActivityAt: new Date(now - 60_000).toISOString(), threadId: `${ label }-thread`, parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null });
const direct: FleetJobView = { jobId: 'direct', status: 'running', createdAt: new Date(now - 60_000).toISOString(), finishedAt: null, parentThreadId: 'root', parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', tasks: [task(0, 'manager')] };
const child: FleetJobView = { jobId: 'child', status: 'running', createdAt: new Date(now - 30_000).toISOString(), finishedAt: null, parentThreadId: 'manager-thread', parentJobId: 'direct', parentTaskIndex: 0, rootThreadId: 'root', tasks: [task(0, 'worker')] };

class FleetReader {
  calls = 0;
  constructor(private readonly jobs: FleetJobView[]) {}
  async list() { this.calls++; return this.jobs; }
}

describe('SubagentDirectoryBuilder', () => {
  it('reads one snapshot, lists only the direct child, appends its team rollup, and stays bounded', async() => {
    // risk: N+1 reads or duplicate descendant lines make the management context stale/noisy
    direct.tasks[0].label = 'x'.repeat(4_000);
    const fleet = new FleetReader([direct, child]);
    const output = await new SubagentDirectoryBuilder(fleet as any, new AgentTeamRollupProjector(() => now), () => now).build('root');
    expect(fleet.calls).toBe(1);
    expect(output).toContain('team workers working=1');
    expect(output).not.toContain('- worker ·');
    expect(output.length).toBeLessThanOrEqual(SUBAGENT_DIRECTORY_MAX_CHARS);
  });
});
