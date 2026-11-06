// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { StorageWatchService, type StorageWatchSettings } from '@pkg/main/StorageWatchService';

const GIB = 2 ** 30;
const defaults = (): StorageWatchSettings => ({
  enabled: true, warningFreeGb: 40, warningFreePct: 10, criticalFreeGb: 15, criticalFreePct: 4,
  lastWarningAt: 0, lastCriticalAt: 0,
});

class Harness {
  now = 1_000_000_000;
  config = defaults();
  probe = vi.fn(async() => ({ freeBytes: 30 * GIB, totalBytes: 460 * GIB, vmUsedPct: 'unknown' as const }));
  inProgress = false;
  start = vi.fn(async() => 'started' as const);
  notify = vi.fn();
  service = new StorageWatchService(
    this.probe,
    { read: () => this.config, writeLastRun: (level, timestamp) => { if (level === 'critical') this.config.lastCriticalAt = timestamp; else this.config.lastWarningAt = timestamp } },
    { isRunInProgress: async() => this.inProgress, start: this.start },
    { show: this.notify }, { now: () => this.now }, { info: vi.fn(), warn: vi.fn() },
  );
}

describe('StorageWatchService', () => {
  it('classifies warning and critical thresholds by bytes or percentage', () => {
    // risk: data correctness — either threshold must protect the disk.
    const h = new Harness();
    expect(h.service.levelFor({ freeBytes: 39 * GIB, totalBytes: 500 * GIB, vmUsedPct: 'unknown' }, h.config)).toBe('warning');
    expect(h.service.levelFor({ freeBytes: 45 * GIB, totalBytes: 460 * GIB, vmUsedPct: 'unknown' }, h.config)).toBe('warning');
    expect(h.service.levelFor({ freeBytes: 14 * GIB, totalBytes: 500 * GIB, vmUsedPct: 'unknown' }, h.config)).toBe('critical');
    expect(h.service.levelFor({ freeBytes: 20 * GIB, totalBytes: 600 * GIB, vmUsedPct: 'unknown' }, h.config)).toBe('critical');
  });

  it('blocks the same level during cooldown but permits one warning-to-critical escalation', () => {
    // risk: irreversible side effects — duplicate optimizer agents must not start.
    const h = new Harness();
    h.config.lastWarningAt = h.now - 60_000;
    expect(h.service.cooldownAllows('warning', h.config, h.now)).toBe(false);
    expect(h.service.cooldownAllows('critical', h.config, h.now)).toBe(true);
    h.config.lastCriticalAt = h.now - 60_000;
    expect(h.service.cooldownAllows('critical', h.config, h.now)).toBe(false);
    expect(h.service.cooldownAllows('warning', h.config, h.now)).toBe(false);
  });

  it('does not fire while an optimizer run is active', async() => {
    // risk: irreversible side effects — concurrent cleanup runs must not overlap.
    const h = new Harness();
    h.inProgress = true;
    await h.service.check();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});
