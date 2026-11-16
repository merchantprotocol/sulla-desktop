// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutomergeSnapshotPruner } from '../src/Services/AutomergeSnapshotPruner.js';

describe('AutomergeSnapshotPruner', () => {
  afterEach(() => { vi.useRealTimers() });

  it('runs one prune loop per minute however often it is started, and stops cleanly', async() => {
    // risk: data accuracy / load — building the app twice used to be able to stack retention loops; a stopped app must stop pruning.
    vi.useFakeTimers();
    const prune = vi.fn(async() => 0);
    const pruner = new AutomergeSnapshotPruner({ prune });
    pruner.start(); pruner.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prune).toHaveBeenCalledTimes(1);
    pruner.stop();
    expect(pruner.running).toBe(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('logs a failed prune and keeps the loop running', async() => {
    // risk: availability — one failed retention pass must not end retention for the life of the process.
    vi.useFakeTimers();
    const failure = new Error('database down');
    const prune = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(0);
    const warn = vi.fn();
    const pruner = new AutomergeSnapshotPruner({ prune }, 1_000, warn);
    pruner.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(warn).toHaveBeenCalledWith('[SullaFiles] Automerge snapshot retention failed:', failure);
    expect(prune).toHaveBeenCalledTimes(2);
    pruner.stop();
  });
});
