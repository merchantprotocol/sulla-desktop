// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => ({ savedState: undefined as any }));

vi.mock('electron', () => ({}));
vi.mock('@pkg/agent/nodes/Graph', () => ({
  createAgentGraph: () => ({}),
  createHeartbeatGraph: () => ({}),
  createSubconsciousGraph: () => ({}),
}));
vi.mock('@pkg/agent/nodes/ThreadStateStore', () => ({
  loadThreadState: async() => sources.savedState,
  saveThreadState: async() => undefined,
}));
vi.mock('@pkg/utils/logging', () => ({
  default: { background: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() } },
}));

import { GraphRegistry } from '@pkg/agent/services/GraphRegistry';

describe('GraphRegistry thread job ownership', () => {
  afterEach(() => {
    sources.savedState = undefined;
    GraphRegistry.clearAll();
  });

  it('does not label a parent from stale delegatedJobId or a task that owns a different thread', async() => {
    // risk: stale child metadata turns a parent chat into a child-job identity in live thread discovery.
    sources.savedState = {
      messages: [],
      metadata: {
        threadId: 'parent-thread', wsChannel: 'account-manager', agentId: 'account-manager',
        delegatedJobId: 'child-job', jobId: 'child-job',
        modelDecisionTask: { jobId: 'child-job', taskIndex: 0, threadId: 'child-thread' },
      },
    };

    await GraphRegistry.getOrCreateAgentGraph('account-manager', 'parent-thread');

    expect(GraphRegistry.findThreadsByChannel('account-manager')).toEqual([{
      channel: 'account-manager', threadId: 'parent-thread', label: 'account-manager', jobId: undefined,
    }]);
  });

  it('keeps the task identity when its modelDecisionTask names this exact thread', async() => {
    sources.savedState = {
      messages: [],
      metadata: {
        threadId: 'worker-thread', wsChannel: 'worker', agentId: 'worker', delegatedJobId: 'own-job',
        modelDecisionTask: { jobId: 'own-job', taskIndex: 1, threadId: 'worker-thread' },
      },
    };

    await GraphRegistry.getOrCreateAgentGraph('worker', 'worker-thread');

    expect(GraphRegistry.findThreadsByChannel('worker')[0]).toMatchObject({ threadId: 'worker-thread', jobId: 'own-job' });
  });
});
