// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// The device identity is injected in exactly one place (DesktopVaultEnrollmentModule's constructor), so
// a test (or a future identity) can be passed in without touching enrollment. Synthetic data.

import { DeviceId } from '@sulla/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEnrollmentCloud, FakeVaultBroker } from '../../Support/Vault/EnrollmentFakes';

const env = vi.hoisted(() => ({ cloud: null as any, broker: null as any }));

vi.mock('@pkg/utils/paths', () => ({ default: { get sullaConfig() { throw new Error('interim stores must not be used') } } }));
vi.mock('../../../../main/deviceIdentity', () => ({ getDesktopDeviceId: async() => { throw new Error('interim id store must not be used') } }));
vi.mock('../../../../main/cloud/deviceKey', () => ({ getDevicePublicKey: () => { throw new Error('interim key store must not be used') } }));
vi.mock('../../../../main/sullaCloudAuth', () => ({ getCurrentUserId: async() => 'user-0001' }));
vi.mock('../../../../main/cloud/cloudFetch', () => ({ cloudRequest: (method: string, url: string, options: any) => env.cloud.request(method, url, options) }));
vi.mock('@pkg/vault-broker', () => ({ getConfiguredApprovalClient: () => env.broker }));
vi.mock('@pkg/sulla', () => ({ onVaultUnlocked: async() => undefined }));
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showMessageBox: async() => ({ response: 1 }) } }));

const VAULT = '11111111-2222-4333-8444-555555555555';

class InjectedIdentity {
  readonly signed: Uint8Array[] = [];
  async deviceId(): Promise<DeviceId> { return DeviceId.of('device-injected') }
  signerFor(purpose: 'vault-sync-v3') {
    return { purpose, sign: async(payload: Uint8Array) => { this.signed.push(payload); return 'injected-signature' } };
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_770_000_000_000, toFake: ['Date'] });
  env.cloud = new FakeEnrollmentCloud(VAULT);
  env.broker = new FakeVaultBroker();
});

afterEach(() => { vi.useRealTimers() });

describe('DesktopVaultEnrollmentModule device identity seam', () => {
  it('signs every Cloud enrollment call with the injected identity, not the interim stores', async() => {
    // risk: after the M4 swap enrollment would still sign with a different key and Cloud would reject it
    const { DesktopVaultEnrollmentModule } = await import('../../../../main/cloud/enrollment/DesktopVaultEnrollmentModule');
    const identity = new InjectedIdentity();
    const module = new DesktopVaultEnrollmentModule(identity as never);
    await module.coordinator.gate();
    const [call] = (env.cloud as FakeEnrollmentCloud).callsTo('/cloud-vault-sync/enrollment/state');
    expect(call.query.get('deviceId')).toBe('device-injected');
    expect(call.headers['X-Sulla-Device-Signature']).toBe('injected-signature');
    expect(new TextDecoder().decode(identity.signed[0]).split('\n')).toEqual(
      ['sulla-vault-sync-v3', 'user-0001', 'device-injected', VAULT, 'enrollment-state', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '1770000000'],
    );
  });
});
