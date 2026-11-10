// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentTeamRollupProjector } from '../../../app/Services/AgentTeamRollupProjector';
import type { FleetJobView, FleetTaskView } from '../../../app/Services/AgentFleetTypes';
import { SUBAGENT_DIRECTORY_MAX_CHARS, SubagentDirectoryBuilder } from '../../../services/SubagentDirectory';

const now = Date.parse('2026-11-05T12:00:00.000Z');
const task = (index: number, label: string): FleetTaskView => ({ taskIndex: index, agentId: label, label, status: 'running', state: 'working', returned: false, startedAt: new Date(now - 60_000).toISOString(), finishedAt: null, returnedAt: null, completionDeliveredAt: null, lastActivityAt: new Date(now - 60_000).toISOString(), threadId: `${ label }-thread`, parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null });
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

  it('renders completion output text and preserves promotion and parked-child markers', async() => {
    // risk: a missed wake hides the worker deliverable or management state behind [object Object]
    const completedTask = { ...task(0, 'finished-worker'), status: 'completed', state: 'done', returned: true, finishedAt: new Date(now - 1_000).toISOString(), completion: { status: 'completed', summary: 'done', output: 'PR #2030 is ready' } };
    const completed: FleetJobView = { ...direct, jobId: 'completed', status: 'completed', finishedAt: completedTask.finishedAt, tasks: [completedTask] };
    const parkedTask = { ...task(0, 'manager'), status: 'parked', state: 'parked', promotedToTab: true };
    const parked: FleetJobView = { ...direct, jobId: 'parked', status: 'parked', waitingOnChildren: 0, tasks: [{ ...parkedTask, descendantsRunning: 2 }] };
    const output = await new SubagentDirectoryBuilder(new FleetReader([completed, parked]) as any, new AgentTeamRollupProjector(() => now), () => now).build('root');
    expect(output).toContain('finished-worker: "PR #2030 is ready"');
    expect(output).not.toContain('[object Object]');
    expect(output).toContain('hidden→tab');
    expect(output).toContain('parked, waiting on 0 children');
    expect(output).toContain('2 running descendants beneath them');
  });

  it('budgets whole lines and reports omitted rows without slicing tokens', async() => {
    // risk: bounded prompt output corrupts a worker result or management instruction mid-line
    const tasks = Array.from({ length: 30 }, (_, index) => ({ ...task(index, `worker-${ index }-${ 'x'.repeat(180) }`) }));
    const output = await new SubagentDirectoryBuilder(new FleetReader([{ ...direct, tasks }]) as any, new AgentTeamRollupProjector(() => now), () => now).build('root');
    expect(output.length).toBeLessThanOrEqual(SUBAGENT_DIRECTORY_MAX_CHARS);
    expect(output).toMatch(/… \d+ more:/);
    expect(output.split('\n').every(line => line === '' || line.startsWith('#') || line.startsWith('-') || line.startsWith('Direct') || line.startsWith('These') || line.startsWith('⚠'))).toBe(true);
  });
});
