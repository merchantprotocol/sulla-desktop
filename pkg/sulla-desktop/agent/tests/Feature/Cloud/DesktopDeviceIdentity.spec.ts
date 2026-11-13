// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * D-ID-2: Desktop's device identity is the shared @sulla/domain DeviceIdentityService over Desktop file adapters.
 * Real classes, real files in a temp dir, real node:crypto. Only the settings database (legacy id) is faked.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceIdentityError, DeviceKeyRotationProof, DeviceMessage, DeviceIdentityService, type DevicePurpose } from '@sulla/domain';

import { DesktopDeviceIdentity } from '../../../../main/cloud/device/DesktopDeviceIdentity';
import { FileDeviceIdStore } from '../../../../main/cloud/device/FileDeviceIdStore';
import { FileDeviceKeyStore } from '../../../../main/cloud/device/FileDeviceKeyStore';
import { NodeDeviceCrypto, NodeRandomSource } from '../../../../main/cloud/device/NodeDeviceCrypto';

/**
 * The device key code on origin/main before D-ID-2 (main/cloud/deviceKey.ts), copied as the parity reference:
 * key file creation and both signers, with `Date.now` read the same way.
 */
class OldMainDeviceKey {
  constructor(private readonly file: string) {}

  /** Old first-run key creation: generateKeyPairSync + v1 JSON with a PKCS#8 PEM. */
  create(): void {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      v: 1, publicKey: OldMainDeviceKey.rawPublicKeyB64(publicKey), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
  }

  static rawPublicKeyB64(pub: crypto.KeyObject): string {
    const jwk = pub.export({ format: 'jwk' }) as { x?: string };

    return Buffer.from(jwk.x as string, 'base64url').toString('base64');
  }

  private key(): crypto.KeyObject {
    return crypto.createPrivateKey(JSON.parse(fs.readFileSync(this.file, 'utf-8')).privateKey);
  }

  publicKey(): string { return OldMainDeviceKey.rawPublicKeyB64(crypto.createPublicKey(this.key())) }

  signDeviceMessageExact(purpose: DevicePurpose, parts: (string | number)[]): string {
    return crypto.sign(null, Buffer.from(new DeviceMessage(purpose, parts).toBytes()), this.key()).toString('base64');
  }

  signDeviceMessage(purpose: DevicePurpose, parts: (string | number)[]): { ts: number; signature: string } {
    const ts = Math.floor(Date.now() / 1000);

    return { ts, signature: crypto.sign(null, Buffer.from(new DeviceMessage(purpose, [...parts, ts]).toBytes()), this.key()).toString('base64') };
  }
}

class FixedClock {
  constructor(private readonly at: Date) {}
  now(): Date { return new Date(this.at) }
}

