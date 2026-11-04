// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { JobHeartbeatCleanup } from '../../../services/JobHeartbeatCleanup';

import type { AgentJob } from '../../../tools/agents/jobRegistry';

function job(tasks: AgentJob['tasks']): AgentJob {
  return { jobId: 'job-1', status: 'completed', createdAt: Date.now(), finishedAt: Date.now(), taskCount: tasks.length, results: [], visibility: 'hidden', tasks };
}

describe('JobHeartbeatCleanup — unregisters a heartbeat for every task thread a terminal job touched', () => {
  it('unregisters every task thread on a multi-task job, in order', () => {
    // risk: a manager-with-children job leaves siblings' heartbeats firing after only one thread is cleaned up
    const unregistered: string[] = [];
    const cleanup = new JobHeartbeatCleanup({ unregister: (threadId) => unregistered.push(threadId) });

    cleanup.onJobTerminal(job([
      { agentId: 'a', label: 'a', prompt: 'x', status: 'completed', threadId: 'thread-a' },
      { agentId: 'b', label: 'b', prompt: 'x', status: 'completed', threadId: 'thread-b' },
    ]));

    expect(unregistered).toEqual(['thread-a', 'thread-b']);
  });

  it('skips a task with no threadId instead of unregistering a bogus thread', () => {
    // risk: a task that never got a thread (e.g. failed before dispatch) passes undefined through to the scheduler and corrupts its registry
    const unregistered: string[] = [];
    const cleanup = new JobHeartbeatCleanup({ unregister: (threadId) => unregistered.push(threadId) });

    cleanup.onJobTerminal(job([
      { agentId: 'a', label: 'a', prompt: 'x', status: 'error' },
      { agentId: 'b', label: 'b', prompt: 'x', status: 'completed', threadId: 'thread-b' },
    ]));

    expect(unregistered).toEqual(['thread-b']);
  });

  it('unregisters nothing for a job with no tasks, without erroring', () => {
    // risk: an empty-task job (e.g. a 0-task job created for bookkeeping) throws instead of being a no-op
    const unregistered: string[] = [];
    const cleanup = new JobHeartbeatCleanup({ unregister: (threadId) => unregistered.push(threadId) });

    expect(() => cleanup.onJobTerminal(job([]))).not.toThrow();
    expect(unregistered).toEqual([]);
  });
});
