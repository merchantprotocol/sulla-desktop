// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DevicesPanelError, DevicesPanelService, type DevicesHttp } from '@pkg/main/cloud/devices/DevicesPanelService';

const THIS_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const PHONE_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const OLD_MAC_ID = 'cccccccc-0000-4000-8000-000000000003';

/**
 * Fake of the Cloud `/devices` API at the HTTP edge. It behaves like
 * sulla-workers main: DELETE answers 200 even for ids it ignores.
 */
class FakeCloudDevices implements DevicesHttp {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  /** Ids that belong to another account: DELETE silently does nothing. */
  readonly foreign = new Set<string>();
  rows: Array<Record<string, any>>;

  constructor(rows: Array<Record<string, any>>) { this.rows = rows }

  async send(method: 'GET' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: any }> {
    this.calls.push({ method, path, body });
    const id = decodeURIComponent(path.split('/')[2] ?? '');
    if (method === 'GET') return { status: 200, data: { devices: this.rows.map(row => ({ ...row })) } };
    if (method === 'PATCH') {
      const row = this.rows.find(r => r.id === id);
      if (!row) return { status: 404, data: { error: 'not found' } };
      row.name = (body as any).name;

      return { status: 200, data: { device: { ...row } } };
    }
    if (!this.foreign.has(id)) this.rows = this.rows.filter(r => r.id !== id);

    return { status: 200, data: { ok: true } };
  }

  deletes(): string[] { return this.calls.filter(c => c.method === 'DELETE').map(c => c.path) }
}

function cloudRows(): Array<Record<string, any>> {
  return [
    { id: PHONE_ID, deviceType: 'mobile', platform: 'ios', model: 'iPhone', hostname: null, name: 'Jo’s iPhone', osVersion: '19.1', appVersion: '2.4.0', lastSeenAt: '2026-11-12T12:00:00Z', online: true, keyFingerprint: 'abcd-ef01-2345-6789', revokedAt: null },
    { id: THIS_ID, deviceType: 'desktop', platform: 'macos', model: 'Mac', hostname: 'studio.local', name: null, osVersion: '15.2', appVersion: '1.7.0', lastSeenAt: '2026-11-12T12:01:00Z', online: true, keyFingerprint: '1111-2222-3333-4444', revokedAt: null },
    { id: OLD_MAC_ID, deviceType: 'desktop', platform: 'macos', model: 'Mac', hostname: 'old-mac', name: 'Old Mac', osVersion: '14.0', appVersion: '1.2.0', lastSeenAt: '2026-10-01T09:00:00Z', online: false, keyFingerprint: null, revokedAt: null },
    { id: 'app-1', deviceType: 'app', platform: 'web', name: 'Some MCP app', online: true },
  ];
}

function service(cloud: FakeCloudDevices): DevicesPanelService {
  return new DevicesPanelService(cloud, { get: async() => THIS_ID });
}

async function refusal(promise: Promise<unknown>): Promise<DevicesPanelError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DevicesPanelError);

  return error as DevicesPanelError;
}

