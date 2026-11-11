// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import { AgentStateProjector } from '../../../app/Services/AgentStateProjector';
import { AgentLivenessReconciler } from '../../../app/Services/AgentLivenessReconciler';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';
import { AgentTaskActivityProjector } from '../../../app/Services/AgentTaskActivityProjector';
import { AgentJobLivenessPolicy } from '../../../services/AgentJobLivenessPolicy';

// These specs exercise the lost-transition mechanics with small lostAfterMs windows; the 10-minute
// new-job grace (added in #2143) would otherwise dominate, so they opt out of it explicitly.
const noGrace = new AgentJobLivenessPolicy(0);

class InMemoryAgentStateStore implements AgentStateStore {
  readonly durable = new Map<string, AgentJob>();
  readonly observedActivity: Array<number | null> = [];
  jobsForProjection?: (recentMs: number) => Promise<AgentJob[]>;
  constructor(jobs: AgentJob[]) { for (const job of jobs) this.durable.set(job.jobId, structuredClone(job)); }
  async allJobs(): Promise<AgentJob[]> { return Array.from(this.durable.values()).map(job => structuredClone(job)); }
  async job(jobId: string): Promise<AgentJob | undefined> {
    const job = this.durable.get(jobId); return job ? structuredClone(job) : undefined;
  }
  async jobsForList(limit: number, includeFinished: boolean): Promise<AgentJob[]> {
    const jobs = (await this.allJobs()).filter(job => !job.dismissedAt).sort((a, b) => b.createdAt - a.createdAt);
    return [...jobs.filter(job => ['running', 'parked'].includes(job.status)),
      ...(includeFinished ? jobs.filter(job => !['running', 'parked'].includes(job.status)).slice(0, limit) : [])];
  }
  async insertJob(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
  async replaceState(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
  async cascadeJobs(jobId: string): Promise<AgentJob[]> { const job = this.durable.get(jobId); return job ? [structuredClone(job)] : []; }
  async replaceStateIfActivityUnchanged(job: AgentJob, _taskIndex: number, observedActivity: number | null): Promise<boolean> { this.observedActivity.push(observedActivity); this.durable.set(job.jobId, structuredClone(job)); return true; }
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
  it('uses point reads for mutation and on-demand job lookup without loading history', async() => {
    const { states, store, cache } = harness([job('worker', [task()])]);
    const history = vi.spyOn(store, 'allJobs');
    const point = vi.spyOn(store, 'job');
    await states.transition('worker', 0, { status: 'parked' });
    expect((await states.job('worker'))?.tasks[0].status).toBe('parked');
    cache.jobs.clear();
    expect((await states.jobForWrite('worker'))?.jobId).toBe('worker');
    expect(point).toHaveBeenCalledTimes(3);
    expect(history).not.toHaveBeenCalled();
  });

  it('shares an outstanding history refresh and permits another after it settles', async() => {
    const { states, store } = harness([job('worker', [task()])]);
    const durable = await store.allJobs();
    let release!: (jobs: AgentJob[]) => void;
    const read = vi.spyOn(store, 'allJobs').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = states.jobsBeforeReady();
    const second = states.jobsBeforeReady();
    expect(read).toHaveBeenCalledTimes(1);
    release(durable);
    expect(await first).toEqual(await second);
    await states.jobsBeforeReady();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('clears a failed refresh so the next read can recover', async() => {
    const { states, store } = harness([]);
    vi.spyOn(store, 'allJobs').mockRejectedValueOnce(new Error('temporary database failure'));
    await expect(states.jobsBeforeReady()).rejects.toThrow('temporary database failure');
    expect(await states.jobsBeforeReady()).toEqual([]);
  });

  it('returns compact bounded lists without caching or persisting partial jobs', async() => {
    const original = job('worker', [task({ prompt: 'keep this complete prompt' })]);
    const { states, store, cache } = harness([original]);
    cache.jobs.set(original.jobId, original);
    const compact = job('worker', [task({ status: 'error', completion: { status: 'completed' } as never })]);
    const read = vi.spyOn(store, 'jobsForList').mockResolvedValue([compact]);
    const history = vi.spyOn(store, 'allJobs');
    const write = vi.spyOn(store, 'replaceState');
    expect((await states.list(500))[0].status).toBe('completed');
    expect(read).toHaveBeenCalledWith(100, true);
    expect(cache.jobs.get('worker')?.tasks[0].prompt).toBe('keep this complete prompt');
    expect(history).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('filters derived terminal compact rows from active-only lists and bounds newest history', async() => {
    const { states, store } = harness([]);
    const stale = job('stale-running', [task({ status: 'stopped' })], { createdAt: 3 });
    const live = job('live', [task()], { createdAt: 1 });
    const older = job('old', [], { status: 'completed', createdAt: 2 });
    const read = vi.spyOn(store, 'jobsForList').mockResolvedValue([older, live, stale]);
    expect((await states.list(1, false)).map(job => job.jobId)).toEqual(['live']);
    expect(read).toHaveBeenLastCalledWith(1, false);
    expect((await states.list(1, true)).map(job => job.jobId)).toEqual(['stale-running', 'live']);
    await states.list(Number.NaN);
    expect(read).toHaveBeenLastCalledWith(25, true);
    await states.list(2.9);
    expect(read).toHaveBeenLastCalledWith(2, true);
  });

  it('bounds settled cache history while preserving complete reads and parked work', async() => {
    const finished = Array.from({ length: 105 }, (_, index) => job(`done-${ index }`, [], { status: 'completed', createdAt: index }));
    const parked = job('parked', [task({ status: 'parked' })], { status: 'parked' });
    const { states, cache } = harness([...finished, parked, job('live', [task()])]);
    const all = await states.jobs();
    expect(all).toHaveLength(107);
    expect(cache.jobs.size).toBe(102);
    expect(cache.jobs.has('done-0')).toBe(false);
    expect(cache.jobs.has('parked')).toBe(true);
    expect(cache.jobs.has('live')).toBe(true);
    expect((await states.job('done-0'))?.status).toBe('completed');
  });

  it('shares slow liveness reconciliation instead of retaining another history per tick', async() => {
    const { states } = harness([job('worker', [task()])]);
    let release!: (live: boolean) => void;
    const container = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container, lastCheckin: async() => null },
      new AgentTaskActivityProjector({ lastActivityAt: () => undefined }));
    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(container).toHaveBeenCalledTimes(1));
    release(true);
    expect(await first).toBe(0);
  });

  it('reconciles a stale running task to lost in durable and memory state and disables actions', async() => {
    // risk: stale job remains actionable after a desktop restart
    const { store, cache, states } = harness([job('stale', [task()])], 500_000);
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container: async() => false, lastCheckin: async() => null }, new AgentTaskActivityProjector({ lastActivityAt: () => undefined }), () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 }, noGrace);
    expect(await reconciler.reconcile()).toBe(1);
    expect(cache.jobs.get('stale')?.status).toBe('failed');
    expect(store.durable.get('stale')?.tasks[0].status).toBe('error');
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

  it('keeps a terminal error result failed while tolerating a stale error task with a completed result', async() => {
    // risk: result payload persistence races can either hide a real worker failure or fail a completed worker
    const failedResult = { label: 'Worker', status: 'error' as const, output: 'missing contract', threadId: 'failed-thread' };
    const completedResult = { label: 'Worker', status: 'completed' as const, output: 'done', threadId: 'completed-thread' };
    const failed = job('failed-result', [task({ status: 'error', completion: failedResult })]);
    const completed = job('completed-result', [task({ status: 'error', completion: completedResult })]);
    const { states } = harness([failed, completed]);
    const derived = await states.jobs();
    expect(derived.find(candidate => candidate.jobId === 'failed-result')?.status).toBe('failed');
    expect(derived.find(candidate => candidate.jobId === 'completed-result')?.status).toBe('completed');
  });

  it('shows an inactive task as quiet before the longer lost threshold', async() => {
    // risk: an hour-silent task is presented as actively working
    const { states } = harness([job('quiet', [task({ startedAt: 1_000 })])]);
    const snapshot = await new AgentStateProjector(states, new EmptyTelemetry(), () => 10_000, { quietAfterMs: 5_000 }).snapshot();
    expect(snapshot.rows[0]).toMatchObject({ state: 'quiet', canMessage: true, canStop: true });
  });

  it('keeps snapshot state working when task-scoped model activity is fresh but its check-in is old', async() => {
    // risk: Live Agents snapshot disagrees with fleet/check_agent_jobs during a long model or tool call
    const { states } = harness([job('active', [task({ startedAt: 100_000 })])]);
    const activity = new AgentTaskActivityProjector({ lastActivityAt: key => key === 'active#0' ? 990_000 : undefined }, () => 1_000_000);
    const snapshot = await new AgentStateProjector(states, { latest: async() => ({ createdAt: 100_000, summary: 'old', blockers: [] }) }, () => 1_000_000, {}, activity).snapshot();
    expect(snapshot.rows[0].state).toBe('working');
  });

  it('returns the complete descendant set for a root chat', async() => {
    // risk: the prompt directory and drawer omit grandchildren
    const manager = job('manager-tree', [task({ threadId: 'manager-tree-thread' })], { parentThreadId: 'root-tree' });
    const worker = job('worker-tree', [task({ threadId: 'worker-tree-thread' })], { parentThreadId: 'manager-tree-thread' });
    const outsider = job('outsider', [task({ threadId: 'outside-thread' })], { parentThreadId: 'another-root' });
    const { states } = harness([manager, worker, outsider]);
    expect((await states.descendants('root-tree')).map(candidate => candidate.jobId)).toEqual(['manager-tree', 'worker-tree']);
  });



  it('holds every state read behind successful boot reconciliation', async() => {
    // risk: startup views advertise stale running work before reconciliation
    const { states } = harness([job('startup-gate', [task()])]);
    let release!: () => void;
    states.setReadiness(new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const read = states.jobs().then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect((await read).map(candidate => candidate.jobId)).toEqual(['startup-gate']);

    states.setReadiness(Promise.reject(new Error('reconcile failed')));
    await expect(states.jobs()).rejects.toThrow('reconcile failed');
  });

  it('serves the Live Agents projection from a bounded read even when runtime inventory has failed', async() => {
    // risk: the drawer and Live Agents stay empty whenever Docker inventory is down, and every change parses the whole job history
    const { states, store } = harness([job('visible-now', [task()])]);
    const failedReadiness = Promise.reject(new Error('runtime inventory pending/retrying'));
    // The projection intentionally never awaits readiness, so consume the fixture's rejection explicitly.
    void failedReadiness.catch(() => {});
    states.setReadiness(failedReadiness);
    const bounded = vi.fn(async(_recentMs: number) => [job('visible-now', [task()])]);
    store.jobsForProjection = bounded;
    const history = vi.spyOn(store, 'allJobs');
    const snapshot = await new AgentStateProjector(states, new EmptyTelemetry(), () => 10_000).snapshot();
    expect(snapshot.rows.map(row => row.jobId)).toEqual(['visible-now']);
    expect(bounded).toHaveBeenCalledTimes(1);
    expect(history).not.toHaveBeenCalled();
  });

  it('does not mark a stale task lost while its exact RunActivity key is fresh', async() => {
    // risk: an active model/tool turn is killed because durable start/check-in timestamps are stale
    const { store, states } = harness([job('live-activity', [task({ startedAt: 100_000 })])], 500_000);
    const activity = new AgentTaskActivityProjector({ lastActivityAt: key => key === 'live-activity#0' ? 499_500 : undefined });
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container: async() => false, lastCheckin: async() => null }, activity, () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 }, noGrace);
    expect(await reconciler.reconcile()).toBe(0);
    expect(store.durable.get('live-activity')?.tasks[0].status).toBe('running');
  });

