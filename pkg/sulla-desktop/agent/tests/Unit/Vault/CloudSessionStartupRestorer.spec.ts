// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { CloudSessionStartupRestorer, VaultNotReadyError } from '../../../../main/cloud/session/CloudSessionStartupRestorer';

describe('CloudSessionStartupRestorer', () => {
  const brokerWith = (metadata: { activeAccountId?: string; accounts: Array<{ accountId: string; active?: boolean; connected: boolean }> }) => ({
    status: vi.fn().mockResolvedValue({ unlocked: true }),
    integrationMetadata: vi.fn().mockResolvedValue(metadata),
  });

  it('restores the connected active account after legacy adoption', async() => {
    // risk: session recovery — restore only a connected account and adopt legacy data before resolving the identity.
    const broker = brokerWith({ activeAccountId: 'user-1', accounts: [{ accountId: 'user-1', connected: true }] });
    const adopt = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();
    const service = new CloudSessionStartupRestorer({
      broker: () => broker, ensureLegacySessionAdopted: adopt, hasPendingCredential: () => false,
      signInAgainMessage: 'Sign in again', setAdoptionError: setError,
    });

    await expect(service.restore()).resolves.toEqual({ userId: 'user-1', activeContractorId: 'user-1', contractors: [] });
    expect(adopt).toHaveBeenCalledOnce();
    expect(setError).toHaveBeenLastCalledWith(undefined);
  });

  it('keeps startup restore retryable while first-run credentials are still being saved', async() => {
    // risk: sign-in/session recovery — do not report a newly signed-in user as signed out before vault adoption lands.
    const broker = brokerWith({ accounts: [] });
    const service = new CloudSessionStartupRestorer({
      broker: () => broker, ensureLegacySessionAdopted: vi.fn(), hasPendingCredential: () => true,
      signInAgainMessage: 'Sign in again', setAdoptionError: vi.fn(),
    });

    await expect(service.restore()).rejects.toBeInstanceOf(VaultNotReadyError);
  });

  it('reports a missing session as signed out only when no pending first-run session exists', async() => {
    const broker = brokerWith({ accounts: [] });
    const setError = vi.fn();
    const service = new CloudSessionStartupRestorer({
      broker: () => broker, ensureLegacySessionAdopted: vi.fn(), hasPendingCredential: () => false,
      signInAgainMessage: 'Sign in again', setAdoptionError: setError,
    });

    await expect(service.restore()).resolves.toBeNull();
    expect(setError).toHaveBeenCalledWith('Sign in again');
  });

  it('retries when the vault is locked and propagates unrelated failures', async() => {
    // risk: startup lifecycle — lock/unavailable failures must keep restore waiting, not falsely mark the account signed out.
    const lockedBroker = { status: vi.fn().mockResolvedValue({ unlocked: false }), integrationMetadata: vi.fn() };
    const service = new CloudSessionStartupRestorer({
      broker: () => lockedBroker, ensureLegacySessionAdopted: vi.fn(), hasPendingCredential: () => false,
      signInAgainMessage: 'Sign in again', setAdoptionError: vi.fn(),
    });
    await expect(service.restore()).rejects.toBeInstanceOf(VaultNotReadyError);

    const terminal = new Error('bad metadata');
    const brokenService = new CloudSessionStartupRestorer({
      broker: () => ({ status: vi.fn().mockResolvedValue({ unlocked: true }), integrationMetadata: vi.fn().mockRejectedValue(terminal) }),
      ensureLegacySessionAdopted: vi.fn(), hasPendingCredential: () => false,
      signInAgainMessage: 'Sign in again', setAdoptionError: vi.fn(),
    });
    await expect(brokenService.restore()).rejects.toBe(terminal);
  });
});
