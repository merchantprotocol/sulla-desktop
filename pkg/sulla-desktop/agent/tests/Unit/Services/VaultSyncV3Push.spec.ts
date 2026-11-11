// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  status: vi.fn(), pull: vi.fn(), prepare: vi.fn(), send: vi.fn(),
  prefs: vi.fn(), signedIn: vi.fn(), userId: vi.fn(), deviceId: vi.fn(),
  operations: [] as string[],
}));

vi.mock('@pkg/main/cloud/vaultSyncV3/containerClient', () => {
  // Defined inside the factory: vi.mock is hoisted above top-level declarations, so a
  // top-level class would still be in its temporal dead zone when the factory runs.
  class FakeVaultContainer {
    status = boundary.status;
    pull = boundary.pull;
    prepare = boundary.prepare;
    send = boundary.send;
  }
  return {
    VaultSyncContainer: new FakeVaultContainer(),
    ContainerSyncError: class ContainerSyncError extends Error {
      constructor(public readonly code: string, public readonly status: number, message?: string) { super(message || code); }
    },
  };
});
vi.mock('@pkg/main/cloud/cloudSettings', () => ({ getCloudPreferences: boundary.prefs }));
vi.mock('@pkg/main/cloud/cloudFetch', () => ({ isCloudSignedIn: boundary.signedIn }));
vi.mock('@pkg/main/sullaCloudAuth', () => ({ getCurrentUserId: boundary.userId }));
vi.mock('@pkg/main/deviceIdentity', () => ({ getDesktopDeviceId: boundary.deviceId }));
vi.mock('@pkg/main/cloud/deviceKey', () => ({ signDeviceMessage: () => ({ ts: 10, signature: 'synthetic-signature' }) }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { log: vi.fn(), warn: vi.fn() } } }));

import { VaultSyncV3 } from '@pkg/main/cloud/vaultSyncV3';
import { ContainerSyncError } from '@pkg/main/cloud/vaultSyncV3/containerClient';

describe('VaultSyncV3 verified Cloud bundle push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundary.prefs.mockResolvedValue({ enabled: true, vault: true });
    boundary.signedIn.mockResolvedValue(true);
    boundary.userId.mockResolvedValue('synthetic-user');
    boundary.deviceId.mockResolvedValue('synthetic-device');
    boundary.status.mockResolvedValue({ configured: true, bundleStale: true, pendingChanges: 2 });
    boundary.pull.mockResolvedValue({ applied: 0, conflictCopies: 0, headSeq: 4 });
    boundary.prepare.mockImplementation(async(op: string) => {
      boundary.operations.push(op);
      return { handle: 'synthetic-handle', sha256: 'synthetic-hash', vaultId: 'synthetic-vault', op };
    });
    boundary.send.mockResolvedValue({ ok: true, status: 200 });
  });

  it('commits pending edits once when a stale local fingerprint accompanies a valid remote bundle', async() => {
    // risk: data loss — local bookkeeping drift must not block delivery of pending records or rewrap the Cloud bundle.
    const result = await VaultSyncV3.syncNow();
    expect(boundary.operations).toEqual(['commit']);
    expect(boundary.send).toHaveBeenCalledTimes(1);
    expect(result.lastError).toBeUndefined();
    expect(boundary.status).toHaveBeenCalledTimes(3);
  });

  it('does not commit and reports integrity failure when pull rejects an unverifiable remote bundle', async() => {
    // risk: data integrity — an unverifiable Cloud bundle must stop before any pending record is committed.
    boundary.pull.mockRejectedValue(new ContainerSyncError('integrity_failed', 409, 'verification failed'));
    const result = await VaultSyncV3.syncNow();
    expect(boundary.send).not.toHaveBeenCalled();
    expect(result.lastError).toContain('integrity check');
    expect(result.lastError).not.toContain('verification failed');
  });

  it('never calls a users write surface during synchronization', async() => {
    // risk: key custody — sync must not overwrite the local straight user key while uploading records.
    await VaultSyncV3.syncNow();
    expect(boundary.operations).not.toContain('users.write');
    expect(boundary.operations).not.toContain('rewrap');
  });
});
