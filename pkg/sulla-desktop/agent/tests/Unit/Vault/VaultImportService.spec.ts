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
import { VaultImportService } from '../../../services/VaultImportService';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

describe('VaultImportService.legacyAccountItemId', () => {
  it('derives the same UUID-shaped id every time for the same account', () => {
    // risk: data accuracy — a migrated item must keep its id across runs or it duplicates.
    const first = VaultImportService.legacyAccountItemId('github', 'acct-1');
    expect(VaultImportService.legacyAccountItemId('github', 'acct-1')).toBe(first);
    expect(first).toMatch(UUID_SHAPE);
  });

  it('gives different accounts different ids', () => {
    // risk: data accuracy — two accounts must never collapse into one vault item.
    expect(VaultImportService.legacyAccountItemId('github', 'acct-1'))
      .not.toBe(VaultImportService.legacyAccountItemId('github', 'acct-2'));
    expect(VaultImportService.legacyAccountItemId('github', 'acct-1'))
      .not.toBe(VaultImportService.legacyAccountItemId('gitlab', 'acct-1'));
  });
});

describe('VaultImportService.importLegacyCredentials', () => {
  it('triggers the container migration and ignores the password', async() => {
    // risk: secret disclosure — no human password crosses into Desktop; the migration runs in the container.
    const migrate = vi.fn(async() => ({ migrated: 0 }));
    const service = new VaultImportService(() => ({ migrate }) as unknown as DesktopVaultClient);

    await service.importLegacyCredentials('hunter2');
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith();
  });
});
