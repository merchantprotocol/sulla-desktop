// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  clearCompletionInboxes, COMPLETION_COALESCE_MS, enqueueAgentCompletion,
  registerCompletionIdleDispatcher, takeAgentCompletions,
} from '../AgentCompletionInbox';

describe('AgentCompletionInbox', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { clearCompletionInboxes(); jest.useRealTimers() });

  it('queues completions until the owner drains them after its active turn', () => {
    const dispatch = jest.fn();
    registerCompletionIdleDispatcher(dispatch);
    enqueueAgentCompletion('sulla-desktop', 'parent', { jobId: 'job-1', results: [] });

    expect(takeAgentCompletions('sulla-desktop', 'parent').map(item => item.jobId)).toEqual(['job-1']);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('coalesces N idle completions into one wake window', () => {
    const dispatch = jest.fn();
    registerCompletionIdleDispatcher(dispatch);
    for (let index = 0; index < 4; index++) {
      enqueueAgentCompletion('sulla-desktop', 'parent', { jobId: `job-${ index }`, results: [] });
    }

    jest.advanceTimersByTime(COMPLETION_COALESCE_MS);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(takeAgentCompletions('sulla-desktop', 'parent')).toHaveLength(4);
  });
});
