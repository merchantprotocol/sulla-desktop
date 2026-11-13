// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Vault enrollment now signs with this install's one domain identity, desktopDeviceIdentity(). The enrollment
// framing (DeviceSignaturePayload through signerFor) must produce exactly what deviceKey.ts signDeviceMessage
// produces for vault-sync-v3 with the same key and clock, ts in SECONDS, and must never rewrite the key file.
// Real DesktopVaultEnrollmentModule, real file adapters in a temp dir; only Cloud, the broker and Electron are fakes.
// Synthetic key only.

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEnrollmentCloud, FakeVaultBroker, FixedDeviceKeyDir } from '../../Support/Vault/EnrollmentFakes';

const env = vi.hoisted(() => ({ deviceDir: '', cloud: null as any, broker: null as any }));

vi.mock('@pkg/utils/paths', () => ({ default: { get sullaConfig() { return env.deviceDir } } }));
vi.mock('../../../../main/sullaCloudAuth', () => ({ getCurrentUserId: async() => 'user-0001' }));
vi.mock('../../../../main/cloud/cloudFetch', () => ({ cloudRequest: (method: string, url: string, options: any) => env.cloud.request(method, url, options) }));
vi.mock('@pkg/vault-broker', () => ({ getConfiguredApprovalClient: () => env.broker }));
vi.mock('@pkg/sulla', () => ({ onVaultUnlocked: async() => undefined }));
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showMessageBox: async() => ({ response: 1 }) } }));

import { _resetDeviceKeyCache, signDeviceMessage } from '../../../../main/cloud/deviceKey';
import { DesktopVaultEnrollmentModule } from '../../../../main/cloud/enrollment/DesktopVaultEnrollmentModule';

const VAULT = '11111111-2222-4333-8444-555555555555';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** Ed25519 over "sulla-vault-sync-v3\nuser-0001\ndevice-0001\n<VAULT>\nenrollment-state\n<EMPTY_SHA256>\n1770000000" with FixedDeviceKeyDir's seed. */
const PINNED_SIGNATURE = 'WRchWhF7272esCSp70CmnaSV6h1iMWabCwZi9BQe7s9jlc/G8QKR4KgfVLZaK6S9cVvtYUpbMBNF6rU//xtJAA==';

let keyDir: FixedDeviceKeyDir;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_770_000_000_123, toFake: ['Date'] });
  keyDir = new FixedDeviceKeyDir();
  env.deviceDir = keyDir.dir;
  env.cloud = new FakeEnrollmentCloud(VAULT);
  env.broker = new FakeVaultBroker();
  _resetDeviceKeyCache();
});

afterEach(() => {
  vi.useRealTimers();
  _resetDeviceKeyCache();
  keyDir.remove();
});

describe('vault enrollment signs with desktopDeviceIdentity()', () => {
  it('sends the same vault-sync-v3 signature deviceKey.ts signDeviceMessage makes, ts in seconds', async() => {
    // risk: Cloud rejects every enrollment call if the enrollment signer drifts from the device signer
    await new DesktopVaultEnrollmentModule().coordinator.gate();
    const [call] = (env.cloud as FakeEnrollmentCloud).callsTo('/cloud-vault-sync/enrollment/state');
    const reference = await signDeviceMessage('vault-sync-v3', ['user-0001', 'device-0001', VAULT, 'enrollment-state', EMPTY_SHA256]);

    expect(call.query.get('deviceId')).toBe('device-0001');
    expect(reference.ts).toBe(1_770_000_000);
    expect(call.headers['X-Sulla-Timestamp']).toBe(String(reference.ts));
    expect(call.headers['X-Sulla-Device-Signature']).toBe(reference.signature);
    expect(call.headers['X-Sulla-Device-Signature']).toBe(PINNED_SIGNATURE);
    expect(FixedDeviceKeyDir.verify(['sulla-vault-sync-v3', 'user-0001', 'device-0001', VAULT, 'enrollment-state', EMPTY_SHA256, '1770000000'].join('\n'), PINNED_SIGNATURE)).toBe(true);
  });

  it('uses the existing key and device id and never rewrites either file', async() => {
    // risk: re-minting the key or id orphans this computer from Cloud
    const keyFile = path.join(keyDir.dir, 'device-key.json');
    const before = fs.readFileSync(keyFile, 'utf8');
    await new DesktopVaultEnrollmentModule().coordinator.gate();
    await new DesktopVaultEnrollmentModule().coordinator.gate();
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(keyDir.dir, 'device-id'), 'utf8')).toBe('device-0001');
  });
});
