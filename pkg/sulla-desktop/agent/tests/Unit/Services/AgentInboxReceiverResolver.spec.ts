// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AmbiguousAgentInboxTargetError, DurableAgentInboxReceiverResolver, NoAgentInboxTargetError } from '../../../services/AgentInboxReceiverResolver';

describe('DurableAgentInboxReceiverResolver', () => {
  const jobs = { allJobs: async () => [
    { jobId: 'job-a', createdAt: 2, parentAgentId: 'coding-manager', status: 'parked', parentThreadId: 'manager-a', tasks: [] },
    { jobId: 'job-b', createdAt: 1, parentAgentId: 'coding-manager', status: 'parked', parentThreadId: 'manager-b', tasks: [] },
  ] } as any;

  it('refuses to guess among multiple same-channel manager instances and lists addresses', async () => { // risk: peer delivery to wrong manager
    const resolver = new DurableAgentInboxReceiverResolver(jobs, () => []);
    await expect(resolver.resolve('coding-manager')).rejects.toMatchObject({
      name: 'AmbiguousAgentInboxTargetError',
      candidates: expect.arrayContaining([expect.objectContaining({ threadId: 'manager-a', jobId: 'job-a' }), expect.objectContaining({ threadId: 'manager-b', jobId: 'job-b' })]),
    });
    try { await resolver.resolve('coding-manager'); } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousAgentInboxTargetError);
      expect((error as Error).message).toContain('coding-manager#manager-a');
      expect((error as Error).message).toContain('job job-b');
    }
  });

  it('honors an explicit parent thread even when the channel has multiple live sessions', async () => { // risk: cross-session message isolation
    const resolver = new DurableAgentInboxReceiverResolver({ allJobs: async () => [] }, () => [
      { channel: 'sulla-desktop', threadId: 'session-a', label: 'chat' },
      { channel: 'sulla-desktop', threadId: 'session-b', label: 'chat' },
    ]);
    await expect(resolver.resolve('sulla-desktop', 'session-a')).resolves.toEqual({ channel: 'sulla-desktop', threadId: 'session-a', agentId: 'sulla-desktop', label: 'chat' });
  });

  it('routes exact job and thread selectors to their matching thread', async () => { // risk: delivery to the wrong manager instance
    const resolver = new DurableAgentInboxReceiverResolver(jobs, () => []);
    await expect(resolver.resolve('coding-manager', 'job-b')).resolves.toMatchObject({ threadId: 'manager-b', jobId: 'job-b' });
    await expect(resolver.resolve('coding-manager', 'manager-a')).resolves.toMatchObject({ threadId: 'manager-a' });
  });

  it('keeps legacy latest-thread routing for multiple idle cached chats', async () => { // risk: peer delivery availability
    const resolver = new DurableAgentInboxReceiverResolver({ allJobs: async () => [] }, () => [
      { channel: 'sulla-desktop', threadId: 'old', label: 'chat' },
      { channel: 'sulla-desktop', threadId: 'latest', label: 'chat' },
      { channel: 'sulla-desktop', threadId: 'newest', label: 'chat' },
    ]);
    await expect(resolver.resolve('sulla-desktop')).resolves.toMatchObject({ threadId: 'newest' });
  });

  it('uses an executing graph in preference to idle cached chats', async () => { // risk: peer delivery availability
    const resolver = new DurableAgentInboxReceiverResolver({ allJobs: async () => [] }, () => [
      { channel: 'sulla-desktop', threadId: 'idle', label: 'chat' },
      { channel: 'sulla-desktop', threadId: 'live', label: 'chat', executing: true },
    ]);
    await expect(resolver.resolve('sulla-desktop')).resolves.toMatchObject({ threadId: 'live' });
  });

  it('returns a typed no-match error for an invalid explicit address', async () => { // risk: peer delivery recovery
    const resolver = new DurableAgentInboxReceiverResolver({ allJobs: async () => [] }, () => []);
    await expect(resolver.resolve('coding-manager', 'missing')).rejects.toBeInstanceOf(NoAgentInboxTargetError);
  });

  it('routes a reply to the waking instance even when the channel is ambiguous', async () => { // risk: peer reply misdelivery
    const resolver = new DurableAgentInboxReceiverResolver(jobs, () => []);
    await expect(resolver.resolve('coding-manager', undefined, 'manager-b')).resolves.toMatchObject({ threadId: 'manager-b' });
  });

  it('ignores a reply thread from another channel and uses normal routing', async () => { // risk: dropped peer replies
    const resolver = new DurableAgentInboxReceiverResolver({ allJobs: async () => [] }, () => [{ channel: 'sulla-desktop', threadId: 'chat', label: 'chat' }]);
    await expect(resolver.resolve('sulla-desktop', undefined, 'heartbeat-thread')).resolves.toMatchObject({ threadId: 'chat' });
  });
});
