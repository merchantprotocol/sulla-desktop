// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { PersistentContainerAuditor, type JobCheckinWriter } from '@pkg/agent/tools/docker/PersistentContainerAuditor';

/** In-memory job check-in record bound to known delegated threads. */
class FakeJobCheckins implements JobCheckinWriter {
  readonly entries: Array<{ threadId: string; step: string; summary: string }> = [];
  constructor(private readonly boundThreads: Set<string>) {}
  async appendCheckin(threadId: string, input: { step: string; summary: string }): Promise<unknown> {
    if (!this.boundThreads.has(threadId)) return null;
    this.entries.push({ threadId, ...input });
    return { recorded: true };
  }
}

describe('PersistentContainerAuditor', () => {
  it('writes the persistence reason and labels into the owning job record', async() => {
    // risk: a persistent opt-out leaves no trace on the job, so nobody can tell why a container survives reboots
    const checkins = new FakeJobCheckins(new Set(['thread-1']));
    const recorded = await new PersistentContainerAuditor(checkins).record('thread-1', 'exec', 'local database', { 'com.sulla.job-id': 'job-1' });
    expect(recorded).toBe(true);
    expect(checkins.entries).toHaveLength(1);
    expect(checkins.entries[0]).toMatchObject({ threadId: 'thread-1', step: PersistentContainerAuditor.STEP });
    expect(checkins.entries[0].summary).toContain('Reason: local database');
    expect(checkins.entries[0].summary).toContain('com.sulla.job-id');
  });

  it('reports false instead of throwing when no job is bound or the write fails', async() => {
    const failing: JobCheckinWriter = { appendCheckin: async() => { throw new Error('db down') } };
    expect(await new PersistentContainerAuditor(new FakeJobCheckins(new Set())).record('unbound', 'docker_run', 'r', {})).toBe(false);
    expect(await new PersistentContainerAuditor(failing).record('thread-1', 'docker_run', 'r', {})).toBe(false);
    expect(await new PersistentContainerAuditor(failing).record(undefined, 'docker_run', 'r', {})).toBe(false);
  });
});
