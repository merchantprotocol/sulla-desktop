// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { SullaFilesGenerationRun } from './SullaFilesGenerationRun';

describe('SullaFilesGenerationRun', () => {
  it('waits out a superseded unlock then starts the current generation without a delay', async() => {
    // risk: startup availability — a stale unlock must not strand Files behind retries/backoff.
    vi.useFakeTimers();
    const coordinator = new SullaFilesGenerationRun();
    let releaseOld!:(error?:Error)=>void;
    const started:number[] = [];
    const perform = vi.fn((generation:number) => {
      started.push(generation);
      if (generation === 1) return new Promise<void>((resolve, reject) => {
        releaseOld = error => error ? reject(error) : resolve();
      });
      return Promise.resolve();
    });

    const oldRun = coordinator.run(1, perform);
    const currentRun = coordinator.run(2, perform);
    expect(started).toEqual([1]);
    releaseOld(new Error('Files unlock was superseded'));
    await expect(oldRun).rejects.toThrow('Files unlock was superseded');
    await expect(currentRun).resolves.toBeUndefined();
    expect(started).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
