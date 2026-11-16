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

import type { DesktopVaultClient } from '../../../services/DesktopVaultClient';
import { isVaultSnapshot, SNAPSHOT_FORMAT, VaultBackupService } from '../../../services/VaultBackupService';

describe('VaultBackupService', () => {
  it('refuses key-bearing operations and points the human at the isolated window', async() => {
    // risk: secret disclosure — Desktop must never export or decrypt a snapshot itself.
    const service = new VaultBackupService(() => ({}) as DesktopVaultClient);

    await expect(service.buildExport()).rejects.toThrow('VAULT_UI_REQUIRED');
    await expect(service.createSnapshot('manual')).rejects.toThrow('VAULT_UI_REQUIRED');
    await expect(service.restoreSnapshot({ format: SNAPSHOT_FORMAT } as never)).rejects.toThrow('VAULT_UI_REQUIRED');
  });

  it('opens the backup UI through the injected client', async() => {
    // risk: authorization — the backup UI session comes from the container, never a Desktop-held key.
    const createHumanSession = vi.fn(async() => ({ url: 'https://vault/vault/backup', expiresAt: 1, phase: 'pre-unlock' }));
    const service = new VaultBackupService(() => ({ createHumanSession }) as unknown as DesktopVaultClient);

    await expect(service.openBackupUi()).resolves.toMatchObject({ url: 'https://vault/vault/backup' });
    expect(createHumanSession).toHaveBeenCalledTimes(1);
  });

  it('recognises only snapshots in the vault snapshot format', () => {
    // risk: data accuracy — a foreign file must not be treated as a vault snapshot.
    expect(isVaultSnapshot({ format: SNAPSHOT_FORMAT })).toBe(true);
    expect(isVaultSnapshot({ format: 'other' })).toBe(false);
    expect(isVaultSnapshot(null)).toBe(false);
  });
});
