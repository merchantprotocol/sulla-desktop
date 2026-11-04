// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { AgentHeartbeatPolicy, type AgentDefinitionLookup } from '../../../services/AgentHeartbeatPolicy';
import { JobHeartbeatDelivery, type JobThreadOwner } from '../../../services/JobHeartbeatDelivery';
import { ThreadNotParkedError } from '../../../services/ThreadNotParkedError';

import type { AgentDefinition } from '../../../database/models/AgentDefinitionModel';
import type { AgentJob } from '../../../tools/agents/jobRegistry';

const heartbeat = (allowed: boolean) => ({ allowed, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 10 });
const definition = (slug: string, config: Record<string, unknown>): AgentDefinition => ({ id: `${ slug }-id`, slug, config } as AgentDefinition);

class InMemoryAgentDefinitionRepository implements AgentDefinitionLookup {
  constructor(private readonly rows: Map<string, AgentDefinition>) {}
  set(slug: string, row: AgentDefinition): void { this.rows.set(slug, row); }
  async get(id: string): Promise<AgentDefinition | null> { return [...this.rows.values()].find(row => row.id === id) ?? null; }
  async findBySlug(slug: string): Promise<AgentDefinition | null> { return this.rows.get(slug) ?? null; }
}

function makeOwner(
  agentId: string,
  jobStatus: AgentJob['status'],
  taskStatus: AgentJob['tasks'][number]['status'],
  visibility: AgentJob['tasks'][number]['visibility'] = 'hidden',
): JobThreadOwner {
  const job: AgentJob = {
    jobId: 'job-1', status: jobStatus, createdAt: Date.now(), finishedAt: null, taskCount: 1, results: [], visibility: 'hidden',
    tasks: [{ agentId, label: 'l', prompt: 'p', status: taskStatus, threadId: 'thread-1', visibility }],
  };
  return { job, taskIndex: 0 };
}

describe('JobHeartbeatDelivery — a hidden job thread wakes its own agent', () => {
  let unregisterCalls: string[];
  let logs: string[];
  let repository: InMemoryAgentDefinitionRepository;
  let wakeParkedAgent: ReturnType<typeof vi.fn>;
  let findTaskByThread: ReturnType<typeof vi.fn>;
  let delivery: JobHeartbeatDelivery;

  function build(owner: JobThreadOwner | undefined): void {
    unregisterCalls = [];
    logs = [];
    repository = new InMemoryAgentDefinitionRepository(new Map());
    wakeParkedAgent = vi.fn();
    findTaskByThread = vi.fn(async() => owner);
    delivery = new JobHeartbeatDelivery(
      { findTaskByThread },
      new AgentHeartbeatPolicy(repository),
      wakeParkedAgent,
      (threadId) => unregisterCalls.push(threadId),
      (message) => logs.push(message),
    );
  }

  it('is not applicable for a thread that owns no job task — the caller falls back to tab delivery', async() => {
    // risk: a plain top-level chat's heartbeat gets routed through job machinery and silently never fires
    build(undefined);

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: false, delivered: false });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
  });

  it('is not applicable for a job explicitly opened as a visible tab — regression: unchanged tab behavior', async() => {
    // risk: a visible-tab job's heartbeat starts routing through the hidden-job wake path and breaks
    build(makeOwner('lead', 'running', 'running', 'tab'));

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: false, delivered: false });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
  });

  it('delivers through wakeParkedAgent for a live-waiter-parked or dormant-parked job', async() => {
    // risk: a hidden manager parked waiting on its children never receives its own heartbeat
    build(makeOwner('lead', 'parked', 'parked'));
    repository.set('lead', definition('lead', { heartbeat: heartbeat(true) }));
    wakeParkedAgent.mockResolvedValue(true);

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: true, delivered: true });
    expect(wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'thread-1', 'beat', 'lead', { intervalMinutes: 5 });
    expect(unregisterCalls).toEqual([]);
  });

  it('waits rather than interrupts when a turn is already in flight for this thread', async() => {
    // risk: a heartbeat aborts or duplicates a live run instead of waiting for it
    build(makeOwner('lead', 'parked', 'parked'));
    repository.set('lead', definition('lead', { heartbeat: heartbeat(true) }));
    wakeParkedAgent.mockResolvedValue(false);

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: true, delivered: false });
    expect(unregisterCalls).toEqual([]);
  });

  it('treats a genuinely busy (not parked at all) job as waiting, not an error', async() => {
    // risk: an uncaught "not a parked agent job" throw crashes the scheduler's beat instead of politely waiting
    build(makeOwner('lead', 'running', 'running'));
    repository.set('lead', definition('lead', { heartbeat: heartbeat(true) }));
    wakeParkedAgent.mockRejectedValue(new ThreadNotParkedError('thread-1'));

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: true, delivered: false });
    expect(unregisterCalls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('logs an unexpected error instead of swallowing it, while still waiting rather than throwing', async() => {
    // risk: a real bug in wakeParkedAgent (DB failure, dispatch crash) silently vanishes forever, indistinguishable from a busy agent
    build(makeOwner('lead', 'parked', 'parked'));
    repository.set('lead', definition('lead', { heartbeat: heartbeat(true) }));
    wakeParkedAgent.mockRejectedValue(new Error('dispatchToAgent blew up'));

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: true, delivered: false });
    expect(unregisterCalls).toEqual([]);
    expect(logs).toEqual([expect.stringContaining('dispatchToAgent blew up')]);
  });

  it('drops and unregisters a heartbeat for a job that already reached a terminal status', async() => {
    // risk: a completed/stopped/failed job's heartbeat keeps firing forever
    build(makeOwner('lead', 'completed', 'completed'));
    repository.set('lead', definition('lead', { heartbeat: heartbeat(true) }));

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: true, delivered: false });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
    expect(unregisterCalls).toEqual(['thread-1']);
  });

  it('drops and unregisters a heartbeat once policy no longer allows it, naming the agent', async() => {
    // risk: a live heartbeat outlives a mid-flight config change that revoked or tightened it
    build(makeOwner('lead', 'parked', 'parked'));
    repository.set('lead', definition('lead', { heartbeat: heartbeat(false) }));

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: true, delivered: false });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
    expect(unregisterCalls).toEqual(['thread-1']);
    expect(logs[0]).toContain('lead');
  });

  it('drops and unregisters once the configured interval no longer covers this beat', async() => {
    // risk: a shrunk max interval keeps delivering a now-out-of-range beat instead of refusing it
    build(makeOwner('lead', 'parked', 'parked'));
    repository.set('lead', definition('lead', { heartbeat: { allowed: true, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 3 } }));

    const outcome = await delivery.tryDeliver('sulla-desktop', 'thread-1', 'beat', 5);

    expect(outcome).toEqual({ applicable: true, delivered: false });
    expect(wakeParkedAgent).not.toHaveBeenCalled();
    expect(unregisterCalls).toEqual(['thread-1']);
  });
});
