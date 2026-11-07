// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentFleetProjectionService } from '../../../app/Services/AgentFleetProjectionService';
import { AgentLineageIndex } from '../../../app/Services/AgentLineageIndex';
import type { AgentJob } from '../../../tools/agents/jobRegistry';

const task = (threadId: string, agentId = 'worker') => ({ agentId, label: agentId, prompt: 'work', status: 'running' as const, threadId });
const job = (jobId: string, parentThreadId: string, tasks: ReturnType<typeof task>[], createdAt: number, parentAgentId = 'sulla'): AgentJob => ({
  jobId, parentThreadId, parentAgentId, tasks, createdAt, status: 'running', finishedAt: null, taskCount: tasks.length, results: [],
});

class FleetStateReader {
  constructor(private readonly values: AgentJob[]) {}
  async jobs() { return this.values; }
  async list() { return this.values; }
  async job(jobId: string) { return this.values.find(value => value.jobId === jobId); }
}
class FleetTelemetryReader {
  async telemetryForJob() { return {}; }
  async latestTelemetryForJobs() { return {}; }
}
class FleetTitleReader {
  calls: string[][] = [];
  async titlesForThreadIds(ids: string[]) { this.calls.push(ids); return Object.fromEntries(ids.map(id => [id, `Title ${ id }`])); }
}

describe('AgentFleetProjectionService', () => {
  it('isolates recursive descendants by calling thread and enriches every job and task from one bulk title read', async() => {
    // risk: policy / cross-chat data exposure
    const values = [
      job('a-manager', 'root-a', [task('a-unused'), task('a-manager-thread', 'manager')], 1),
      job('a-worker', 'a-manager-thread', [task('a-worker-thread')], 2, 'manager'),
      job('a-grandchild', 'a-worker-thread', [task('a-grandchild-thread')], 3, 'worker'),
      job('b-manager', 'root-b', [task('b-manager-thread', 'manager')], 4),
      job('b-worker', 'b-manager-thread', [task('b-worker-thread')], 5, 'manager'),
    ];
    const titles = new FleetTitleReader();
    const fleet = new AgentFleetProjectionService(new FleetStateReader(values) as any, new FleetTelemetryReader(), titles as any, () => 10_000);

    const mine = await fleet.list({ scope: 'mine', callerThreadId: 'root-a' });
    expect(mine.map(value => value.jobId)).toEqual(['a-grandchild', 'a-worker', 'a-manager']);
    expect(mine.some(value => String(value.jobId).startsWith('b-'))).toBe(false);
    expect(mine[1]).toMatchObject({ parentThreadId: 'a-manager-thread', parentAgentId: 'manager', parentJobId: 'a-manager', parentTaskIndex: 1, rootThreadId: 'root-a', rootChatTitle: 'Title root-a' });
    expect((mine[1].tasks as any[])[0]).toMatchObject({ parentJobId: 'a-manager', parentTaskIndex: 1, rootThreadId: 'root-a', rootChatTitle: 'Title root-a' });
    expect(titles.calls).toEqual([['root-a']]);

    const all = await fleet.list({ scope: 'all' });
    expect(all.map(value => value.jobId)).toEqual([...values].reverse().map(value => value.jobId));
    expect(titles.calls[1].sort()).toEqual(['root-a', 'root-b']);
  });

  it('bounds malformed orphan and cyclic ancestry without leaking unrelated jobs', () => {
    // risk: corrupt lineage hangs a fleet read or broadens ownership scope
    const orphan = job('orphan', 'missing-thread', [task('orphan-thread')], 1);
    const first = job('cycle-a', 'cycle-b-thread', [task('cycle-a-thread')], 2);
    const second = job('cycle-b', 'cycle-a-thread', [task('cycle-b-thread')], 3);
    const index = new AgentLineageIndex([orphan, first, second]);
    expect(index.lineage(orphan)).toEqual({ parentJobId: null, parentTaskIndex: null, rootThreadId: 'missing-thread' });
    expect(index.lineage(first).rootThreadId).toBeTruthy();
    expect(index.descendants('missing-thread').map(value => value.jobId)).toEqual(['orphan']);
    expect(index.descendants('unrelated')).toEqual([]);
  });
});
