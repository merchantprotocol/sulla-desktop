// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { prepareWorkerTurnPrompt, WorkerPromptBuilder } from '../../tools/agents/workerMessaging';

describe('WorkerPromptBuilder', () => {
  it('injects the delegated job identity and Sulla-only waiting rules', () => {
    // risk: a worker waits with unsupported native controls and never reports its contract
    const prompt = new WorkerPromptBuilder().build({
      delegatedJobId: 'job-42', delegatedTaskIndex: 3, managerAgentId: 'coding-manager', managerThreadId: 'thread-7',
    });
    expect(prompt).toContain('Job: job-42 (task 3)');
    expect(prompt).toContain('Manager: coding-manager');
    expect(prompt).toContain('agents/return_result');
    expect(prompt).toContain('sulla agents/wait');
    expect(prompt).toContain('[Message from orchestrator]');
    expect(prompt).toContain('report_progress blockers');
    expect(prompt).toContain("sulla agents/report_progress - <<'JSON'");
    expect(prompt).not.toContain('Promise');
  });

  it('includes tracked review-item obligations in the delegated worker prompt', async() => {
    // risk: a worker could return without acknowledging or closing manager review findings
    const prompt = await prepareWorkerTurnPrompt({ metadata: { isSubAgent: true } }, 'base prompt');
    expect(prompt).toContain('Tracked review items arrive with ids');
    expect(prompt).toContain('return_result is refused');
  });
});
