// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '../../../tools/agents/jobRegistry';
import type { AgentStateService } from '../../../app/Services/AgentStateService';
import { AgentStateProjector } from '../../../app/Services/AgentStateProjector';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const activeJob: AgentJob = {
  jobId: 'job', status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, results: [],
  tasks: [{ agentId: 'worker', label: 'Worker', prompt: 'work', status: 'running' }],
};

describe('AgentStateProjector concurrent reads', () => {
  it('shares one pending history read across windows and starts a fresh read after success', async() => {
    const pending = deferred<AgentJob[]>();
    const jobs = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    const states = { jobsForProjection: jobs, version: 1 } as unknown as AgentStateService;
    const projector = new AgentStateProjector(states, { latest: async() => null });

    const first = projector.snapshot();
    const others = Array.from({ length: 20 }, () => projector.snapshot());
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(others.every(snapshot => snapshot === first)).toBe(true);
    pending.resolve([]);
    await Promise.all([first, ...others]);

    await projector.snapshot();
    expect(jobs).toHaveBeenCalledTimes(2);
  });

  it('releases a failed snapshot so the next poll can recover', async() => {
    const pending = deferred<AgentJob[]>();
    const jobs = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    const states = { jobsForProjection: jobs, version: 1 } as unknown as AgentStateService;
    const projector = new AgentStateProjector(states, { latest: async() => null });
    const first = projector.snapshot();
    const second = projector.snapshot();
    const failures = Promise.allSettled([first, second]);
    pending.reject(new Error('temporary database failure'));
    expect((await failures).every(result => result.status === 'rejected')).toBe(true);

    await expect(projector.snapshot()).resolves.toMatchObject({ version: 1, rows: [] });
    expect(jobs).toHaveBeenCalledTimes(2);
  });

  it('keeps an older snapshot version while telemetry waits so a trailing update remains usable', async() => {
    const pendingTelemetry = deferred<null>();
    const latest = vi.fn().mockReturnValueOnce(pendingTelemetry.promise).mockResolvedValue(null);
    const states = { jobsForProjection: vi.fn().mockResolvedValue([activeJob]), version: 1, isLive: () => true };
    const projector = new AgentStateProjector(states as unknown as AgentStateService, { latest });
    const first = projector.snapshot();
    await vi.waitFor(() => expect(latest).toHaveBeenCalledTimes(1));
    states.version = 2;
    expect(projector.snapshot()).toBe(first);
    pendingTelemetry.resolve(null);
    expect((await first).version).toBe(1);

    expect((await projector.snapshot()).version).toBe(2);
  });
});
