// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: vi.fn(() => Promise.resolve(1)) },
}));

describe('BackendGraphWebSocketService main chat liveness', () => {
  afterEach(() => vi.useRealTimers());

  it('ends an orphaned chat run after the shared dead-run floor and clears the watcher', async() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service:any = Object.create(BackendGraphWebSocketService.prototype);
    const abort = new AbortController();
    const abortService = { signal: abort.signal, abort: vi.fn(() => abort.abort()) };
    service.activeAborts = new Map([['desktop|thread-1', abortService]]);
    service.emitMessage = vi.fn();
    const state:any = { metadata: {} };

    const stop = service.watchChatRun('desktop', 'thread-1', 'desktop|thread-1', state, abortService);
    expect(state.metadata.activityKeys).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(abortService.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(abortService.abort).toHaveBeenCalledOnce();
    expect(service.emitMessage).toHaveBeenCalledWith('desktop', 'assistant_message', expect.objectContaining({
      thread_id: 'thread-1', runEnded: true, kind: 'notice',
    }));
    stop();
    expect(state.metadata.activityKeys).toEqual([]);
  });

  it('does not abort a superseded run from its old watcher', async() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const service:any = Object.create(BackendGraphWebSocketService.prototype);
    const oldAbort = { signal: new AbortController().signal, abort: vi.fn() };
    const currentAbort = { signal: new AbortController().signal, abort: vi.fn() };
    service.activeAborts = new Map([['desktop|thread-1', currentAbort]]);
    service.emitMessage = vi.fn();

    const stop = service.watchChatRun('desktop', 'thread-1', 'desktop|thread-1', { metadata: {} }, oldAbort);
    await vi.advanceTimersByTimeAsync(11 * 60_000);

    expect(oldAbort.abort).not.toHaveBeenCalled();
    expect(service.emitMessage).not.toHaveBeenCalled();
    stop();
  });
});
