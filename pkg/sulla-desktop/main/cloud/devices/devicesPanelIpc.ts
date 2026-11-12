// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** IPC for Settings → Account → Devices. Human-driven only. */

import { getDesktopDeviceId } from '../../deviceIdentity';
import { cloudRequest } from '../cloudFetch';
import {
  DevicesPanelError, DevicesPanelService, type CloudDeviceView, type CloudDevicesList, type DevicesHttp, type DevicesPanelErrorCode,
} from './DevicesPanelService';

import { getIpcMainProxy } from '@pkg/main/ipcMain';

export type DevicesPanelResult<T> = { ok: true; value: T } | { ok: false; code: DevicesPanelErrorCode | 'not_signed_in'; error: string };

/** `DevicesHttp` over the existing authenticated Cloud request path. */
export class CloudRequestDevicesHttp implements DevicesHttp {
  async send(method: 'GET' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const response = await cloudRequest(method, path, body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    return { status: response.status, data: await response.json().catch(() => null) };
  }
}

export class DevicesPanelIpc {
  constructor(private readonly service: DevicesPanelService) {}

  register(): void {
    const ipc = getIpcMainProxy(console);

    ipc.handle('sulla-cloud-devices:list', async() => this.run<CloudDevicesList>(() => this.service.list()));
    ipc.handle('sulla-cloud-devices:rename', async(_e: unknown, id: string, name: string) => this.run<CloudDeviceView>(() => this.service.rename(id, name)));
    ipc.handle('sulla-cloud-devices:remove', async(_e: unknown, id: string) => this.run<CloudDevicesList>(() => this.service.remove(id)));
  }

  private async run<T>(action: () => Promise<T>): Promise<DevicesPanelResult<T>> {
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      if (error instanceof DevicesPanelError) return { ok: false, code: error.code, error: error.message };
      const message = error instanceof Error ? error.message : String(error);
      if (/not signed in|sign in to sulla cloud/i.test(message)) return { ok: false, code: 'not_signed_in', error: 'Sign in to Sulla Cloud to see your devices.' };

      return { ok: false, code: 'cloud_error', error: 'Couldn\'t reach Sulla Cloud. Check your connection and try again.' };
    }
  }
}

export function initDevicesPanelEvents(): void {
  new DevicesPanelIpc(new DevicesPanelService(new CloudRequestDevicesHttp(), { get: getDesktopDeviceId })).register();
}