const ALL_PURPOSES = Object.keys(DeviceMessage.PURPOSE_TAGS) as DevicePurpose[];
const NOW = new Date('2026-11-12T20:00:00.123Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const DEVICE_SOURCE_FILES = ['main/cloud/device', 'main/cloud/deviceKey.ts', 'main/deviceIdentity.ts'];

let dir = '';

function identity(legacy: { read(): Promise<string | null> } | null = null, clock = new FixedClock(NOW), random = new NodeRandomSource()): DeviceIdentityService {
  const ids = FileDeviceIdStore.in(() => dir, legacy);

  return new DeviceIdentityService(ids, FileDeviceKeyStore.in(() => dir, clock), new NodeDeviceCrypto(), random, clock);
}

const idFile = () => path.join(dir, 'device-id');
const keyFile = () => path.join(dir, 'device-key.json');
const mode = (target: string) => fs.statSync(target).mode & 0o777;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-did2-')), 'sulla');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('Desktop device identity on the domain DeviceIdentityService', () => {
  it('creates the id and key once, in a 0700 directory with 0600 files', async() => {
    // risk: a world-readable device key lets another local user impersonate this computer to Cloud.
    const service = identity();
    const id = await service.deviceId();
    const publicKey = await service.publicKey();

    expect(id.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(fs.readFileSync(idFile(), 'utf-8')).toBe(id.value);
    expect(JSON.parse(fs.readFileSync(keyFile(), 'utf-8')).publicKey).toBe(publicKey);
    if (process.platform !== 'win32') {
      expect(mode(dir)).toBe(0o700);
      expect(mode(idFile())).toBe(0o600);
      expect(mode(keyFile())).toBe(0o600);
    }
    // A second process-start reads the same identity back instead of minting a new one.
    const again = identity();
    expect((await again.deviceId()).value).toBe(id.value);
    expect(await again.publicKey()).toBe(publicKey);
    expect(fs.readdirSync(dir).sort()).toEqual(['device-id', 'device-key.json']);
  });

  it('keeps one id and one key when two instances race to create them', async() => {
    // risk: two ids/keys for one machine = a duplicate device and a key Cloud later refuses (device_key_mismatch).
    const services = Array.from({ length: 6 }, () => identity());
    const ids = await Promise.all(services.map(service => service.deviceId()));
    const keys = await Promise.all(services.map(service => service.publicKey()));

    expect(new Set(ids.map(id => id.value)).size).toBe(1);
    expect(new Set(keys).size).toBe(1);
    expect(fs.readFileSync(idFile(), 'utf-8')).toBe(ids[0].value);
    expect(JSON.parse(fs.readFileSync(keyFile(), 'utf-8')).publicKey).toBe(keys[0]);
  });

  it('createIfAbsent never overwrites a stored id or key', async() => {
    // risk: silently replacing an enrolled key orphans the device in Cloud.
    const ids = FileDeviceIdStore.in(() => dir);
    const keys = FileDeviceKeyStore.in(() => dir, new FixedClock(NOW));
    expect(await ids.createIfAbsent('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(await ids.createIfAbsent('22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(await ids.read()).toBe('11111111-1111-4111-8111-111111111111');

    const first = new Uint8Array(32).fill(7);
    expect(await keys.createIfAbsent(first)).toBe(true);
    expect(await keys.createIfAbsent(new Uint8Array(32).fill(9))).toBe(false);
    expect(Buffer.from((await keys.read()) as Uint8Array)).toEqual(Buffer.from(first));
  });

  it('fails closed on a corrupt id file and leaves it untouched', async() => {
    // risk: regenerating on corruption mints a second device for the same machine.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(idFile(), 'not a valid id!');

    await expect(identity().deviceId()).rejects.toMatchObject({ deviceCode: 'store_corrupt' });
    await expect(identity().deviceId()).rejects.toBeInstanceOf(DeviceIdentityError);
    expect(fs.readFileSync(idFile(), 'utf-8')).toBe('not a valid id!');
  });

  it('fails closed on a corrupt or foreign key file and leaves it untouched', async() => {
    // risk: replacing an unreadable key silently changes this computer's identity.
    fs.mkdirSync(dir, { recursive: true });
    for (const content of ['{not json', JSON.stringify({ v: 1, publicKey: 'x', privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' }),
      JSON.stringify({ v: 1, publicKey: 'x', privateKey: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }), '']) {
      fs.writeFileSync(keyFile(), content);
      // The port contract: a present-but-corrupt store throws; it never reads as "absent".
      await expect(FileDeviceKeyStore.in(() => dir, new FixedClock(NOW)).read(), content.slice(0, 20)).rejects.toThrow();
      await expect(identity().publicKey(), content.slice(0, 20)).rejects.toBeInstanceOf(DeviceIdentityError);
      expect(fs.readFileSync(keyFile(), 'utf-8')).toBe(content);
    }
  });

  it('throws on an unreadable id file instead of treating it as missing', async() => {
    // risk: a permissions glitch must not mint a new id.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(idFile(), '11111111-1111-4111-8111-111111111111');
    fs.chmodSync(idFile(), 0o000);
    await expect(identity().deviceId()).rejects.toMatchObject({ deviceCode: 'store_unavailable' });
    fs.chmodSync(idFile(), 0o600);
  });

  it('fills an empty id file left by an interrupted write', async() => {
    // risk: an empty file must not brick identity forever (old code treated it as missing too).
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(idFile(), '');
    const id = await identity().deviceId();
    expect(fs.readFileSync(idFile(), 'utf-8')).toBe(id.value);
  });

  it('migrates a legacy SullaSettings id into ~/.sulla/device-id', async() => {
    // risk: older installs would show up as a new duplicate desktop in Cloud.
    const legacyId = 'abcdef01-2345-4678-9abc-def012345678';
    const id = await identity({ read: async() => legacyId }).deviceId();
    expect(id.value).toBe(legacyId);
    expect(fs.readFileSync(idFile(), 'utf-8')).toBe(legacyId);
  });

  it('readExistingDeviceId never creates an id', () => {
    // risk: the runtime backend peeks at the id at boot; it must not create one or touch the database.
    const desktop = DesktopDeviceIdentity.forDirectory(() => dir, () => '1.0.0', { read: async() => { throw new Error('database must not be read') } });
    expect(desktop.readExistingDeviceId()).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('never uses Math.random to mint an id or key', async() => {
    // risk: a predictable device id/key (the old generateDeviceId had a Math.random fallback).
    const spy = vi.spyOn(Math, 'random');
    const service = identity();
    await service.deviceId();
    await service.publicKey();
    expect(spy).not.toHaveBeenCalled();
  });

  it('has no Math.random anywhere in the device identity sources', () => {
    // risk: someone re-adds a non-CSPRNG fallback.
    const root = path.resolve(__dirname, '../../../..');
    const files = DEVICE_SOURCE_FILES.flatMap((entry) => {
      const full = path.join(root, entry);

      return fs.statSync(full).isDirectory() ? fs.readdirSync(full).map(name => path.join(full, name)) : [full];
    });
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) expect(fs.readFileSync(file, 'utf-8'), file).not.toMatch(/Math\.random/);
  });

  it('fails instead of minting when the random source is broken', async() => {
    // risk: a constant or failing RNG must never produce an id or key.
    const broken = new NodeRandomSource({ randomBytes: ((n: number) => Buffer.alloc(n)) as any });
    await expect(identity(null, new FixedClock(NOW), broken).deviceId()).rejects.toMatchObject({ deviceCode: 'random_unavailable' });
    expect(fs.existsSync(idFile())).toBe(false);
  });
});

describe('existing installs keep their exact key (PEM written by origin/main code)', () => {
  it('reads the old PKCS#8 PEM to the same key and leaves the file byte-identical', async() => {
    // risk: an upgrade that changes the key orphans every existing desktop (Cloud answers device_key_mismatch).
    const old = new OldMainDeviceKey(keyFile());
    old.create();
    const before = fs.readFileSync(keyFile(), 'utf-8');

    const service = identity();
    expect(await service.publicKey()).toBe(old.publicKey());
    for (const purpose of ALL_PURPOSES) {
      expect(await service.signExact(purpose, ['u', 'd', 7]), purpose).toBe(old.signDeviceMessageExact(purpose, ['u', 'd', 7]));
    }
    expect(fs.readFileSync(keyFile(), 'utf-8')).toBe(before);
  });

  it('round-trips PEM <-> seed exactly', () => {
    // risk: the adapter's conversion must be lossless in both directions.
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const seed = NodeDeviceCrypto.seedFromPem(pem);
    expect(seed.length).toBe(32);
    expect(NodeDeviceCrypto.pemFromSeed(seed)).toBe(pem);
  });

  it('derives the RFC 8032 test-vector public key from its seed', () => {
    // risk: the node:crypto adapter must be real Ed25519 (known answer, independent of our code).
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
    expect(Buffer.from(new NodeDeviceCrypto().ed25519PublicKey(seed)).toString('hex')).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  });
});

describe('signature known-answer parity with the old deviceKey.ts', () => {
  it('signs every purpose byte-for-byte like the old signDeviceMessage / signDeviceMessageExact, ts in seconds', async() => {
    // risk: Cloud rejects every device signature if one byte or the ts unit changes.
    const seed = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
    const service = identity(null, new FixedClock(NOW), { bytes: () => seed });
    const old = new OldMainDeviceKey(keyFile());
    await service.publicKey(); // writes the key file from the fixed seed
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });

    const parts = ['user-1', 'device-1', 'vault-1', 'push', 'ab'.repeat(32)];
    for (const purpose of ALL_PURPOSES) {
      const fresh = await service.sign(purpose, parts);
      const reference = old.signDeviceMessage(purpose, parts);
      expect(fresh.ts, purpose).toBe(NOW_SECONDS);
      expect(fresh, purpose).toEqual(reference);
      expect(await service.signExact(purpose, [...parts, 99]), purpose).toBe(old.signDeviceMessageExact(purpose, [...parts, 99]));
    }
  });

  it('builds a /devices/register key-rotation proof Cloud verifies against the enrolled key', async() => {
    // risk: an invalid proof leaves every key rotation refused.
    const service = identity();
    const [id, publicKey] = [(await service.deviceId()).value, await service.publicKey()];
    const proof = await service.keyRotationProof('user-1');
    const verifier = new DeviceKeyRotationProof(new NodeDeviceCrypto());
    expect(proof.ts).toBe(NOW_SECONDS);
    expect(verifier.verify(publicKey, 'user-1', id, null, proof, NOW_SECONDS)).toBe(true);
    expect(verifier.verify(publicKey, 'user-2', id, null, proof, NOW_SECONDS)).toBe(false);
  });
});
