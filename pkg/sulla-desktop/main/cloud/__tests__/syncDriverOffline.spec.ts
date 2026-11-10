// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { SyncDriverHealth } from '../syncDriverHealth';

describe('SyncDriverHealth offline handling', () => {
  it('treats network-unreachable failures as offline without raising an error streak', () => {
    // risk: availability — a nightly internet cutoff must not look like a failing sync.
    let now = 100;
    const health = new SyncDriverHealth({ now: () => now });
    health.setRunning(true);
    expect(health.failed('sync_failed', 'getaddrinfo EAI_AGAIN sulla.example')).toBe('offline_started');
    now = 200;
    expect(health.failed('sync_failed', 'net::ERR_NETWORK_CHANGED')).toBe('offline');
    expect(health.failed('upstream_failed')).toBe('offline');
    expect(health.snapshot()).toMatchObject({ offline: true, offlineSince: 100, consecutiveFailures: 0, lastError: null });
  });

  it('still counts real errors as an error streak', () => {
    // risk: data-accuracy — a genuine server or integrity failure must stay visible.
    const health = new SyncDriverHealth({ now: () => 100 });
    expect(health.failed('integrity_failed', 'Cloud copy failed an integrity check')).toBe('error');
    expect(health.snapshot()).toMatchObject({ offline: false, consecutiveFailures: 1, lastError: { code: 'integrity_failed' } });
  });

  it('reports the recovery exactly once, when success ends an offline period', () => {
    // risk: availability — the back-online transition must be observed once, not on every retry.
    const health = new SyncDriverHealth({ now: () => 100 });
    health.failed('sync_failed', 'connect ETIMEDOUT');
    health.failed('sync_failed', 'connect ETIMEDOUT');
    expect(health.succeeded(0)).toBe(true);
    expect(health.succeeded(0)).toBe(false);
    expect(health.snapshot()).toMatchObject({ offline: false, offlineSince: null, consecutiveFailures: 0 });
  });
});