describe('DevicesPanelService', () => {
  it('lists the account’s devices with this computer marked and first, and leaves out Cloud apps', async() => {
    // risk: data accuracy (wrong device marked as this computer)
    const cloud = new FakeCloudDevices(cloudRows());
    const { thisDeviceId, devices } = await service(cloud).list();

    expect(thisDeviceId).toBe(THIS_ID);
    expect(devices.map(d => d.id)).toEqual([THIS_ID, PHONE_ID, OLD_MAC_ID]);
    expect(devices.filter(d => d.isThisDevice).map(d => d.id)).toEqual([THIS_ID]);
    expect(devices[0]).toMatchObject({ name: 'studio.local', platform: 'macos', online: true, keyFingerprint: '1111-2222-3333-4444', appVersion: '1.7.0' });
    expect(devices[2]).toMatchObject({ name: 'Old Mac', online: false, keyFingerprint: null, lastSeenAt: '2026-10-01T09:00:00Z' });
  });

  it('renames with the name trimmed and refuses empty or over-long names without calling Cloud', async() => {
    // risk: data accuracy (stored device names)
    const cloud = new FakeCloudDevices(cloudRows());
    const panel = service(cloud);
    await panel.list();

    const renamed = await panel.rename(THIS_ID, '   Studio Mac  ');
    expect(cloud.calls.at(-1)).toEqual({ method: 'PATCH', path: `/devices/${ THIS_ID }`, body: { name: 'Studio Mac' } });
    expect(renamed).toMatchObject({ id: THIS_ID, name: 'Studio Mac', isThisDevice: true });

    const patchesBefore = cloud.calls.filter(c => c.method === 'PATCH').length;
    expect((await refusal(panel.rename(PHONE_ID, '    '))).code).toBe('invalid_name');
    expect((await refusal(panel.rename(PHONE_ID, 'x'.repeat(121)))).code).toBe('invalid_name');
    expect(cloud.calls.filter(c => c.method === 'PATCH').length).toBe(patchesBefore);

    await panel.rename(PHONE_ID, `  ${ 'y'.repeat(120) }  `);
    expect((cloud.calls.at(-1)?.body as any).name).toHaveLength(120);
  });

  it('never removes this computer, and never sends the delete', async() => {
    // risk: irreversible side effect (this computer revoked from its own settings)
    const cloud = new FakeCloudDevices(cloudRows());
    const panel = service(cloud);
    await panel.list();

    expect((await refusal(panel.remove(THIS_ID))).code).toBe('this_device');
    expect(cloud.deletes()).toEqual([]);
    expect(cloud.rows.some(r => r.id === THIS_ID)).toBe(true);
  });

  it('removes another device and confirms it is gone by listing again', async() => {
    // risk: irreversible side effect (device revoked)
    const cloud = new FakeCloudDevices(cloudRows());
    const panel = service(cloud);
    await panel.list();

    const after = await panel.remove(OLD_MAC_ID);
    expect(cloud.deletes()).toEqual([`/devices/${ OLD_MAC_ID }`]);
    expect(cloud.calls.at(-1)?.method).toBe('GET');
    expect(after.devices.map(d => d.id)).toEqual([THIS_ID, PHONE_ID]);
  });

  it('reports a failure when Cloud answers 200 but the device is still there', async() => {
    // risk: data accuracy (UI claims a device was removed when it wasn't)
    const cloud = new FakeCloudDevices(cloudRows());
    cloud.foreign.add(PHONE_ID);
    const panel = service(cloud);
    await panel.list();

    const error = await refusal(panel.remove(PHONE_ID));
    expect(error.code).toBe('not_removed');
    expect(cloud.rows.some(r => r.id === PHONE_ID)).toBe(true);
  });

  it('refuses ids that were not in the last list (including before any list), and never sends the delete', async() => {
    // risk: tenant isolation (deleting an arbitrary or another account's device id)
    const cloud = new FakeCloudDevices(cloudRows());
    const panel = service(cloud);

    expect((await refusal(panel.remove(OLD_MAC_ID))).code).toBe('unknown_device');
    await panel.list();
    expect((await refusal(panel.remove('dddddddd-0000-4000-8000-00000000ffff'))).code).toBe('unknown_device');
    expect((await refusal(panel.remove('app-1'))).code).toBe('unknown_device');
    expect((await refusal(panel.rename('dddddddd-0000-4000-8000-00000000ffff', 'Mine now'))).code).toBe('unknown_device');
    expect(cloud.deletes()).toEqual([]);
    expect(cloud.calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('turns a Cloud error into a panel error instead of an empty list', async() => {
    // risk: data accuracy (an outage shown as "no devices")
    const cloud = new FakeCloudDevices(cloudRows());
    cloud.send = async() => ({ status: 503, data: { error: 'unavailable' } });

    expect((await refusal(service(cloud).list())).code).toBe('cloud_error');
  });
});
