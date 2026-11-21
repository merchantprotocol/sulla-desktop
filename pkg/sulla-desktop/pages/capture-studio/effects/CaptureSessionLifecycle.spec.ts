// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { CaptureSessionLifecycle } from './CaptureSessionLifecycle';

describe('CaptureSessionLifecycle close barrier', () => {
  it('waits for pending acquisitions before releasing their resources', async() => {
    // risk: stream custody — teardown must not race a screen/camera acquisition still in flight.
    const lifecycle = new CaptureSessionLifecycle();
    let acquired!: () => void;
    let acquisitionFinished = false;
    const acquire = lifecycle.protect(() => new Promise<void>(resolve => {
      acquired = () => { acquisitionFinished = true; resolve(); };
    }));
    const acquisition = acquire();
    const release = vi.fn(async() => { expect(acquisitionFinished).toBe(true); });
    const closing = lifecycle.close(release);

    expect(lifecycle.hasPendingAcquisitions).toBe(true);
    acquired();
    await expect(acquisition).rejects.toThrow('Capture Studio is closing');
    await closing;
    expect(release).toHaveBeenCalledTimes(1);
    expect(lifecycle.isClosing).toBe(true);
  });

  it('reopens the barrier after a failed finalization so the user can retry', async() => {
    // risk: recording integrity — failed manifest writes must keep Capture Studio open and retryable.
    const lifecycle = new CaptureSessionLifecycle();
    const failedFinalization = vi.fn().mockRejectedValueOnce(new Error('manifest write failed')).mockResolvedValueOnce(undefined);

    await expect(lifecycle.close(failedFinalization)).rejects.toThrow('manifest write failed');
    expect(lifecycle.isClosing).toBe(false);
    await expect(lifecycle.close(failedFinalization)).resolves.toBeUndefined();
    expect(failedFinalization).toHaveBeenCalledTimes(2);
  });
});
