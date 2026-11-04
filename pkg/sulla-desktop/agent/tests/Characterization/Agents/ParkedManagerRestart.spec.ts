// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentJobRepository } from '../../../app/Repositories/AgentJobRepository';
import { CompletionInboxStore } from '../../../services/AgentCompletionInbox';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('parked manager restart harness', () => {
  const database = new TestDatabase();
  let repository: AgentJobRepository;

  beforeAll(async() => {
    await database.initialize();
    const connection = new PostgresConnection({ query: async(sql, bindings) => ({
      rows: await database.query(sql, [...(bindings ?? [])]),
      rowCount: 0,
    }) });
    repository = new AgentJobRepository(connection);
  }, 60_000);
  afterAll(async() => database.dispose());

  it('retains exact parked identity and child dependency across a cold runtime', async() => {
    // risk: restart rehydrates a manager as the default agent or sweeps it failed
    await repository.insertJob({
      jobId: 'restart-manager', status: 'running', createdAt: Date.now(), finishedAt: null,
      taskCount: 1, results: [], parentChannel: 'sulla-desktop', parentThreadId: 'root-thread',
      parentAgentId: 'sulla-desktop', visibility: 'hidden',
      tasks: [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own epic', status: 'running', threadId: 'manager-thread', depth: 1 }],
    });
    await repository.insertJob({
      jobId: 'restart-worker', status: 'running', createdAt: Date.now(), finishedAt: null,
      taskCount: 1, results: [], parentChannel: 'coding-manager-sol', parentThreadId: 'manager-thread',
      parentAgentId: 'coding-manager-sol', visibility: 'hidden',
      tasks: [{ agentId: 'codex-sol-worker', label: 'worker', prompt: 'build', status: 'running', threadId: 'worker-thread', depth: 2 }],
    });
    const manager = (await repository.job('restart-manager'))!;
    manager.status = 'parked';
    manager.tasks[0].status = 'parked';
    await repository.park(manager.jobId, manager.tasks, 1);

    // New repository and inbox instances model a process restart: no graph,
    // no timers and no in-memory delivery state, with only Postgres retained.
    const restarted = new AgentJobRepository((repository as any).connection);
    const inbox = new CompletionInboxStore();
    await restarted.sweepInterruptedJobs();
    const restored = await restarted.findByTaskThread('manager-thread');
    expect(restored).toMatchObject({ status: 'parked', waitingOnChildren: 1 });
    expect(restored?.tasks[0]).toMatchObject({ agentId: 'coding-manager-sol', threadId: 'manager-thread', status: 'parked' });
    expect(inbox.take('coding-manager-sol', 'manager-thread')).toEqual([]);
  });

  it('never mutates a parked manager on repeated reads and never resurrects terminal jobs', async() => {
    // risk: observation changes custody or restart resurrects stopped work
    for (let index = 0; index < 10; index++) expect((await repository.job('restart-manager'))?.status).toBe('parked');
    const stopped = (await repository.job('restart-worker'))!;
    stopped.tasks[0].status = 'stopped';
    await repository.stop(stopped.jobId, stopped.tasks);
    await repository.sweepInterruptedJobs();
    expect((await repository.job(stopped.jobId))?.status).toBe('stopped');
  });
});
