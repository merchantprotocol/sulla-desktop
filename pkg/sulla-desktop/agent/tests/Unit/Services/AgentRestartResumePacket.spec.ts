// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { agentRestartResumePacket } from '../../../services/AgentRestartResumePacket';

import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({
  agentId:     'builder',
  label:       'Implement durable restart',
  prompt:      'work',
  status:      'running',
  provider:    'openai-codex',
  model:       'gpt-6.2-sol',
  effort:      'medium',
  runLocation: 'container',
  threadId:    'thread-1',
  ...overrides,
});
const job = (worker: AgentJobTask): AgentJob => ({
  jobId: 'job-1', status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, results: [], tasks: [worker], visibility: 'hidden',
});

describe('agent restart resume packet', () => {
  it('restores the saved progress and original execution settings without inventing a new workspace', () => {
    const worker = task();
    const packet = agentRestartResumePacket(job(worker), worker, 0, {
      step:         'tests',
      summary:      'Implementation is committed locally; restart proof remains.',
      filesTouched: ['src/a.ts', 'src/b.ts'],
      blockers:     ['Need the restarted runtime'],
      percent:      80,
      createdAt:    1_700_000_000_000,
    });
    expect(packet).toContain('job job-1, task 0');
    expect(packet).toContain('openai-codex · gpt-6.2-sol · medium');
    expect(packet).toContain('Run location: container');
    expect(packet).toContain('durable workspace and thread state');
    expect(packet).toContain('Summary: Implementation is committed locally; restart proof remains.');
    expect(packet).toContain('Files touched: src/a.ts, src/b.ts');
    expect(packet).toContain('Open blockers: Need the restarted runtime');
    expect(packet).toContain('Reported completion: 80%');
    expect(packet).not.toContain('clone a replacement or restart completed work.\nNo progress');
  });

  it('bounds persisted text and tells a legacy task to inspect before changing files', () => {
    const worker = task({
      provider:       undefined,
      model:          undefined,
      effort:         undefined,
      runLocation:    undefined,
    });
    const packet = agentRestartResumePacket(job(worker), worker, 0, null);
    expect(packet).not.toContain('Original execution:');
    expect(packet).toContain('No progress check-in was saved');
    expect(packet).toContain('call return_result exactly once');
    expect(packet.length).toBeLessThan(2_000);
  });
});
