// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { OfflineErrorClassifier } from '../offlineErrorClassifier';
import { SyncDriverHealth } from '../syncDriverHealth';

describe('offline sync classification', () => {
  it('treats network-unreachable errors as offline and real errors as errors', () => {
    // risk: availability — a laptop with no network must not look like a broken sync.
    const classifier = new OfflineErrorClassifier();
    expect(classifier.isOffline(new Error('upstream_failed'))).toBe(true);
    expect(classifier.isOffline({ code: 'net::ERR_NETWORK_CHANGED' })).toBe(true);
    expect(classifier.isOffline(new Error('getaddrinfo EAI_AGAIN sulla.example'))).toBe(true);
    expect(classifier.isOffline({ code: 'ETIMEDOUT' })).toBe(true);
    expect(classifier.isOffline({ code: 'device_revoked' })).toBe(false);
    expect(classifier.isOffline(new Error('integrity_failed'))).toBe(false);
  });

  it('offline failures do not increment the error streak, and the first one starts the offline period once', () => {
    // risk: availability — offline retries must not look like a failure streak or flood the log.
    let now = 100;
    const health = new SyncDriverHealth({ now: () => now });
    health.setRunning(true);
    expect(health.unreachable()).toBe(true);
    now = 200;
    expect(health.unreachable()).toBe(false);
    expect(health.snapshot()).toMatchObject({ offlineSince: 100, consecutiveFailures: 0, lastError: null });
  });

  it('a success ends the offline period and reports it once; a real error also ends it', () => {
    // risk: availability — recovery must be reported and the offline flag must not stick.
    let now = 100;
    const health = new SyncDriverHealth({ now: () => now });
    health.unreachable();
    expect(health.succeeded(0)).toBe(true);
    expect(health.snapshot()).toMatchObject({ offlineSince: null, lastSuccessAt: 100 });
    expect(health.succeeded()).toBe(false);
    health.unreachable();
    expect(health.failed('integrity_failed')).toBe(true);
    expect(health.snapshot()).toMatchObject({ offlineSince: null, consecutiveFailures: 1, lastError: { code: 'integrity_failed' } });
  });
});
