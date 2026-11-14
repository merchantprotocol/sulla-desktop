// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AgentJobMessagingRepository } from '../../../app/Repositories/AgentJobMessagingRepository';
import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({ agentId: 'worker', label: 'Worker', prompt: 'work', status: 'running', startedAt: 1_000, ...overrides });
const job = (jobId: string, tasks: AgentJobTask[], overrides: Partial<AgentJob> = {}): AgentJob => ({ jobId, status: 'running', createdAt: 1_000, finishedAt: null, taskCount: tasks.length, results: [], tasks, visibility: 'hidden', ...overrides });

function stateHarness(jobs: AgentJob[]) {
  const durable = new Map(jobs.map(item => [item.jobId, structuredClone(item)]));
  const store = {
    allJobs: async() => [...durable.values()].map(item => structuredClone(item)),
    job: async(id: string) => { const found = durable.get(id); return found ? structuredClone(found) : undefined; },
    jobsForList: async() => [],
    insertJob: vi.fn(async(item: AgentJob) => { durable.set(item.jobId, structuredClone(item)); }),
    replaceState: vi.fn(async(item: AgentJob) => { durable.set(item.jobId, structuredClone(item)); }),
    cascadeJobs: async() => [],
    replaceStateIfActivityUnchanged: async() => true,
    lineageForParentThread: vi.fn(async() => [...durable.values()].map(item => structuredClone(item))),
  } satisfies AgentStateStore;
  let now = 10_000;
  const states = new AgentStateService(store, { jobs: new Map() }, () => now);
  return { store, states, advance: (ms: number) => { now += ms; } };
}

describe('agent polling load', () => {
  it('collapses 50 concurrent and 50 sequential lineage reads into one query', async() => {
    const { store, states } = stateHarness([job('w', [task({ threadId: 't' })], { parentThreadId: 'p' })]);
    await Promise.all(Array.from({ length: 50 }, () => states.descendants('p')));
    for (let i = 0; i < 50; i++) await states.descendants('p');
    expect(store.lineageForParentThread).toHaveBeenCalledTimes(1);
  });

  it('invalidates the lineage cache on a real write but not on a no-op mutation', async() => {
    const { store, states } = stateHarness([job('w', [task({ threadId: 't' })], { parentThreadId: 'p' })]);
    await states.descendants('p');
    await states.update('w', current => current);
    expect(store.replaceState).not.toHaveBeenCalled();
    await states.descendants('p');
    expect(store.lineageForParentThread).toHaveBeenCalledTimes(1);
    await states.transition('w', 0, { status: 'parked' });
    expect(store.replaceState).toHaveBeenCalledTimes(1);
    expect((await states.descendants('p'))[0].tasks[0].status).toBe('parked');
    expect(store.lineageForParentThread).toHaveBeenCalledTimes(2);
  });

  it('expires the lineage cache after its ceiling', async() => {
    const { store, states, advance } = stateHarness([job('w', [], { parentThreadId: 'p' })]);
    await states.descendants('p'); advance(6_001); await states.descendants('p');
    expect(store.lineageForParentThread).toHaveBeenCalledTimes(2);
  });

  it('never rewrites an unchanged row during repeated reconciliation', async() => {
    const { store, states } = stateHarness([job('w', [task()])]);
    for (let i = 0; i < 20; i++) await states.update('w', current => ({ ...current }));
    expect(store.replaceState).not.toHaveBeenCalled();
  });
});

function messagingHarness() {
  const select = vi.fn(async(sql: string) => {
    if (sql.includes('agent_job_checkins')) return [{ job_id: 'j', task_index: 0, step: 's', summary: 'x', files_touched: [], blockers: [], percent: null, created_at: new Date(1000) }];
    if (sql.includes('agent_job_messages')) return [{ job_id: 'j', task_index: 0, count: 1, last_delivered_at: null }];
    return [];
  });
  const run = vi.fn(async() => undefined);
  let now = 0;
  const repository = new AgentJobMessagingRepository({ select, run } as never);
  repository.setClock(() => now);
  return { repository, select, run, advance: (ms: number) => { now += ms; } };
}

describe('telemetry polling load', () => {
  it('serves 100 repeated and concurrent identical reads from one query pair', async() => {
    const { repository, select } = messagingHarness();
    await Promise.all(Array.from({ length: 50 }, () => repository.latestTelemetryForJobs(['j', 'k'])));
    for (let i = 0; i < 50; i++) expect((await repository.latestTelemetryForJobs(['k', 'j']))['j'][0].undeliveredMessages).toBe(1);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('re-reads after a message delivery write and after the TTL', async() => {
    const { repository, select, advance } = messagingHarness();
    await repository.latestTelemetryForJobs(['j']);
    await repository.markMessagesDelivered(['m'], 't');
    await repository.latestTelemetryForJobs(['j']);
    expect(select).toHaveBeenCalledTimes(4);
    advance(5_001);
    await repository.latestTelemetryForJobs(['j']);
    expect(select).toHaveBeenCalledTimes(6);
  });
});
