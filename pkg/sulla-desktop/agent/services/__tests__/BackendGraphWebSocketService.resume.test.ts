// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';
import { BackendGraphWebSocketService } from '../BackendGraphWebSocketService';

describe('BackendGraphWebSocketService sleep recovery', () => {
  it('snapshots runs stamped at suspend, reinitializes, then continues only those threads', async() => {
    jest.useFakeTimers();
    const service: any = Object.create(BackendGraphWebSocketService.prototype);
    const abort = { abort: jest.fn() };
    service.activeAborts = new Map([['sulla-desktop|thread-1', abort]]);
    service.suspendedRuns = new Set();
    service.resumeContexts = new Map([['sulla-desktop|thread-1', {
      channelId: 'sulla-desktop', triggerType: 'sulla-desktop', threadId: 'thread-1', inputSource: 'keyboard',
    }]]);
    service.dispatchToAgent = jest.fn(() => Promise.resolve());
    // Mirror the real reinitialize(): dispose() aborts every run and clears bookkeeping.
    service.reinitialize = jest.fn(() => {
      for (const a of service.activeAborts.values()) a.abort();
      service.activeAborts.clear();
      service.resumeContexts.clear();
      service.suspendedRuns.clear();
    });

    service.handleSuspend();
    service.handleResume();
    expect(service.reinitialize).toHaveBeenCalledTimes(1);
    expect(abort.abort).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync();
    expect(service.dispatchToAgent).toHaveBeenCalledWith(
      'sulla-desktop', 'sulla-desktop', expect.stringContaining('Continue from where you stopped'),
      'thread-1', undefined, undefined, 'keyboard',
      { source: 'system_resume', inputSource: 'system' },
    );
    expect(service.dispatchToAgent).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('reinitializes without continuing anything when no run crossed sleep', async() => {
    jest.useFakeTimers();
    const service: any = Object.create(BackendGraphWebSocketService.prototype);
    service.activeAborts = new Map();
    service.suspendedRuns = new Set();
    service.resumeContexts = new Map();
    service.dispatchToAgent = jest.fn(() => Promise.resolve());
    service.reinitialize = jest.fn();
    service.handleSuspend();
    service.handleResume();
    await jest.runAllTimersAsync();
    expect(service.reinitialize).toHaveBeenCalledTimes(1);
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
