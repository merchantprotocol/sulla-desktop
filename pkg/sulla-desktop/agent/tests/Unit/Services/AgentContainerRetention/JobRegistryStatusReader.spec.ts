// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { JobRegistryStatusReader, type AgentJobLookup } from '@pkg/agent/services/JobRegistryStatusReader';

class FakeJobLookup implements AgentJobLookup {
  constructor(private readonly jobs: Record<string, string>, private readonly failing = false) {}
  async getJob(jobId: string) {
    if (this.failing) throw new Error('registry unavailable');
    return this.jobs[jobId] ? { status: this.jobs[jobId] } : undefined;
  }
}

describe('JobRegistryStatusReader', () => {
  it('returns the owning job status from the registry', async() => {
    // risk: the reaper never sees a terminal owner, so finished jobs keep their containers until the 4 h TTL
    const reader = new JobRegistryStatusReader(new FakeJobLookup({ 'job-done': 'completed', 'job-parked': 'parked' }));
    expect(await reader.status('job-done')).toBe('completed');
    expect(await reader.status('job-parked')).toBe('parked');
    expect(await reader.status('missing')).toBeUndefined();
  });

  it('reports unknown instead of throwing when the registry cannot be read', async() => {
    // risk: an unreadable registry is mistaken for a terminal job and a live job's container is reaped
    expect(await new JobRegistryStatusReader(new FakeJobLookup({}, true)).status('job-1')).toBeUndefined();
  });
});
