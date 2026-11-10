// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentFleetProjectionService } from '../../../app/Services/AgentFleetProjectionService';
import type { FleetJobView, FleetTaskView } from '../../../app/Services/AgentFleetTypes';
import { AgentTaskActivityProjector } from '../../../app/Services/AgentTaskActivityProjector';
import { AgentTeamRollupProjector } from '../../../app/Services/AgentTeamRollupProjector';
import { DescendantWaitCounter } from '../../../app/Services/DescendantWaitCounter';
import { AgentLineageIndex } from '../../../app/Services/AgentLineageIndex';
import { UnresolvedBlockerPolicy } from '../../../app/Services/UnresolvedBlockerPolicy';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

const now = 1_000_000;
const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({ agentId: 'worker', label: 'Worker', prompt: 'work', status: 'running', threadId: 'thread', startedAt: 100_000, ...overrides });
const job = (jobId: string, parentThreadId: string, tasks: AgentJobTask[], overrides: Partial<AgentJob> = {}): AgentJob => ({ jobId, parentThreadId, tasks, createdAt: 100_000, status: 'running', finishedAt: null, taskCount: tasks.length, results: [], ...overrides });

class StateReader {
  constructor(private readonly values: AgentJob[]) {}
  async jobs() { return this.values; }
  async list() { return this.values; }
  async job(jobId: string) { return this.values.find(value => value.jobId === jobId); }
}
class TelemetryReader {
  constructor(private readonly byJob: Record<string, Record<number, { latestCheckin: any; checkins: any[]; undeliveredMessages: number; lastMessageDeliveredAt?: number | null }>> = {}) {}
  async telemetryForJob(jobId: string) { return this.byJob[jobId] ?? {}; }
  async latestTelemetryForJobs() { return this.byJob; }
}
class TitleReader {
  async titlesForThreadIds(ids: string[]) { return Object.fromEntries(ids.map(id => [id, `Title ${ id }`])); }
}
const checkin = (blockers: string[], createdAt = 150_000) => ({ step: 'step', summary: 'summary', filesTouched: [], blockers, createdAt });
const fleetView = (values: AgentJob[], telemetry: TelemetryReader) => new AgentFleetProjectionService(new StateReader(values) as any, telemetry as any, new TitleReader() as any, () => now);
const liveTask = (index: number, state: string, overrides: Partial<FleetTaskView> = {}): FleetTaskView => ({ taskIndex: index, agentId: 'w', label: 'w', status: state, state, returned: false, startedAt: new Date(100_000).toISOString(), finishedAt: null, returnedAt: null, completionDeliveredAt: null, lastActivityAt: new Date(150_000).toISOString(), threadId: null, parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null, ...overrides });

describe('fleet status truth', () => {
  it('hides a terminal task inside a still-open job when includeFinished is false, and keeps the job while it has a live task', async() => {
    // risk: managers act on a finished worker as if it were still running
    const values = [job('open', 'root', [task({ status: 'completed', finishedAt: 120_000, threadId: 'done' }), task({ threadId: 'live', startedAt: now - 1_000 })])];
    const views = await fleetView(values, new TelemetryReader()).list({ scope: 'all', includeFinished: false });
    expect(views.map(view => view.jobId)).toEqual(['open']);
    expect(views[0].tasks.map(view => view.state)).toEqual(['working']);
  });

  it('drops a job row whose only tasks are terminal even though the job status is still running', async() => {
    // risk: phantom running job in the live list
    const values = [job('stale', 'root', [task({ status: 'completed', finishedAt: 120_000 })])];
    expect(await fleetView(values, new TelemetryReader()).list({ scope: 'all', includeFinished: false })).toEqual([]);
  });

  it('does not count a blocker left by a worker that later returned or stopped', () => {
    // risk: a finished worker's old blocker keeps the team showing blocked
    const projector = new AgentTaskActivityProjector({ lastActivityAt: () => undefined }, () => now);
    const returned = task({ status: 'completed', returnedAt: 140_000, finishedAt: 140_000 });
    const stopped = task({ status: 'stopped', finishedAt: 160_000 });
    expect(projector.project(job('a', 'root', [returned]), returned, 0, checkin(['need key'])).state).toBe('done');
    expect(projector.project(job('b', 'root', [stopped]), stopped, 0, checkin(['need key'])).state).toBe('stopped');
    const returnedButRunning = task({ status: 'running', returnedAt: 140_000 });
    expect(projector.project(job('c', 'root', [returnedButRunning]), returnedButRunning, 0, checkin(['need key'])).state).toBe('done');
  });

  it('does not count a blocker that the parent answered after it was raised', () => {
    // risk: a blocker already answered keeps showing as an open blocker
    const projector = new AgentTaskActivityProjector({ lastActivityAt: () => undefined }, () => now);
    const live = task({ status: 'running' });
    expect(projector.project(job('a', 'root', [live]), live, 0, checkin(['need key'], 150_000), 160_000).state).not.toBe('blocked');
    expect(new UnresolvedBlockerPolicy().unresolvedCount({ task: live, checkin: checkin(['need key'], 150_000), answeredAt: 160_000, startedAt: 100_000 })).toBe(0);
  });

  it('counts a live unanswered blocker in the task state and in the team rollup', () => {
    // risk: a real blocked worker is hidden from the manager
    const projector = new AgentTaskActivityProjector({ lastActivityAt: () => undefined }, () => now);
    const live = task({ status: 'running' });
    const blockedView = projector.project(job('a', 'root', [live]), live, 0, checkin(['need key'], 150_000), 140_000);
    expect(blockedView.state).toBe('blocked');
    const rollup = new AgentTeamRollupProjector(() => now).project([
      { jobId: 'parent', status: 'running', createdAt: '', finishedAt: null, parentThreadId: 'root', parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', tasks: [liveTask(0, 'working', { threadId: 'child-thread' })] } as FleetJobView,
      { jobId: 'child', status: 'running', createdAt: '', finishedAt: null, parentThreadId: 'child-thread', parentJobId: 'parent', parentTaskIndex: 0, rootThreadId: 'root', tasks: [liveTask(0, 'blocked', { latestCheckin: { step: 's', summary: 's', blockers: ['need key'], time: '' } })] } as FleetJobView,
    ]);
    expect(rollup.get('parent#0')).toMatchObject({ openBlockers: 1 });
  });

  it('reports a manager with a running grandchild as waiting on that descendant', async() => {
    // risk: a parked manager says it waits on 0 children while a grandchild still runs (O59)
    const manager = job('manager', 'root', [task({ threadId: 'manager-thread', status: 'parked' })]);
    const child = job('child', 'manager-thread', [task({ threadId: 'child-thread' })]);
    const grandchild = job('grandchild', 'child-thread', [task({ threadId: 'grand-thread' })]);
    const views = await fleetView([manager, child, grandchild], new TelemetryReader()).list({ scope: 'all', includeFinished: false });
    const managerView = views.find(view => view.jobId === 'manager');
    expect(managerView?.tasks[0]).toMatchObject({ state: 'parked', descendantsRunning: 2 });
    expect(new DescendantWaitCounter(new AgentLineageIndex([manager, child, grandchild])).runningDescendantsOf(manager.tasks[0])).toBe(2);
  });
});