  it('uses the durable baseline for CAS after historic RunActivity ages into lost eligibility', async() => {
    // risk: an old model/tool activity timestamp permanently prevents a dead task from becoming lost
    const { store, states } = harness([job('aged-activity', [task({ startedAt: 100_000 })])], 500_000);
    const activity = new AgentTaskActivityProjector({ lastActivityAt: key => key === 'aged-activity#0' ? 200_000 : undefined });
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container: async() => false, lastCheckin: async() => null }, activity, () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 }, noGrace);
    expect(await reconciler.reconcile()).toBe(1);
    expect(store.observedActivity).toEqual([100_000]);
    expect(store.durable.get('aged-activity')?.tasks[0].status).toBe('error');
  });

  it('uses the repository check-in precedence when it predates task start', async() => {
    // risk: stale CAS baseline rejects the same lost transition Postgres would accept
    const { store, states } = harness([job('historic-checkin', [task({ startedAt: 300_000 })])], 500_000);
    const reconciler = new AgentLivenessReconciler(states, {
      graph: () => false, container: async() => false, lastCheckin: async() => 200_000,
    }, new AgentTaskActivityProjector({ lastActivityAt: () => undefined }), () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 }, noGrace);
    expect(await reconciler.reconcile()).toBe(1);
    expect(store.observedActivity).toEqual([200_000]);
  });

  it('rechecks task-scoped RunActivity immediately before the lost transition', async() => {
    // risk: a model/tool turn that starts during reconciliation is falsely marked lost
    const { store, states } = harness([job('activity-race', [task({ startedAt: 100_000 })])], 500_000);
    let reads = 0;
    const activity = new AgentTaskActivityProjector({ lastActivityAt: key => key === 'activity-race#0' && ++reads === 2 ? 499_500 : undefined });
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container: async() => false, lastCheckin: async() => null }, activity, () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 }, noGrace);
    expect(await reconciler.reconcile()).toBe(0);
    expect(store.observedActivity).toEqual([]);
    expect(store.durable.get('activity-race')?.tasks[0].status).toBe('running');
  });

  it('rechecks exact-task activity inside the serialized transition boundary', async() => {
    // risk: a live model/tool turn is killed while lost reconciliation waits behind another mutation
    const { store, cache, states } = harness([job('queued-race', [task({ startedAt: 100_000 })])], 500_000);
    let release!: () => void; let entered!: () => void; let submitted!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve });
    const didEnter = new Promise<void>(resolve => { entered = resolve });
    const didSubmit = new Promise<void>(resolve => { submitted = resolve });
    const replace = vi.spyOn(store, 'replaceState').mockImplementationOnce(async next => { entered(); await paused; store.durable.set(next.jobId, structuredClone(next)); });
    const cas = vi.spyOn(store, 'replaceStateIfActivityUnchanged');
    const realTransition = states.transitionIfActivityUnchanged.bind(states);
    const transition = vi.spyOn(states, 'transitionIfActivityUnchanged').mockImplementation((...args) => {
      const pending = realTransition(...args);
      submitted();
      return pending;
    });
    const emissions: number[] = [];
    states.onChange(version => emissions.push(version));
    const activityTimes = new Map<string, number>();
    const activity = new AgentTaskActivityProjector({ lastActivityAt: key => activityTimes.get(key) });
    const firstMutation = states.transition('queued-race', 0, { summary: 'queued mutation' });
    await didEnter;
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container: async() => false, lastCheckin: async() => null }, activity, () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 }, noGrace);
    const reconciling = reconciler.reconcile();
    await didSubmit;
    activityTimes.set('queued-race#0', 499_500);
    release();
    await firstMutation;
    const versionAfterFirstMutation = states.version;
    expect(await reconciling).toBe(0);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(cas).not.toHaveBeenCalled();
    expect(store.durable.get('queued-race')?.tasks[0]).toMatchObject({ status: 'running', summary: 'queued mutation' });
    expect(cache.jobs.get('queued-race')?.tasks[0]).toMatchObject({ status: 'running', summary: 'queued mutation' });
    expect(states.version).toBe(versionAfterFirstMutation);
    expect(emissions).toEqual([versionAfterFirstMutation]);
    replace.mockRestore();
  });

  it('protects running and blocked tasks with a future durable wake without hiding blockers', async() => {
    // risk: scheduled work is falsely lost, or an actionable blocker is mislabeled parked
    const futureWake = 600_000;
    const scheduled = job('scheduled', [task({ wakeAt: futureWake }), task({ status: 'blocked', wakeAt: futureWake })]);
    const { store, states } = harness([scheduled], 500_000);
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container: async() => false, lastCheckin: async() => null }, new AgentTaskActivityProjector({ lastActivityAt: () => undefined }), () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 }, noGrace);
    expect(await reconciler.reconcile()).toBe(0);
    expect(store.durable.get('scheduled')?.tasks.map(value => value.status)).toEqual(['running', 'blocked']);
    const rows = (await new AgentStateProjector(states, new EmptyTelemetry(), () => 500_000).snapshot()).rows;
    expect(rows.find(row => row.taskIndex === 0)?.state).toBe('parked');
    expect(rows.find(row => row.taskIndex === 1)?.state).toBe('blocked');
  });

  it('settles a job whose blocked task already returned instead of failing and re-notifying it on every restart', async() => {
    // risk: a delivered blocked result re-derives the job as running, so each restart fails it again and wakes the parent with a stale notice
    const returned = job('returned-blocked', [
      task({ status: 'blocked', returnedAt: 2_000, finishedAt: 2_000 }),
      task({ status: 'completed', returnedAt: 2_100, finishedAt: 2_100 }),
    ], { restartResumeCount: 2 });
    const open = job('open-blocker', [task({ status: 'blocked' })], { restartResumeCount: 0 });
    const { store, states } = harness([returned, open]);
    const claimed = await states.claimInterruptedJobs(2);
    expect(claimed.exhausted.map(value => value.jobId)).toEqual([]);
    expect(claimed.resumable.map(value => value.jobId)).toEqual(['open-blocker']);
    expect(store.durable.get('returned-blocked')?.status).toBe('completed');
    expect(store.durable.get('returned-blocked')?.error).toBeUndefined();
    expect((await states.job('returned-blocked'))?.status).toBe('completed');
    expect((await states.claimInterruptedJobs(2)).exhausted.map(value => value.jobId)).toEqual([]);
  });

  it('never marks an intentionally parked future-wake task lost', async() => {
    // risk: agents/wait is mistaken for a dead worker after its quiet threshold
    const parked = job('future-wake', [task({ status: 'parked', threadId: 'future-wake-thread' })], { status: 'parked' });
    const { store, states } = harness([parked], 500_000);
    const reconciler = new AgentLivenessReconciler(states, { graph: () => false, container: async() => false, lastCheckin: async() => null }, new AgentTaskActivityProjector({ lastActivityAt: () => undefined }), () => 500_000, { quietAfterMs: 100, lostAfterMs: 1_000 }, noGrace);
    expect(await reconciler.reconcile()).toBe(0);
    expect(store.durable.get('future-wake')).toMatchObject({ status: 'parked', tasks: [{ status: 'parked' }] });
    expect((await new AgentStateProjector(states, new EmptyTelemetry(), () => 500_000).snapshot()).rows[0].state).toBe('parked');
  });

  it('leaves cache unchanged and emits nothing when the durable write fails', async() => {
    // risk: a failed Postgres write is advertised as live state
    const { store, cache, states } = harness([job('write-failure', [task()])]);
    await states.jobs(); const before = structuredClone(cache.jobs.get('write-failure')); const listener = vi.fn(); states.onChange(listener);
    vi.spyOn(store, 'replaceState').mockRejectedValueOnce(new Error('postgres unavailable'));
    await expect(states.transition('write-failure', 0, { status: 'stopped' })).rejects.toThrow('postgres unavailable');
    expect(cache.jobs.get('write-failure')).toEqual(before); expect(listener).not.toHaveBeenCalled();
  });

  it('coalesces cascade stop into one committed state event', async() => {
    // risk: stop pushes duplicate or stale renderer snapshots
    const { states, cache } = harness([job('cascade', [task()])]); await states.jobs(); const listener = vi.fn(); states.onChange(listener);
    expect(await states.stopCascade('cascade')).toEqual(['cascade']);
    expect(cache.jobs.get('cascade')).toMatchObject({ status: 'stopped', tasks: [{ status: 'stopped' }] });
    expect(listener).toHaveBeenCalledTimes(1);
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
