// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// The interim stores (until M4's adapters land) put today's ~/.sulla device id and device-key.json under
// the domain DeviceIdentityService. Signatures must be byte-identical to deviceKey.ts signDeviceMessage, and
// the stores must never replace an existing file. Synthetic key only.

import fs from 'node:fs';
import path from 'node:path';

import { DeviceIdentityService, NobleCryptoPrimitives, WebCryptoRandomSource } from '@sulla/domain';
import { SystemClock } from '@sulla/foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedDeviceKeyDir } from '../../Support/Vault/EnrollmentFakes';

const env = vi.hoisted(() => ({ deviceDir: '' }));
vi.mock('@pkg/utils/paths', () => ({ default: { get sullaConfig() { return env.deviceDir } } }));

import { _resetDeviceKeyCache, getDevicePublicKey, signDeviceMessage } from '../../../../main/cloud/deviceKey';
import { InterimDeviceIdStore, InterimDeviceKeyStore } from '../../../../main/cloud/enrollment/InterimDeviceIdentityStores';

let keyDir: FixedDeviceKeyDir;

function identity(): DeviceIdentityService {
  return new DeviceIdentityService(
    new InterimDeviceIdStore(async() => 'device-0001', () => path.join(keyDir.dir, 'device-id')),
    new InterimDeviceKeyStore(() => getDevicePublicKey(), () => path.join(keyDir.dir, 'device-key.json')),
    new NobleCryptoPrimitives(), WebCryptoRandomSource.fromGlobal(), new SystemClock(),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_770_000_000_123, toFake: ['Date'] });
  keyDir = new FixedDeviceKeyDir();
  env.deviceDir = keyDir.dir;
  _resetDeviceKeyCache();
});

afterEach(() => {
  vi.useRealTimers();
  keyDir.remove();
});

describe('interim device identity stores under the domain DeviceIdentityService', () => {
  it('signs exactly what deviceKey.ts signDeviceMessage signs, in seconds, for the same key and clock', async() => {
    // risk: Cloud rejects vault-sync signatures if the two signers drift
    const parts = ['user-0001', 'device-0001', '11111111-2222-4333-8444-555555555555', 'enrollment-state', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'];
    const domain = await identity().sign('vault-sync-v3', parts);
    expect(domain).toEqual(signDeviceMessage('vault-sync-v3', parts));
    expect(domain.ts).toBe(1_770_000_000);
    expect(domain.signature).toBe('WRchWhF7272esCSp70CmnaSV6h1iMWabCwZi9BQe7s9jlc/G8QKR4KgfVLZaK6S9cVvtYUpbMBNF6rU//xtJAA==');
  });

  it('reads the stored key and device id rather than minting new ones', async() => {
    const service = identity();
    expect(await service.publicKey()).toBe(FixedDeviceKeyDir.PUBLIC_KEY_B64);
    expect((await service.deviceId()).value).toBe('device-0001');
    expect(fs.existsSync(path.join(keyDir.dir, 'device-id'))).toBe(false);
  });

  it('never overwrites an existing key file', async() => {
    // risk: replacing the device key orphans this computer from Cloud
    const file = path.join(keyDir.dir, 'device-key.json');
    const before = fs.readFileSync(file, 'utf8');
    const store = new InterimDeviceKeyStore(() => undefined, () => file);
    await expect(store.createIfAbsent(new Uint8Array(32).fill(9))).resolves.toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('creates a key file in today\'s v1 format when none exists, readable by deviceKey.ts', async() => {
    const file = path.join(keyDir.dir, 'device-key.json');
    fs.rmSync(file);
    const store = new InterimDeviceKeyStore(() => undefined, () => file);
    await expect(store.read()).resolves.toBeNull();
    await expect(store.createIfAbsent(new Uint8Array(FixedDeviceKeyDir.SEED))).resolves.toBe(true);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(getDevicePublicKey()).toBe(FixedDeviceKeyDir.PUBLIC_KEY_B64);
    await expect(store.read()).resolves.toEqual(new Uint8Array(FixedDeviceKeyDir.SEED));
  });

  it('fails closed on a corrupt key file instead of minting a new key', async() => {
    const file = path.join(keyDir.dir, 'device-key.json');
    fs.writeFileSync(file, '{"v":2}');
    const store = new InterimDeviceKeyStore(() => undefined, () => file);
    await expect(store.read()).rejects.toThrow();
  });
});
