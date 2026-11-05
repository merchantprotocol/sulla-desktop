// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentLivenessReconciler } from '../../app/Services/AgentLivenessReconciler';
import { AgentStateProjector } from '../../app/Services/AgentStateProjector';
import { TestDatabase } from '../Support/TestDatabase';
const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;
dbDescribe('AgentJobService state machine with real Postgres', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../tools/agents/jobRegistry');
  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    registry = await import('../../tools/agents/jobRegistry');
  }, 60_000);
  afterAll(async() => database.dispose());
  it('allows running jobs to become completed, failed, or stopped and forbids terminal transitions', async() => {
    // risk: core business state machine
    const completed = await registry.createJob(0);
    await registry.completeJob(completed.jobId, []);
    await registry.failJob(completed.jobId, 'late failure');
    await registry.completeJob(completed.jobId, [{ label: 'late', status: 'error', output: 'late', threadId: 'late' }]);
    expect((await registry.getJob(completed.jobId))?.status).toBe('completed');
    const failed = await registry.createJob(0);
    await registry.failJob(failed.jobId, 'expected');
    await registry.completeJob(failed.jobId, []);
    expect((await registry.getJob(failed.jobId))?.status).toBe('failed');
    const stopped = await registry.createJob(0);
    expect(registry.abortJob(stopped.jobId)).toBe('stopped');
    await registry.completeJob(stopped.jobId, []);
    expect((await registry.getJob(stopped.jobId))?.status).toBe('stopped');
    expect(registry.abortJob(stopped.jobId)).toBe('already-finished');
  });
  it('claims an interrupted hidden job for bounded restart recovery without failing parked managers', async() => {
    // risk: restart silently kills delegated work or creates an infinite boot loop
    const hiddenId = `hydrate-hidden-${ Date.now() }`;
    const parkedId = `hydrate-parked-${ Date.now() }`;
    await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, created_at, tasks, visibility) VALUES
      ($1, 'running', 1, now(), '[{"agentId":"worker","status":"running","threadId":"worker-thread"}]', 'hidden'),
      ($2, 'parked', 1, now(), '[{"agentId":"manager","status":"parked","threadId":"manager-thread"}]', 'hidden')`, [hiddenId, parkedId]);
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const first = await agentJobProvider.jobs.claimInterruptedJobs(2);
    expect(first.resumable.map(job => job.jobId)).toContain(hiddenId);
    expect((await agentJobProvider.jobs.job(hiddenId))?.status).toBe('running');
    expect((await agentJobProvider.jobs.job(parkedId))?.status).toBe('parked');
    await agentJobProvider.jobs.claimInterruptedJobs(2);
    const exhausted = await agentJobProvider.jobs.claimInterruptedJobs(2);
    expect(exhausted.exhausted.map(job => job.jobId)).toContain(hiddenId);
    expect((await agentJobProvider.jobs.job(hiddenId))?.status).toBe('failed');
  });

  it('stops a manager and every open descendant idempotently without changing terminal rows', async() => {
    // risk: stopped managers leave workers producing irreversible side effects
    const root = await registry.createJob([{ agentId: 'manager', label: 'manager', prompt: 'x', status: 'running', threadId: 'manager-thread' }]);
    const child = await registry.createJob([{ agentId: 'worker', label: 'worker', prompt: 'x', status: 'running', threadId: 'worker-thread' }], 'manager', 'manager-thread');
    const grandchild = await registry.createJob([{ agentId: 'sub', label: 'sub', prompt: 'x', status: 'running', threadId: 'sub-thread' }], 'worker', 'worker-thread');
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const versions: number[] = []; const unsubscribe = agentJobProvider.states.onChange(version => versions.push(version));
    expect((await agentJobProvider.states.descendants('manager-thread')).map(job => job.jobId)).toEqual([child.jobId, grandchild.jobId]);
    expect(await registry.stopJobCascade(root.jobId)).toBe('stopped');
    unsubscribe();
    expect(versions).toHaveLength(1);
    for (const candidate of [root, child, grandchild]) {
      expect(agentJobProvider.runtime.jobs.get(candidate.jobId)?.status).toBe('stopped');
      const [durable] = await database.query<{ status: string }>('SELECT status FROM agent_jobs WHERE job_id = $1', [candidate.jobId]);
      expect(durable.status).toBe('stopped');
    }
    expect(await registry.stopJobCascade(root.jobId)).toBe('already-finished');
  });
  it('acknowledges completion delivery once even when retried', async() => {
    // risk: duplicate irreversible side effect
    const job = await registry.createJob(0, 'parent', 'parent-thread');
    await registry.completeJob(job.jobId, []);
    await registry.markCompletionDelivered(job.jobId);
    const deliveredAt = (await registry.getJob(job.jobId))?.completionDeliveredAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    await registry.markCompletionDelivered(job.jobId);
    expect((await registry.getJob(job.jobId))?.completionDeliveredAt).toBe(deliveredAt);
    expect((await registry.getPendingCompletions()).some(item => item.jobId === job.jobId)).toBe(false);
  });
  it('evicts only settled cache entries and rehydrates them from Postgres on demand', async() => {
    // risk: cache bounding deletes durable history or drops live and parked work
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const settled = await registry.createJob(0);
    await registry.completeJob(settled.jobId, []);
    const running = await registry.createJob(0);
    const parked = await registry.createJob([{ agentId: 'worker', label: 'parked', prompt: 'work', status: 'running' }]);

    expect(agentJobProvider.runtime.evictSettledTerminalJobs(0)).toContain(settled.jobId);
    expect(agentJobProvider.runtime.jobs.has(running.jobId)).toBe(true);
    parked.status = 'completed';
    parked.finishedAt = Date.now();
    expect(agentJobProvider.runtime.evictSettledTerminalJobs(0)).not.toContain(parked.jobId);
    expect(agentJobProvider.runtime.jobs.has(parked.jobId)).toBe(true);
    expect((await registry.getJob(settled.jobId))?.status).toBe('completed');
  });

  it('reconciles a stale running task through Postgres, cache, and the renderer snapshot', async() => {
    // risk: a dead process remains actionable because durable and cached liveness disagree
    const jobId = `stale-state-${ Date.now() }`;
    await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, created_at, tasks, visibility)
      VALUES ($1, 'running', 1, now() - interval '10 minutes', $2::jsonb, 'hidden')`, [jobId, JSON.stringify([{
      agentId: 'worker', label: 'Stale worker', prompt: 'work', status: 'running', startedAt: Date.now() - 600_000,
    }])]);
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const reconciler = new AgentLivenessReconciler(agentJobProvider.states, {
      graph: () => false,
      container: async() => false,
      lastCheckin: async() => null,
    }, Date.now, { quietAfterMs: 60_000, lostAfterMs: 5 * 60_000 });

    await reconciler.reconcile();

    const [durable] = await database.query<{ status: string; tasks: Array<{ status: string }> }>(
      'SELECT status, tasks FROM agent_jobs WHERE job_id = $1', [jobId]);
    expect(durable).toMatchObject({ status: 'failed', tasks: [{ status: 'error' }] });
    expect(agentJobProvider.runtime.jobs.get(jobId)).toMatchObject({ status: 'failed', tasks: [{ status: 'error' }] });
    const snapshot = await new AgentStateProjector(agentJobProvider.states, { latest: async() => null }).snapshot();
    expect(snapshot.rows.find(row => row.jobId === jobId)).toMatchObject({ state: 'lost', canMessage: false, canStop: false });
  });

  it('does not mark a live container task lost while runtime rebind is pending', async() => {
    // risk: Desktop restart falsely kills a still-running container agent
    const jobId = `rebind-race-${ Date.now() }`;
    await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, created_at, tasks, visibility)
      VALUES ($1, 'running', 1, now() - interval '20 minutes', $2::jsonb, 'hidden')`, [jobId, JSON.stringify([{
      agentId: 'worker', status: 'running', runLocation: 'container', threadId: 'rebind-thread', startedAt: Date.now() - 1_200_000,
    }])]);
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    let containerProbe: boolean | undefined;
    const reconciler = new AgentLivenessReconciler(agentJobProvider.states, {
      graph: () => false, container: async() => containerProbe, lastCheckin: async() => null,
    }, Date.now, { quietAfterMs: 60_000, lostAfterMs: 5 * 60_000 });
    expect(await reconciler.reconcile()).toBe(0);
    expect((await agentJobProvider.jobs.job(jobId))?.status).toBe('running');
    containerProbe = true;
    expect(await reconciler.reconcile()).toBe(0);
    expect((await agentJobProvider.jobs.job(jobId))?.status).toBe('running');
  });

  it('refuses a lost transition when a check-in arrives after liveness observation', async() => {
    // risk: a worker check-in races the reconciler and live work is durably killed
    const jobId = `checkin-race-${ Date.now() }`;
    const startedAt = Date.now() - 1_200_000;
    await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, created_at, tasks, visibility)
      VALUES ($1, 'running', 1, to_timestamp($2 / 1000.0), $3::jsonb, 'hidden')`, [jobId, startedAt, JSON.stringify([{
      agentId: 'race-worker', status: 'running', startedAt,
    }])]);
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const original = agentJobProvider.jobs.replaceStateIfActivityUnchanged.bind(agentJobProvider.jobs);
    const race = vi.spyOn(agentJobProvider.jobs, 'replaceStateIfActivityUnchanged').mockImplementationOnce(async(...args) => {
      await database.query(`INSERT INTO agent_job_checkins (job_id, task_index, step, summary) VALUES ($1, 0, 'alive', 'race won')`, [jobId]);
      return original(...args);
    });
    const reconciler = new AgentLivenessReconciler(agentJobProvider.states, {
      graph: task => task.agentId !== 'race-worker', container: async() => false, lastCheckin: async() => null,
    }, Date.now, { quietAfterMs: 60_000, lostAfterMs: 5 * 60_000 });
    expect(await reconciler.reconcile()).toBe(0);
    race.mockRestore();
    expect((await agentJobProvider.jobs.job(jobId))?.status).toBe('running');
    expect(agentJobProvider.runtime.jobs.get(jobId)?.status).toBe('running');
  });

  it('keeps cache unchanged and emits nothing when the Postgres repository write rejects', async() => {
    // risk: a failed durable write publishes a state Postgres never accepted
    const job = await registry.createJob([{ agentId: 'worker', label: 'write', prompt: 'x', status: 'running' }]);
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const before = structuredClone(agentJobProvider.runtime.jobs.get(job.jobId));
    const emitted = vi.fn(); const unsubscribe = agentJobProvider.states.onChange(emitted);
    const failure = vi.spyOn(agentJobProvider.jobs, 'replaceState').mockRejectedValueOnce(new Error('forced postgres failure'));
    await expect(agentJobProvider.states.transition(job.jobId, 0, { status: 'stopped' })).rejects.toThrow('forced postgres failure');
    failure.mockRestore(); unsubscribe();
    expect(agentJobProvider.runtime.jobs.get(job.jobId)).toEqual(before);
    expect(emitted).not.toHaveBeenCalled();
  });

  it('keeps memory and Postgres equal through the complete lifecycle transition set', async() => {
    // risk: lifecycle transitions split durable truth from action-button state
    const job = await registry.createJob([{ agentId: 'worker', label: 'lifecycle', prompt: 'x', status: 'queued' }]);
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const assertEqual = async() => {
      const cached = agentJobProvider.runtime.jobs.get(job.jobId);
      const durable = await agentJobProvider.jobs.job(job.jobId);
      expect(cached).toEqual(durable);
    };
    await assertEqual();
    await registry.updateJobTask(job.jobId, 0, { status: 'running', startedAt: Date.now() }); await assertEqual();
    await registry.parkJobTask(job.jobId, 0, 1); await assertEqual();
    await registry.resumeParkedJob(job.jobId, 0); await assertEqual();
    await registry.completeJob(job.jobId, [{ label: 'lifecycle', status: 'completed', output: 'ok', threadId: '' }]); await assertEqual();

    const failed = await registry.createJob([{ agentId: 'worker', label: 'failed', prompt: 'x', status: 'running' }]);
    await registry.failJob(failed.jobId, 'expected');
    expect(agentJobProvider.runtime.jobs.get(failed.jobId)).toEqual(await agentJobProvider.jobs.job(failed.jobId));
    const stopped = await registry.createJob([{ agentId: 'worker', label: 'stopped', prompt: 'x', status: 'running' }]);
    await registry.stopJobCascade(stopped.jobId);
    expect(agentJobProvider.runtime.jobs.get(stopped.jobId)).toEqual(await agentJobProvider.jobs.job(stopped.jobId));
  });

  it('repairs a contradictory job rollup from its task state in Postgres and cache', async() => {
    // risk: job=running/task=error renders as active in one reader and failed in another
    const jobId = `contradictory-state-${ Date.now() }`;
    await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, created_at, tasks, visibility)
      VALUES ($1, 'running', 1, now(), $2::jsonb, 'hidden')`, [jobId, JSON.stringify([{
      agentId: 'worker', label: 'Failed worker', prompt: 'work', status: 'error', finishedAt: Date.now(),
    }])]);
    const { agentJobProvider } = await import('../../app/Providers/AgentJobServiceProvider');
    const derived = await agentJobProvider.states.job(jobId);
    const [durable] = await database.query<{ status: string }>('SELECT status FROM agent_jobs WHERE job_id = $1', [jobId]);
    expect(derived?.status).toBe('failed');
    expect(durable.status).toBe('failed');
    const snapshot = await new AgentStateProjector(agentJobProvider.states, { latest: async() => null }).snapshot();
    expect(snapshot.rows.find(row => row.jobId === jobId)).toMatchObject({ state: 'failed', canMessage: false, canStop: false });
  });
});
