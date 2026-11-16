// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { VaultRetryRunner, VaultTransientErrorPolicy } from '../../../../utils/vaultTransient';

describe('VaultTransientErrorPolicy', () => {
  const policy = new VaultTransientErrorPolicy();

  it('treats container-starting connection errors as transient', () => {
    // risk: availability — a vault still starting must be retried, not reported as broken.
    expect(policy.isTransient(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(true);
    expect(policy.isTransient(new Error('Vault service is unavailable: socket hang up'))).toBe(true);
  });

  it('does not retry real vault failures', () => {
    // risk: data accuracy — a locked or denied vault must surface immediately, not spin.
    expect(policy.isTransient(new Error('policy_denied'))).toBe(false);
    expect(policy.isTransient('VAULT_UI_REQUIRED')).toBe(false);
    expect(policy.isTransient(undefined)).toBe(false);
  });
});

describe('VaultRetryRunner', () => {
  it('returns the first success without waiting', async() => {
    // risk: availability — a healthy call must not pay a retry delay.
    const wait = vi.fn(async() => undefined);
    const runner = new VaultRetryRunner(new VaultTransientErrorPolicy(), wait);

    await expect(runner.run(async() => 'ok')).resolves.toBe('ok');
    expect(wait).not.toHaveBeenCalled();
  });

  it('retries transient failures until success', async() => {
    // risk: availability — a restarting vault container recovers without the user retrying.
    const wait = vi.fn(async() => undefined);
    const runner = new VaultRetryRunner(new VaultTransientErrorPolicy(), wait);
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce('unlocked');

    await expect(runner.run(work, { delayMs: 25 })).resolves.toBe('unlocked');
    expect(work).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(25);
  });

  it('stops after the configured attempts and rethrows the last error', async() => {
    // risk: availability — retries are bounded so a dead vault fails in finite time.
    const runner = new VaultRetryRunner(new VaultTransientErrorPolicy(), async() => undefined);
    const work = vi.fn(async() => { throw new Error('EPIPE') });

    await expect(runner.run(work, { attempts: 3 })).rejects.toThrow('EPIPE');
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a non-transient error', async() => {
    // risk: authorization — a denial must not be retried into a different outcome.
    const wait = vi.fn(async() => undefined);
    const runner = new VaultRetryRunner(new VaultTransientErrorPolicy(), wait);
    const work = vi.fn(async() => { throw new Error('policy_denied') });

    await expect(runner.run(work)).rejects.toThrow('policy_denied');
    expect(work).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('stops retrying when the caller says to stop', async() => {
    // risk: availability — a cancelled caller must not keep retrying in the background.
    const runner = new VaultRetryRunner(new VaultTransientErrorPolicy(), async() => undefined);
    const work = vi.fn(async() => { throw new Error('ECONNRESET') });

    await expect(runner.run(work, { shouldContinue: () => false })).rejects.toThrow('ECONNRESET');
    expect(work).toHaveBeenCalledTimes(1);
  });
});
