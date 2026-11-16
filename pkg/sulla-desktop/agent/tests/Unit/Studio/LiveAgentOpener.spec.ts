// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { LiveAgentOpener } from '@pkg/components/studio/live/LiveAgentOpener';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

function row(overrides: Partial<AgentStateRow> = {}): AgentStateRow {
  return {
    key: 'job-1:0', jobId: 'job-1', taskIndex: 0, parentJobId: null, parentTaskIndex: null, rootThreadId: 'root-1', threadId: 'thread-1', depth: 0,
    agentId: 'worker', label: 'Worker', visibility: 'hidden', state: 'working', stateReason: null, killedByHuman: false, waitingOnChildren: 0,
    startedAt: null, endedAt: null, lastActivityAt: new Date(0).toISOString(), lastCheckinAt: null, lastCheckinSummary: null,
    canMessage: true, canStop: true, canOpen: true, ...overrides,
  };
}

describe('LiveAgentOpener', () => {
  // risk: a click on Open silently does nothing
  it('promotes a live top-level run under its root chat', async() => {
    const invoke = vi.fn().mockResolvedValue(true);
    const history = vi.fn();
    const result = await new LiveAgentOpener(invoke, history).open(row(), []);

    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('agents:open-job-in-tab', 'job-1', 'root-1', 0);
    expect(history).not.toHaveBeenCalled();
  });

  it('promotes a live nested run under its parent task thread, not the root chat', async() => {
    const invoke = vi.fn().mockResolvedValue(true);
    const parent = row({ key: 'lead:2', jobId: 'lead', taskIndex: 2, threadId: 'lead-thread' });
    const child = row({ parentJobId: 'lead', parentTaskIndex: 2 });

    await new LiveAgentOpener(invoke, vi.fn()).open(child, [parent, child]);
    expect(invoke).toHaveBeenCalledWith('agents:open-job-in-tab', 'job-1', 'lead-thread', 0);
  });

  it('reopens a finished run from history because promotion refuses finished tasks', async() => {
    const invoke = vi.fn();
    const history = vi.fn().mockResolvedValue(undefined);
    const result = await new LiveAgentOpener(invoke, history).open(row({ state: 'done', canStop: false, canMessage: false }), []);

    expect(result.ok).toBe(true);
    expect(history).toHaveBeenCalledWith('thread-1', 'Worker');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports a refused promotion instead of failing silently', async() => {
    const result = await new LiveAgentOpener(vi.fn().mockResolvedValue(false), vi.fn()).open(row(), []);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('reports an IPC failure as a visible error', async() => {
    const result = await new LiveAgentOpener(vi.fn().mockRejectedValue(new Error('main process gone')), vi.fn()).open(row(), []);

    expect(result).toEqual({ ok: false, error: expect.stringContaining('main process gone') });
  });

  it('refuses a nested run whose parent is not loaded rather than promoting under the wrong chat', async() => {
    const invoke = vi.fn();
    const result = await new LiveAgentOpener(invoke, vi.fn()).open(row({ parentJobId: 'gone', parentTaskIndex: 0 }), []);

    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
