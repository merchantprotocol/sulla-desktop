// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Settings → Account → Devices: list, rename and remove the signed-in user's
 * Cloud devices through the existing `/devices` API.
 *
 * Rules that live here (not in the panel):
 * - This computer can be renamed but never removed from this panel.
 * - A delete is only ever sent for an id that was in the last list.
 * - Cloud answers `DELETE /devices/:id` with 200 even when it ignored the id
 *   (another account's device, an unknown id), so every removal is confirmed by
 *   listing again. A device that is still there is a failed removal.
 */

export const DEVICE_NAME_MAX_LENGTH = 120;

/** The HTTP edge. Production wraps `cloudRequest`; tests fake it. */
export interface DevicesHttp {
  send(method: 'GET' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: any }>;
}

/** Where this computer's Cloud device id comes from (`getDesktopDeviceId`). */
export interface ThisDeviceIdSource {
  get(): Promise<string>;
}

export interface CloudDeviceView {
  id:             string;
  name:           string;
  deviceType:     string;
  platform:       string;
  model:          string | null;
  osVersion:      string | null;
  appVersion:     string | null;
  lastSeenAt:     string | null;
  online:         boolean;
  keyFingerprint: string | null;
  isThisDevice:   boolean;
}

export interface CloudDevicesList {
  thisDeviceId: string;
  devices:      CloudDeviceView[];
}

export type DevicesPanelErrorCode =
  | 'this_device'
  | 'unknown_device'
  | 'invalid_name'
  | 'not_removed'
  | 'cloud_error';

export class DevicesPanelError extends Error {
  constructor(readonly code: DevicesPanelErrorCode, message: string) {
    super(message);
    this.name = 'DevicesPanelError';
  }
}

export class DevicesPanelService {
  private lastListed = new Map<string, CloudDeviceView>();

  constructor(
    private readonly http: DevicesHttp,
    private readonly thisDevice: ThisDeviceIdSource,
  ) {}

  async list(): Promise<CloudDevicesList> {
    const thisDeviceId = await this.thisDevice.get();
    const res = await this.http.send('GET', '/devices');
    this.assertOk(res, 'Couldn\'t load your devices from Sulla Cloud.');
    const rows: any[] = Array.isArray(res.data?.devices) ? res.data.devices : [];
    const devices = rows
      .filter(row => typeof row?.id === 'string' && row.id && row.deviceType !== 'app' && !row.revokedAt)
      .map(row => this.toView(row, thisDeviceId))
      .sort((a, b) => Number(b.isThisDevice) - Number(a.isThisDevice));

    this.lastListed = new Map(devices.map(device => [device.id, device]));

    return { thisDeviceId, devices };
  }

  async rename(id: string, rawName: string): Promise<CloudDeviceView> {
    this.requireListed(id);
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw new DevicesPanelError('invalid_name', 'Type a name for the device.');
    if (name.length > DEVICE_NAME_MAX_LENGTH) {
      throw new DevicesPanelError('invalid_name', `Device names can be up to ${ DEVICE_NAME_MAX_LENGTH } characters.`);
    }
    const res = await this.http.send('PATCH', `/devices/${ encodeURIComponent(id) }`, { name });
    this.assertOk(res, 'Sulla Cloud didn\'t save the new name.');
    const view = this.toView(res.data?.device ?? { ...this.lastListed.get(id), name }, await this.thisDevice.get());
    this.lastListed.set(id, view);

    return view;
  }

  async remove(id: string): Promise<CloudDevicesList> {
    const device = this.requireListed(id);
    if (device.isThisDevice || id === await this.thisDevice.get()) {
      throw new DevicesPanelError('this_device', 'This computer can\'t be removed from here. Sign out instead.');
    }
    const res = await this.http.send('DELETE', `/devices/${ encodeURIComponent(id) }`);
    this.assertOk(res, 'Sulla Cloud didn\'t remove the device.');
    const after = await this.list();
    if (after.devices.some(row => row.id === id)) {
      throw new DevicesPanelError('not_removed', `Sulla Cloud didn't remove "${ device.name }". It may belong to another account. Refresh and try again.`);
    }

    return after;
  }

  private requireListed(id: string): CloudDeviceView {
    const device = typeof id === 'string' ? this.lastListed.get(id) : undefined;
    if (!device) throw new DevicesPanelError('unknown_device', 'That device isn\'t in your list any more. Refresh and try again.');

    return device;
  }

  private assertOk(res: { status: number; data: any }, message: string): void {
    if (res.status >= 200 && res.status < 300) return;
    const detail = typeof res.data?.error === 'string' ? ` (${ res.data.error })` : '';
    throw new DevicesPanelError('cloud_error', `${ message }${ detail }`);
  }

  private toView(row: any, thisDeviceId: string): CloudDeviceView {
    const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

    return {
      id:             row.id,
      name:           text(row.name) ?? text(row.hostname) ?? text(row.model) ?? 'Unnamed device',
      deviceType:     text(row.deviceType) ?? 'desktop',
      platform:       text(row.platform) ?? 'unknown',
      model:          text(row.model),
      osVersion:      text(row.osVersion),
      appVersion:     text(row.appVersion),
      lastSeenAt:     text(row.lastSeenAt),
      online:         row.online === true,
      keyFingerprint: text(row.keyFingerprint),
      isThisDevice:   row.id === thisDeviceId,
    };
  }
}
