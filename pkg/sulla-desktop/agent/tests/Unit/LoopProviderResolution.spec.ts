// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { LoopProviderResolution, LoopProviderResolutionError } from '../../nodes/LoopProviderResolution';

describe('LoopProviderResolution', () => {
  it('bounds a hung provider stage, retries it, and fails with its stage but no dependency message', async() => {
    const resolution = new LoopProviderResolution({ timeoutMs: 75, attemptTimeoutMs: 30, maxAttempts: 3, retryBackoffMs: [5, 5] });
    let attempts = 0;
    const startedAt = performance.now();
    let failure: unknown;

    try {
      await resolution.run(async({ stage }) => {
        attempts++;
        return stage('providerRegistry.getServiceByProvider', () => new Promise<never>(() => {}));
      });
    } catch (error) {
      failure = error;
    }

    const elapsedMs = performance.now() - startedAt;
    expect(failure).toBeInstanceOf(LoopProviderResolutionError);
    expect(failure).toMatchObject({ stage: 'providerRegistry.getServiceByProvider', attempts: 3, timedOut: true });
    expect(attempts).toBe(3);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('retries a transient provider failure and returns the recovered service', async() => {
    const resolution = new LoopProviderResolution({ timeoutMs: 300, attemptTimeoutMs: 100, maxAttempts: 3, retryBackoffMs: [0, 0] });
    const service = { provider: 'fixture' };
    let attempts = 0;

    const result = await resolution.run(async({ stage }) => {
      attempts++;
      return stage('turnProviderResolver.resolve', async() => {
        if (attempts === 1) throw new Error('transient dependency failure');
        return service;
      });
    });

    expect(result).toBe(service);
    expect(attempts).toBe(2);
  });

  it('does not include dependency error details when provider resolution ultimately fails', async() => {
    const resolution = new LoopProviderResolution({ timeoutMs: 300, attemptTimeoutMs: 100, maxAttempts: 3, retryBackoffMs: [0, 0] });
    const privateDetail = 'must-not-appear-in-provider-error';
    let failure: unknown;

    try {
      await resolution.run(({ stage }) => stage('turnProviderResolver.resolve', async() => { throw new Error(privateDetail) }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(LoopProviderResolutionError);
    expect((failure as Error).message).toContain('turnProviderResolver.resolve');
    expect((failure as Error).message).not.toContain(privateDetail);
  });
});
