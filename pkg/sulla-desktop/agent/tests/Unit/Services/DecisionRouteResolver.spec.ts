// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DecisionRouteResolver } from '../../../services/DecisionRouteResolver';
import type { AgentJobTaskTarget } from '../../../database/models/AgentJobMessagingModel';

class TaskMap {
  constructor(private readonly tasks: Map<string, AgentJobTaskTarget>) {}
  taskForThread(threadId: string): Promise<AgentJobTaskTarget | null> { return Promise.resolve(this.tasks.get(threadId) ?? null) }
}

describe('DecisionRouteResolver', () => {
  it('snapshots the parent agent chain in order and ends at the human chat', async() => {
    // risk: authorization — route holder order must follow child -> parent -> root, not an unordered ancestry set.
    const resolver = new DecisionRouteResolver(new TaskMap(new Map([
      ['child-thread', { jobId: 'child-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', parentThreadId: 'manager-thread', parentChannel: 'manager-channel' }],
      ['manager-thread', { jobId: 'manager-job', taskIndex: 1, jobStatus: 'parked', taskStatus: 'parked', agentId: 'coding-manager', parentThreadId: 'root-chat', parentChannel: 'root-channel', parentJobId: null }],
    ])));

    await expect(resolver.resolve('child-thread', 'child-channel')).resolves.toEqual([
      { threadId: 'manager-thread', channel: 'manager-channel', agentId: 'coding-manager', jobId: 'manager-job', taskIndex: 1, kind: 'agent' },
      { threadId: 'root-chat', channel: 'root-channel', agentId: 'root-channel', kind: 'agent' },
      { threadId: 'root-chat', channel: 'root-channel', agentId: 'human', kind: 'human' },
    ]);
    await expect(resolver.resolve('root-chat', 'root-channel')).resolves.toEqual([
      { threadId: 'root-chat', channel: 'root-channel', agentId: 'human', kind: 'human' },
    ]);
  });

  it('rechecks a snapshotted parent at advance time and marks a finished job unavailable', async() => {
    // risk: availability — a completed or pruned parent must not receive a later escalation.
    const resolver = new DecisionRouteResolver(new TaskMap(new Map([
      ['child-thread', { jobId: 'child-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', parentThreadId: 'finished-parent', parentChannel: 'parent-channel' }],
      ['finished-parent', { jobId: 'parent-job', taskIndex: 2, jobStatus: 'completed', taskStatus: 'completed', parentThreadId: 'root-chat' }],
    ])));
    const chain = await resolver.resolve('child-thread', 'child-channel');

    expect(chain[0]).toMatchObject({ threadId: 'finished-parent', kind: 'agent' });
    await expect(resolver.liveness(chain[0])).resolves.toBe('unavailable');
    await expect(resolver.liveness(chain[1])).resolves.toBe('available');
  });

  it('skips a parent blocked in a synchronous spawn', async() => {
    // risk: liveness — a synchronous child spawn blocks its parent from receiving or answering a new decision.
    const resolver = new DecisionRouteResolver(new TaskMap(new Map([
      ['child-thread', { jobId: 'child-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', spawnMode: 'sync', parentThreadId: 'parent-thread', parentChannel: 'parent-channel' }],
      ['parent-thread', { jobId: 'parent-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', parentThreadId: 'root-chat', parentChannel: 'root-channel', parentJobId: null }],
    ])));
    const chain = await resolver.resolve('child-thread', 'child-channel');

    await expect(resolver.liveness(chain[0], 'child-thread')).resolves.toBe('unavailable');
    await expect(resolver.liveness(chain[1], 'child-thread')).resolves.toBe('available');
  });

  it('does not mistake a pruned parent job for an agent in the root chat', async() => {
    // risk: authorization — a missing parent job must advance to the human, not manufacture an agent holder.
    const resolver = new DecisionRouteResolver(new TaskMap(new Map([
      ['child-thread', { jobId: 'child-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', parentThreadId: 'pruned-thread', parentChannel: 'parent-channel', parentJobId: 'pruned-job' }],
    ])));

    await expect(resolver.resolve('child-thread', 'child-channel')).resolves.toEqual([
      { threadId: 'pruned-thread', channel: 'parent-channel', agentId: 'human', kind: 'human' },
    ]);
  });

  it('does not infer a root-chat agent when parentJobId is missing', async() => {
    // risk: authorization — incomplete legacy task data must not manufacture an agent holder.
    const resolver = new DecisionRouteResolver(new TaskMap(new Map([
      ['child-thread', { jobId: 'child-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', parentThreadId: 'root-chat', parentChannel: 'root-channel' }],
    ])));

    await expect(resolver.resolve('child-thread', 'child-channel')).resolves.toEqual([
      { threadId: 'root-chat', channel: 'root-channel', agentId: 'human', kind: 'human' },
    ]);
  });

  it('stops a corrupt ancestry cycle at the last distinct ancestor and retains a human fallback', async() => {
    // risk: routing — a corrupt parent loop must not return the decision to the asker or loop indefinitely.
    const resolver = new DecisionRouteResolver(new TaskMap(new Map([
      ['a', { jobId: 'job-a', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', parentThreadId: 'b', parentChannel: 'channel-b' }],
      ['b', { jobId: 'job-b', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', parentThreadId: 'a', parentChannel: 'channel-a' }],
    ])));

    await expect(resolver.resolve('a', 'channel-a')).resolves.toEqual([
      { threadId: 'b', channel: 'channel-b', agentId: 'human', kind: 'human' },
    ]);
  });
});
