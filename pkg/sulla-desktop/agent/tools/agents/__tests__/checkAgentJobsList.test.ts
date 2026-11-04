/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { boundJobList, type AgentJob } from '../jobRegistry';

function job(jobId: string, status: AgentJob['status'], createdAt: number): AgentJob {
  return { jobId, status, createdAt, finishedAt: status === 'running' ? null : createdAt + 1, taskCount: 0, tasks: [], results: [] };
}

describe('check_agent_jobs list window', () => {
  it('always includes active jobs and bounds finished jobs to the newest requested count', () => {
    const jobs = [
      job('old-active', 'running', 1),
      ...Array.from({ length: 40 }, (_, index) => job(`finished-${ index }`, 'completed', 100 + index)),
      job('new-active', 'running', 1_000),
    ];

    const listed = boundJobList(jobs, 25, true);
    expect(listed.filter(item => item.status === 'running').map(item => item.jobId)).toEqual(['new-active', 'old-active']);
    expect(listed.filter(item => item.status !== 'running')).toHaveLength(25);
    expect(listed.some(item => item.jobId === 'finished-39')).toBe(true);
    expect(listed.some(item => item.jobId === 'finished-0')).toBe(false);
    expect(boundJobList(jobs, 25, false).every(item => item.status === 'running')).toBe(true);
  });
});
