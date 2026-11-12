// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * D-ID-2: /devices/register carries the key-rotation proof from the domain DeviceIdentityService;
 * Cloud's device_key_mismatch puts this computer in a re-link state; re-link removes the row and
 * registers again; a revoked or key-refused device stops the relay channel, vault and files sync.
 * Real DeviceCloudService, real DeviceIdentityService over temp files; only the HTTP edge is faked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceIdentityService, DeviceKeyRotationProof } from '@sulla/domain';

vi.mock('@pkg/main/cloud/cloudFetch', () => ({ cloudRequest: vi.fn(), isCloudSignedIn: vi.fn() }));
vi.mock('../../../../main/cloud/cloudSettings', () => ({ getCloudPreferences: vi.fn() }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { log: () => undefined, warn: () => undefined } } }));

import { DeviceSyncGate, type DeviceBoundService } from '../../../../main/cloud/device/DeviceSyncGate';
import { FileDeviceIdStore } from '../../../../main/cloud/device/FileDeviceIdStore';
import { FileDeviceKeyStore } from '../../../../main/cloud/device/FileDeviceKeyStore';
import { NodeDeviceCrypto, NodeRandomSource } from '../../../../main/cloud/device/NodeDeviceCrypto';
import { DeviceCloudService, type CloudDeviceState } from '../../../../main/devicesCloudApi';

