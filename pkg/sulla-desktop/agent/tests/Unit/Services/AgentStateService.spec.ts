// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import { AgentStateProjector } from '../../../app/Services/AgentStateProjector';
import { AgentLivenessReconciler } from '../../../app/Services/AgentLivenessReconciler';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

class InMemoryAgentStateStore implements AgentStateStore {
  readonly durable = new Map<string, AgentJob>();
  constructor(jobs: AgentJob[]) { for (const job of jobs) this.durable.set(job.jobId, structuredClone(job)); }
  async allJobs(): Promise<AgentJob[]> { return Array.from(this.durable.values()).map(job => structuredClone(job)); }
  async replaceState(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
}
class EmptyTelemetry { async latest(): Promise<null> { return null; } }
const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({ agentId: 'worker', label: 'Worker', prompt: 'work', status: 'running', startedAt: 1_000, ...overrides });
const job = (jobId: string, tasks: AgentJobTask[], overrides: Partial<AgentJob> = {}): AgentJob => ({ jobId, status: 'running', createdAt: 1_000, finishedAt: null, taskCount: tasks.length, results: [], tasks, visibility: 'hidden', ...overrides });

function harness(jobs: AgentJob[], now = 10_000) {
  const store = new InMemoryAgentStateStore(jobs); const cache = { jobs: new Map<string, AgentJob>() };
  const states = new AgentStateService(store, cache, () => now);
  return { store, cache, states };
}

describe('authoritative live agent state', () => {
  it('reconciles a stale running task to lost in durable and memory state and disables actions', async() => {
    // risk: stale job remains actionable after a desktop restart
    const { store, cache, states } = harness([job('stale', [task()])], 500_000);
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container: async() => false, lastCheckin: async() => null }, () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 });
    expect(await reconciler.reconcile()).toBe(1);
    expect(cache.jobs.get('stale')?.status).toBe('failed');
    expect(store.durable.get('stale')?.tasks[0].status).toBe('lost');
    const snapshot = await new AgentStateProjector(states, new EmptyTelemetry(), () => 500_000).snapshot();
    expect(snapshot.rows[0]).toMatchObject({ state: 'lost', canMessage: false, canStop: false });
  });

  it('projects a grandchild under its manager with the root chat and depth one', async() => {
    // risk: orchestrator drawer omits workers launched by a manager
    const manager = job('manager', [task({ agentId: 'manager', threadId: 'manager-thread' })], { parentThreadId: 'root-chat' });
    const worker = job('child', [task({ threadId: 'worker-thread' })], { parentThreadId: 'manager-thread' });
    const { states } = harness([manager, worker]);
    const snapshot = await new AgentStateProjector(states, new EmptyTelemetry(), () => 10_000).snapshot();
    expect(snapshot.rows.find(row => row.jobId === 'child')).toMatchObject({ parentJobId: 'manager', parentTaskIndex: 0, rootThreadId: 'root-chat', depth: 1 });
  });

  it('shows a parked manager working for its wake turn then parked with live children', async() => {
    // risk: a woken manager disappears or lies parked while executing
    const manager = job('manager', [task({ agentId: 'manager', threadId: 'manager-thread', status: 'parked' })], { status: 'parked', parentThreadId: 'root-chat', waitingOnChildren: 1 });
    const child = job('child', [task({ threadId: 'child-thread' })], { parentThreadId: 'manager-thread' });
    const { states } = harness([manager, child]); const projector = new AgentStateProjector(states, new EmptyTelemetry(), () => 10_000);
    await states.transition('manager', 0, { status: 'running' }, { status: 'running', waitingOnChildren: 0 });
    expect((await projector.snapshot()).rows.find(row => row.jobId === 'manager')?.state).toBe('working');
    await states.transition('manager', 0, { status: 'parked' }, { status: 'parked', waitingOnChildren: 1 });
    expect((await projector.snapshot()).rows.find(row => row.jobId === 'manager')).toMatchObject({ state: 'parked', waitingOnChildren: 1 });
  });


  it('derives a failed job summary from an error task and repairs the durable rollup', async() => {
    // risk: job and task status contradictions lie in every fleet view
    const contradictory = job('contradiction', [task({ status: 'error', summary: 'failed child' })]);
    const { store, states } = harness([contradictory]);
    const [derived] = await states.jobs();
    expect(derived.status).toBe('failed');
    expect(store.durable.get('contradiction')?.status).toBe('failed');
    const snapshot = await new AgentStateProjector(states, new EmptyTelemetry(), () => 10_000).snapshot();
    expect(snapshot.rows[0]).toMatchObject({ state: 'failed', canMessage: false, canStop: false });
  });

  it('shows an inactive task as quiet before the longer lost threshold', async() => {
    // risk: an hour-silent task is presented as actively working
    const { states } = harness([job('quiet', [task({ startedAt: 1_000 })])]);
    const snapshot = await new AgentStateProjector(states, new EmptyTelemetry(), () => 10_000, { quietAfterMs: 5_000 }).snapshot();
    expect(snapshot.rows[0]).toMatchObject({ state: 'quiet', canMessage: true, canStop: true });
  });

  it('returns the complete descendant set for a root chat', async() => {
    // risk: the prompt directory and drawer omit grandchildren
    const manager = job('manager-tree', [task({ threadId: 'manager-tree-thread' })], { parentThreadId: 'root-tree' });
    const worker = job('worker-tree', [task({ threadId: 'worker-tree-thread' })], { parentThreadId: 'manager-tree-thread' });
    const outsider = job('outsider', [task({ threadId: 'outside-thread' })], { parentThreadId: 'another-root' });
    const { states } = harness([manager, worker, outsider]);
    expect((await states.descendants('root-tree')).map(candidate => candidate.jobId)).toEqual(['manager-tree', 'worker-tree']);
  });

  it('writes every scripted transition to task and job together and emits increasing versions', async() => {
    // risk: PostgreSQL and hot cache disagree, producing ghost action buttons
    const { store, cache, states } = harness([job('sequence', [task({ status: 'queued', startedAt: undefined })])]);
    const versions: number[] = []; states.onChange(version => versions.push(version));
    for (const [taskStatus, jobStatus] of [['running', 'running'], ['parked', 'parked'], ['running', 'running'], ['stopped', 'stopped']] as const) {
      await states.transition('sequence', 0, { status: taskStatus }, { status: jobStatus, ...(jobStatus === 'stopped' ? { finishedAt: 10_000 } : {}) });
      expect(cache.jobs.get('sequence')).toEqual(store.durable.get('sequence'));
    }
    expect(versions).toHaveLength(4); expect(versions.every((version, index) => index === 0 || version > versions[index - 1])).toBe(true);
    expect(store.durable.get('sequence')).toMatchObject({ status: 'stopped', tasks: [{ status: 'stopped' }] });
  });
});
