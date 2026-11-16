// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {},
  safeStorage: { isEncryptionAvailable: () => true, decryptString: () => '' },
  session: { fromPartition: () => ({}) },
  ipcRenderer: { on: () => undefined, invoke: async() => undefined },
  default: {},
}));

import { VaultUnlockController, type VaultUnlockIpc } from '../../../../composables/useVaultUnlock';

function fakeIpc(responses: Record<string, unknown | Error>): VaultUnlockIpc & { listeners: Record<string, () => void> } {
  const listeners: Record<string, () => void> = {};

  return {
    listeners,
    on: (channel, listener) => { listeners[channel] = listener; return undefined },
    invoke: vi.fn(async(channel: string) => {
      const value = responses[channel];
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

describe('VaultUnlockController', () => {
  it('settles on the quick status when the vault is already unlocked', async() => {
    // risk: availability — the common already-unlocked case must not wait on the bootstrap helper.
    const ipc = fakeIpc({ 'vault:status': { unlocked: true, state: 'unlocked' } });
    const controller = new VaultUnlockController(ipc);

    await controller.tryAutoLogin();
    expect(controller.loggedIn.value).toBe(true);
    expect(controller.statusResolved.value).toBe(true);
    expect(ipc.invoke).not.toHaveBeenCalledWith('vault:initialize');
  });

  it('runs the bootstrap path when the vault is locked and not set up', async() => {
    // risk: availability — a locked vault gets an unlock attempt instead of staying stuck.
    const ipc = fakeIpc({ 'vault:status': { unlocked: false, state: 'locked' }, 'vault:initialize': undefined });
    const controller = new VaultUnlockController(ipc);

    await controller.tryAutoLogin();
    expect(ipc.invoke).toHaveBeenCalledWith('vault:initialize');
    expect(controller.loggedIn.value).toBe(false);
  });

  it('treats a migration-required vault as not set up', async() => {
    // risk: data accuracy — a vault awaiting migration must not show the unlock prompt as usable.
    const ipc = fakeIpc({ 'vault:status': { unlocked: false, state: 'migration_required' } });
    const controller = new VaultUnlockController(ipc);

    await controller.refreshStatus();
    expect(controller.vaultSetUp.value).toBe(false);
  });

  it('shows the error and stays logged out when the status call fails', async() => {
    // risk: authorization — an unreachable vault must never look unlocked.
    const ipc = fakeIpc({ 'vault:status': new Error('vault down') });
    const controller = new VaultUnlockController(ipc);

    await expect(controller.refreshStatus()).resolves.toBe(false);
    expect(controller.unlockError.value).toBe('vault down');
    expect(controller.loggedIn.value).toBe(false);
  });

  it('logs out locally even when the lock call fails', async() => {
    // risk: authorization — logout always clears the local unlocked state.
    const ipc = fakeIpc({ 'vault:lock-vault': new Error('gone') });
    const controller = new VaultUnlockController(ipc);
    controller.loggedIn.value = true;

    await controller.logout();
    expect(controller.loggedIn.value).toBe(false);
  });

  it('binds the public surface so callers can destructure it', () => {
    // risk: availability — destructured methods keep working outside the controller.
    const controller = new VaultUnlockController(fakeIpc({}));
    const { logout, refreshStatus } = controller.surface();

    expect(typeof logout).toBe('function');
    expect(typeof refreshStatus).toBe('function');
  });
});