const NOW = new Date('2026-11-12T20:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const clock = { now: () => new Date(NOW) };

interface SentRequest { method: string; path: string; body: any }

/** The Cloud HTTP edge: records requests and answers from a per-path script. */
class FakeCloud {
  readonly sent: SentRequest[] = [];
  constructor(private readonly answers: Record<string, Array<{ status: number; data?: any }>>) {}

  readonly request = async(method: string, requestPath: string, init: { body?: string } = {}) => {
    this.sent.push({ method, path: requestPath, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${ method } ${ requestPath.startsWith('/devices/') && method === 'DELETE' ? '/devices/:id' : requestPath }`;
    const answer = this.answers[key]?.shift() ?? { status: 500, data: { error: 'unscripted' } };

    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async() => answer.data ?? {} } as any;
  };

  registers(): any[] { return this.sent.filter(r => r.path === '/devices/register').map(r => r.body) }
}

let dir = '';
let identity: DeviceIdentityService;

function service(cloud: FakeCloud, userId = 'user-1'): DeviceCloudService {
  return new DeviceCloudService({
    cloudRequest:             cloud.request as any,
    isCloudSignedIn:          async() => true,
    getCloudPreferences:      async() => ({ remoteAccess: false } as any),
    identity,
    getCurrentUserId:         async() => userId,
    getDesktopDeviceMetadata: async() => ({ deviceId: (await identity.deviceId()).value, deviceType: 'desktop', platform: 'macos', model: 'Mac', hostname: 'h', name: 'h', osVersion: 'macOS 15', appVersion: '1.0.0' }),
    getDesktopDeviceId:       async() => (await identity.deviceId()).value,
    setInterval, clearInterval, setTimeout, clearTimeout,
    logger:                   { log: () => undefined, warn: () => undefined } as any,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-did2-reg-'));
  identity = new DeviceIdentityService(FileDeviceIdStore.in(() => dir), FileDeviceKeyStore.in(() => dir, clock), new NodeDeviceCrypto(), new NodeRandomSource(), clock);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('device registration with the domain identity', () => {
  it('sends the public key and a rotation proof Cloud verifies against that key', async() => {
    // risk: without a valid proof Cloud can never accept a key rotation for this computer.
    const cloud = new FakeCloud({ 'POST /devices/register': [{ status: 200, data: {} }] });
    const devices = service(cloud);

    expect(await devices.register()).toBe((await identity.deviceId()).value);
    const [body] = cloud.registers();
    expect(body.publicKey).toBe(await identity.publicKey());
    expect(body.proof.ts).toBe(NOW_SECONDS);
    const verifier = new DeviceKeyRotationProof(new NodeDeviceCrypto());
    expect(verifier.verify(body.publicKey, 'user-1', body.deviceId, null, body.proof, NOW_SECONDS)).toBe(true);
    expect(devices.getState()).toMatchObject({ registered: true, revoked: false });
    expect(devices.getState().relinkRequired).toBeUndefined();
  });

  it('omits the proof (but still registers) when no user id is available', async() => {
    // risk: a missing user id must not crash registration or send a proof bound to an empty user.
    const cloud = new FakeCloud({ 'POST /devices/register': [{ status: 200, data: {} }] });
    await service(cloud, '').register();
    expect(cloud.registers()[0].proof).toBeUndefined();
  });

  it('turns device_key_mismatch into a re-link state and tells listeners', async() => {
    // risk: a refused key would otherwise fail silently forever with sync dead.
    const cloud = new FakeCloud({ 'POST /devices/register': [{ status: 409, data: { error: 'device_key_mismatch' } }] });
    const devices = service(cloud);
    const seen: CloudDeviceState[] = [];
    devices.onStateChange(state => seen.push(state));

    expect(await devices.register()).toBeNull();
    expect(devices.getState()).toEqual({ registered: false, revoked: false, error: 'device_key_mismatch', relinkRequired: true });
    expect(seen.at(-1)?.relinkRequired).toBe(true);
  });

  it('does not ask for a re-link on other refusals', async() => {
    // risk: offering re-link for a device owned by another account would remove the wrong row.
    const cloud = new FakeCloud({ 'POST /devices/register': [{ status: 409, data: { error: 'device_registered_to_another_account' } }] });
    const devices = service(cloud);
    await devices.register();
    expect(devices.getState().relinkRequired).toBeUndefined();
    expect(await devices.relink()).toEqual({ ok: false, error: 'relink_not_required' });
    expect(cloud.sent.some(r => r.method === 'DELETE')).toBe(false);
  });

  it('re-links: removes this computer\'s own row, then registers again with the key it holds', async() => {
    // risk: the lost-key path must target only this device id and end registered.
    const cloud = new FakeCloud({
      'POST /devices/register': [{ status: 409, data: { error: 'device_key_mismatch' } }, { status: 200, data: {} }],
      'DELETE /devices/:id':    [{ status: 200, data: { ok: true } }],
    });
    const devices = service(cloud);
    await devices.register();

    expect(await devices.relink()).toEqual({ ok: true });
    const id = (await identity.deviceId()).value;
    expect(cloud.sent.map(r => `${ r.method } ${ r.path }`)).toEqual([
      'POST /devices/register', `DELETE /devices/${ id }`, 'POST /devices/register',
    ]);
    expect(cloud.registers()[1].publicKey).toBe(await identity.publicKey());
    expect(devices.getState()).toMatchObject({ registered: true, revoked: false });
    expect(devices.getState().relinkRequired).toBeUndefined();
  });

  it('reports a failed re-link and keeps the re-link state when Cloud still refuses', async() => {
    // risk: claiming success while Cloud still refuses the key.
    const cloud = new FakeCloud({
      'POST /devices/register': [{ status: 409, data: { error: 'device_key_mismatch' } }, { status: 409, data: { error: 'device_key_mismatch' } }],
      'DELETE /devices/:id':    [{ status: 200 }],
    });
    const devices = service(cloud);
    await devices.register();
    expect(await devices.relink()).toEqual({ ok: false, error: 'device_key_mismatch' });
    expect(devices.getState().relinkRequired).toBe(true);
  });

  it('does not register again when the removal fails', async() => {
    // risk: re-registering without the release just repeats the refusal.
    const cloud = new FakeCloud({
      'POST /devices/register': [{ status: 409, data: { error: 'device_key_mismatch' } }],
      'DELETE /devices/:id':    [{ status: 503 }],
    });
    const devices = service(cloud);
    await devices.register();
    expect(await devices.relink()).toEqual({ ok: false, error: 'remove_failed_503' });
    expect(cloud.registers()).toHaveLength(1);
  });
});

class Switch implements DeviceBoundService {
  running = false;
  readonly calls: string[] = [];
  start(): void { this.running = true; this.calls.push('start') }
  stop(): void { this.running = false; this.calls.push('stop') }
}

describe('DeviceSyncGate: revoked or key-refused devices stop the relay, vault and files sync', () => {
  function gate(prefs: { vault: boolean; files: boolean } = { vault: true, files: true }) {
    const services = { channel: new Switch(), vault: new Switch(), files: new Switch() };

    return { services, gate: new DeviceSyncGate(services, async kind => prefs[kind]) };
  }

  it('stops channel, vault sync and files sync when the device is revoked', async() => {
    // risk: a removed computer keeps pushing vault data with a revoked identity.
    const { services, gate: g } = gate();
    for (const s of Object.values(services)) s.start();
    await g.apply({ registered: true, revoked: true }, true);
    expect([services.channel.running, services.vault.running, services.files.running]).toEqual([false, false, false]);
    expect(g.allowsSync({ registered: true, revoked: true })).toBe(false);
  });

  it('stops everything while Cloud refuses the key', async() => {
    // risk: vault sync retrying forever with a key Cloud rejects.
    const { services, gate: g } = gate();
    for (const s of Object.values(services)) s.start();
    await g.apply({ registered: false, revoked: false, relinkRequired: true }, true);
    expect([services.channel.running, services.vault.running, services.files.running]).toEqual([false, false, false]);
  });

  it('restores the channel and only the sync kinds the owner enabled', async() => {
    // risk: a restore must not start a sync kind the owner turned off.
    const { services, gate: g } = gate({ vault: true, files: false });
    await g.apply({ registered: true, revoked: false }, true);
    expect([services.channel.running, services.vault.running, services.files.running]).toEqual([true, true, false]);
  });

  it('starts nothing when signed out or not registered', async() => {
    // risk: starting signed requests with no account.
    const { services, gate: g } = gate();
    await g.apply({ registered: true, revoked: false }, false);
    await g.apply({ registered: false, revoked: false }, true);
    expect(Object.values(services).flatMap(s => s.calls)).toEqual([]);
  });
});
