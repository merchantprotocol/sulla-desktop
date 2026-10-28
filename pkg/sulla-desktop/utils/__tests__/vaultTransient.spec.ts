/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, test } from '@jest/globals';

import { isTransientVaultError, retryTransientVault } from '../vaultTransient';

describe('vault transient errors', () => {
  test('recognises the connection errors seen while the vault container restarts', () => {
    for (const message of [
      "Error invoking remote method 'vault:view-open': LocalVaultError: Vault service is unavailable: net::ERR_CONNECTION_CLOSED",
      'Vault service is unavailable: net::ERR_CONNECTION_REFUSED',
      'connect ECONNREFUSED 127.0.0.1:30135',
    ]) expect(isTransientVaultError(new Error(message))).toBe(true);
    expect(isTransientVaultError(new Error('Invalid vault view owner'))).toBe(false);
  });

  test('retries transient failures and then succeeds', async() => {
    let calls = 0;
    const value = await retryTransientVault(async() => {
      if (++calls < 3) throw new Error('net::ERR_CONNECTION_CLOSED');

      return 'ok';
    }, { delayMs: 1 });

    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  test('does not retry real errors, and stops when told to', async() => {
    let calls = 0;

    await expect(retryTransientVault(async() => { calls++; throw new Error('Invalid vault view owner') }, { delayMs: 1 })).rejects.toThrow('Invalid');
    expect(calls).toBe(1);
    calls = 0;
    await expect(retryTransientVault(async() => { calls++; throw new Error('net::ERR_CONNECTION_CLOSED') }, { delayMs: 1, shouldContinue: () => false })).rejects.toThrow('CONNECTION_CLOSED');
    expect(calls).toBe(1);
  });
});
