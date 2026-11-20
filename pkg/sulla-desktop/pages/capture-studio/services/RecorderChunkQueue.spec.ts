// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { RecorderChunkQueue } from './RecorderChunkQueue';

describe('RecorderChunkQueue', () => {
  it('waits for final asynchronous chunk writes before flush completes', async() => {
    // risk: recording integrity — the manifest must not publish before the final MediaRecorder chunk reaches disk.
    const queue = new RecorderChunkQueue();
    let finish!: () => void;
    const write = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    queue.enqueue(write);
    const flushed = queue.flush();
    expect(write).toHaveBeenCalledTimes(1);
    finish();
    await expect(flushed).resolves.toBeUndefined();
  });

  it('propagates a failed write and retries the retained chunk instead of skipping it', async() => {
    // risk: recording integrity — a transient final chunk error must block release/save and remain retryable.
    const queue = new RecorderChunkQueue();
    const write = vi.fn().mockRejectedValueOnce(new Error('disk busy')).mockResolvedValueOnce(undefined);
    queue.enqueue(write);
    await expect(queue.flush()).rejects.toThrow('disk busy');
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
