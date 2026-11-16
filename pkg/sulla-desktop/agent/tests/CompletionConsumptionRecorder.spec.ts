// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { CompletionConsumptionRecorder } from '../services/CompletionConsumptionRecorder';

describe('CompletionConsumptionRecorder', () => {
  it('releases injected notices when the first response aborts, but retains them after confirmation', async() => {
    // risk: data loss — an abort before the first model response must restore every injected completion.
    const recorder = new CompletionConsumptionRecorder();
    const entry = { jobId: 'job', taskIndex: 0, results: [] };
    const release = vi.fn();
    recorder.recordInjected([entry]);
    await recorder.releaseOnAbort(release);
    expect(release).toHaveBeenCalledWith(entry);

    recorder.recordInjected([entry]);
    recorder.confirmSeen();
    await recorder.releaseOnAbort(release);
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps a completion the model already answered acknowledged when a later step of the turn fails', async() => {
    // risk: duplicate delivery — a turn that consumed a child result and then errored released it, so the parent got the same result again.
    const recorder = new CompletionConsumptionRecorder();
    const answered = { jobId: 'child-a', taskIndex: 0, results: [] };
    const unseen = { jobId: 'child-b', taskIndex: 0, results: [] };
    recorder.recordInjected([answered, unseen]);
    recorder.confirmAnswered([
      { role: 'user', content: 'result A', metadata: { source: 'sub_agent_completion', completionEntries: [answered] } },
      { role: 'assistant', content: 'read A, working' },
      { role: 'user', content: 'result B', metadata: { source: 'sub_agent_completion', completionEntries: [unseen] } },
    ]);
    const release = vi.fn();
    await recorder.releaseOnAbort(release);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(unseen);
  });

  it('releases every completion when the turn failed before any model reply', async() => {
    // risk: data loss — an unanswered completion must still go back to the inbox.
    const recorder = new CompletionConsumptionRecorder();
    const entry = { jobId: 'child-c', taskIndex: 1, results: [] };
    recorder.recordInjected([entry]);
    recorder.confirmAnswered([
      { role: 'assistant', content: 'an older reply' },
      { role: 'user', content: 'result C', metadata: { source: 'backend', completionEntries: [entry] } },
    ]);
    const release = vi.fn();
    await recorder.releaseOnAbort(release);
    expect(release).toHaveBeenCalledWith(entry);
  });
});
