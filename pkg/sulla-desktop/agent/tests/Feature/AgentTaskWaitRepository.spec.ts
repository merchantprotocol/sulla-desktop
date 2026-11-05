// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentTaskWait } from '../../app/Repositories/AgentTaskWaitRepository';
import { TestDatabase } from '../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('AgentTaskWaitRepository with real Postgres', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../tools/agents/jobRegistry');
  let provider: typeof import('../../services/AgentWaitServices').agentWaitProvider;
  let repository: typeof provider.repository;

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../database/PostgresClient');
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    await database.applyMigrations();
    registry = await import('../../tools/agents/jobRegistry');
    provider = (await import('../../services/AgentWaitServices')).agentWaitProvider;
    repository = provider.repository;
  }, 60_000);

  afterAll(async() => database.dispose());

  const schedule = async(wait: AgentTaskWait): Promise<boolean> => {
    try {
      await provider.parking.park(wait.jobId, wait.taskIndex, { wakeAt: wait.wakeAt, reason: wait.reason } as any); return true;
    } catch (error) {
      if ((error as Error).message.includes('no longer running')) return false;
      throw new Error(`schedule threw: ${ (error as Error).message }`, { cause: error });
    }
  };

  it('atomically schedules and parks a running task, then enforces claim/cancel CAS', async() => {
    // risk: lifecycle policy — a successful wait must survive process loss and wake at most once.
    const job = await registry.createJob([
      { agentId: 'worker', label: 'waiter', prompt: 'wait', status: 'running', threadId: 'waiter-thread' },
    ]);
    const wakeAt = new Date(Date.now() + 60_000);
    expect(await schedule({ jobId: job.jobId, taskIndex: 0, wakeAt, reason: 'durable wait', state: 'scheduled' })).toBe(true);

    const rows = await database.query<any>('SELECT * FROM agent_task_waits WHERE job_id=$1 AND task_index=0', [job.jobId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('scheduled');
    expect(rows[0].reason).toBe('durable wait');
    const persisted = await database.query<any>('SELECT status, tasks FROM agent_jobs WHERE job_id=$1', [job.jobId]);
    expect(persisted[0].status).toBe('parked');
    expect(persisted[0].tasks[0]).toMatchObject({ status: 'parked', waitReason: 'durable wait', wakeAt: wakeAt.getTime() });

    expect(await repository.claim(job.jobId, 0)).toMatchObject({ state: 'claimed', reason: 'durable wait' });
    expect(await repository.claim(job.jobId, 0)).toBeNull();
    expect(await repository.cancel(job.jobId, 0)).toBe(false);
  });

  it('keeps the job running while a sibling task remains running', async() => {
    // risk: lifecycle policy — parking one sibling must not hide another live worker from recovery.
    const job = await registry.createJob([
      { agentId: 'worker', label: 'waiter', prompt: 'wait', status: 'running', threadId: 'first-thread' },
      { agentId: 'worker', label: 'runner', prompt: 'run', status: 'running', threadId: 'second-thread' },
    ]);
    expect(await schedule({ jobId: job.jobId, taskIndex: 0, wakeAt: new Date(Date.now() + 60_000), reason: 'sibling wait', state: 'scheduled' })).toBe(true);
    const rows = await database.query<any>('SELECT status, tasks FROM agent_jobs WHERE job_id=$1', [job.jobId]);
    expect(rows[0].status).toBe('running');
    expect(rows[0].tasks.map((task: any) => task.status)).toEqual(['parked', 'running']);
    expect(await repository.cancel(job.jobId, 0)).toBe(true);
    expect(await repository.cancel(job.jobId, 0)).toBe(false);
  });

  it('refuses to schedule a wait for a task that is not running', async() => {
    // risk: lifecycle policy — terminal or already parked work must not be resurrected by a new timer.
    const job = await registry.createJob([
      { agentId: 'worker', label: 'done', prompt: 'done', status: 'completed', threadId: 'done-thread' },
    ]);
    expect(await schedule({ jobId: job.jobId, taskIndex: 0, wakeAt: new Date(Date.now() + 60_000), reason: 'invalid wait', state: 'scheduled' })).toBe(false);
    expect(await repository.pending(job.jobId, 0)).toBeNull();
  });
});
