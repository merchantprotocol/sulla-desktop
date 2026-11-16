// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { CheckAgentJobsWorker } from '../../../../tools/agents/check_agent_jobs';
import type { AgentFleetProjectionService } from '../../../../app/Services/AgentFleetProjectionService';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

class CheckAgentJobsHarness extends CheckAgentJobsWorker {
  call(input: unknown) { return this._validatedCall(input); }
}

class FakeFleet {
  constructor(private readonly jobs: Record<string, Record<string, unknown>>) {}
  async job(jobId: string) { return this.jobs[jobId]; }
  async list() { return []; }
}

const view = (jobId: string, status: string, results: Array<{ status: string }>) => ({
  jobId, status, createdAt: '2026-11-16T15:06:31.558Z', finishedAt: '2026-11-16T15:06:34.045Z',
  error: status === 'failed' ? 'Error: provider transport failed' : undefined,
  results: results.map(result => ({ label: 'worker', output: 'out', threadId: 't', ...result })),
  tasks: [{ taskIndex: 0, agentId: 'opus-worker', status }],
});

function harness() {
  const fleet = new FakeFleet({
    failed:    view('failed', 'failed', [{ status: 'error' }]),
    stopped:   view('stopped', 'stopped', [{ status: 'stopped' }]),
    blocked:   view('blocked', 'completed', [{ status: 'blocked' }]),
    completed: view('completed', 'completed', [{ status: 'completed' }]),
  });
  return new CheckAgentJobsHarness(fleet as unknown as AgentFleetProjectionService);
}

describe('check_agent_jobs by-id lookup', () => {
  it.each(['failed', 'stopped', 'blocked', 'completed'])('reads a %s job as a successful lookup with the job record as payload', async(jobId) => {
    // risk: a failed job read reported as a tool failure makes managers relaunch or misreport finished work
    const response = await harness().call({ jobId });
    expect(response.successBoolean).toBe(true);
    const payload = JSON.parse(response.responseString);
    expect(payload.jobId).toBe(jobId);
    expect(payload.tasks[0].agentId).toBe('opus-worker');
  });

  it('keeps the failed job status and error in the payload so callers can still see the failure', async() => {
    // risk: making the read succeed must not hide that the job itself failed
    const payload = JSON.parse((await harness().call({ jobId: 'failed' })).responseString);
    expect(payload).toMatchObject({ status: 'failed', error: 'Error: provider transport failed' });
    expect(payload.results[0].status).toBe('error');
  });

  it('still fails the lookup when the job id does not exist', async() => {
    // risk: an unknown job id silently looks like a real job
    const response = await harness().call({ jobId: 'agent-job-missing' });
    expect(response.successBoolean).toBe(false);
    expect(response.responseString).toContain('agent-job-missing');
  });
});
