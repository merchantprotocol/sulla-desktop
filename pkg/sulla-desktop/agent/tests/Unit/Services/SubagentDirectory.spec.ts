// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { isOpenAgentJobTask } from '../../../services/SubagentDirectory';

import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

describe('SubagentDirectory', () => {
  it('treats a lost task as terminal instead of an open child', () => {
    // risk: restart reconciliation marks a child lost, but its parent remains
    // parked forever because the task is still counted as open.
    const task: AgentJobTask = { agentId: 'codex-sol-worker', label: 'lost worker', prompt: 'work', status: 'lost' };
    const job: AgentJob = {
      jobId: 'lost-job', status: 'running', createdAt: 1, finishedAt: null,
      taskCount: 1, results: [], tasks: [task],
    };

    expect(isOpenAgentJobTask(job, task)).toBe(false);
  });
});
