// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** IPC for Settings → Account → Devices. Human-driven only. */

import { getDesktopDeviceId } from '../../deviceIdentity';
import { cloudRequest } from '../cloudFetch';
import { DevicesPanelErrorMapper, DevicesRequestFailure, type DevicesPanelFailure } from './devicesPanelErrorMapper';
import { DevicesPanelService, type CloudDeviceView, type CloudDevicesList, type DevicesHttp } from './DevicesPanelService';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

export type DevicesPanelResult<T> = { ok: true; value: T } | DevicesPanelFailure;

/** `DevicesHttp` over the existing authenticated Cloud request path. */
export class CloudRequestDevicesHttp implements DevicesHttp {
  async send(method: 'GET' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: any }> {
    let response: Response;
    try {
      response = await cloudRequest(method, path, body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) {
      throw new DevicesRequestFailure(`${ method } ${ path }`, error);
    }

    return { status: response.status, data: await response.json().catch(() => null) };
  }
}

export class DevicesPanelIpc {
  constructor(
    private readonly service: DevicesPanelService,
    private readonly mapper: DevicesPanelErrorMapper = new DevicesPanelErrorMapper(),
  ) {}

  register(): void {
    const ipc = getIpcMainProxy(Logging.background);

    ipc.handle('sulla-cloud-devices:list', async() => this.run<CloudDevicesList>(() => this.service.list()));
    ipc.handle('sulla-cloud-devices:rename', async(_e: unknown, id: string, name: string) => this.run<CloudDeviceView>(() => this.service.rename(id, name)));
    ipc.handle('sulla-cloud-devices:remove', async(_e: unknown, id: string) => this.run<CloudDevicesList>(() => this.service.remove(id)));
  }

  private async run<T>(action: () => Promise<T>): Promise<DevicesPanelResult<T>> {
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      return this.mapper.map(error);
    }
  }
}

export function initDevicesPanelEvents(): void {
  new DevicesPanelIpc(new DevicesPanelService(new CloudRequestDevicesHttp(), { get: getDesktopDeviceId })).register();
}
