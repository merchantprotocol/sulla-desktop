// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { VaultBootstrapRetry } from './VaultBootstrapRetry';

describe('VaultBootstrapRetry', () => {
  it('retries connection-refused during first boot until the vault is reachable', async() => {
    // risk: availability — transient first-boot vault startup must not leave the lifecycle permanently locked.
    const sleep = vi.fn(async() => undefined);
    const responses = [
      { ok: false, error: 'connect ECONNREFUSED' },
      { ok: false, error: 'connect ECONNREFUSED' },
      { ok: true, state: 'unlocked' },
    ];
    const attempt = vi.fn(async() => responses.shift()!);
    const retry = new VaultBootstrapRetry({ sleep, log: vi.fn() });

    await expect(retry.run(attempt)).resolves.toEqual({ ok: true, state: 'unlocked' });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient bootstrap failure', async() => {
    // risk: correctness — locked or invalid-vault results must not be retried as transport failures.
    const attempt = vi.fn(async() => ({ ok: false, error: 'invalid vault identity' }));
    const retry = new VaultBootstrapRetry({ sleep: vi.fn(), log: vi.fn() });

    await expect(retry.run(attempt)).resolves.toEqual({ ok: false, error: 'invalid vault identity' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
