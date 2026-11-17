// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSyncCommitWakeup } from '../src/cloudSync/CloudSyncCommitWakeup.js';

describe('CloudSyncCommitWakeup', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid saves in one collection and keeps collections independent', async() => {
    vi.useFakeTimers();
    const wake = vi.fn();
    const commits = new CloudSyncCommitWakeup(wake, 350);
    commits.notify('collection-a');
    await vi.advanceTimersByTimeAsync(200);
    commits.notify('collection-a');
    await vi.advanceTimersByTimeAsync(100);
    commits.notify('collection-b');
    await vi.advanceTimersByTimeAsync(250);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe('collection-a');
    await vi.advanceTimersByTimeAsync(100);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[1][0]).toBe('collection-b');
    expect(wake.mock.calls[1][1]).toBeGreaterThan(wake.mock.calls[0][1]);
    commits.close();
  });

  it('cancels pending work during shutdown', async() => {
    vi.useFakeTimers();
    const wake = vi.fn();
    const commits = new CloudSyncCommitWakeup(wake, 350);
    commits.notify('collection-a');
    commits.close();
    await vi.advanceTimersByTimeAsync(350);
    expect(wake).not.toHaveBeenCalled();
  });
});
