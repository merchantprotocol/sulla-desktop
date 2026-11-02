// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';
import { BackendGraphWebSocketService } from '../BackendGraphWebSocketService';

describe('BackendGraphWebSocketService sleep recovery', () => {
  it('aborts only a run stamped at suspend and reissues continue for its thread', async() => {
    jest.useFakeTimers();
    const service: any = Object.create(BackendGraphWebSocketService.prototype);
    const abort = { abort: jest.fn() };
    service.activeAborts = new Map([['sulla-desktop|thread-1', abort]]);
    service.suspendedRuns = new Set();
    service.resumeContexts = new Map([['sulla-desktop|thread-1', {
      channelId: 'sulla-desktop', triggerType: 'sulla-desktop', threadId: 'thread-1', inputSource: 'keyboard',
    }]]);
    service.dispatchToAgent = jest.fn(() => Promise.resolve());

    service.handleSuspend();
    service.handleResume();
    expect(abort.abort).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync();
    expect(service.dispatchToAgent).toHaveBeenCalledWith(
      'sulla-desktop', 'sulla-desktop', expect.stringContaining('Continue from where you stopped'),
      'thread-1', undefined, undefined, 'keyboard',
      { source: 'system_resume', inputSource: 'system' },
    );
    jest.useRealTimers();
  });
});
