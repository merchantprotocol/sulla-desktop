// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import os from 'node:os';

import { DeviceIdentityService } from '@sulla/domain';
import { SystemClock } from '@sulla/foundation';

import { FileDeviceIdStore, type LegacyDeviceIdSource } from './FileDeviceIdStore';
import { FileDeviceKeyStore } from './FileDeviceKeyStore';
import { NodeDeviceCrypto, NodeRandomSource } from './NodeDeviceCrypto';

import paths from '@pkg/utils/paths';

export interface DesktopDeviceMetadata {
  deviceId:   string;
  deviceType: 'desktop';
  platform:   'macos' | 'windows' | 'linux';
  model:      string | null;
  hostname:   string;
  name:       string;
  osVersion:  string | null;
  appVersion: string | null;
}

/** Display metadata for /devices/register (hostname, OS label, app version). */
export class DesktopHostInfo {
  constructor(private readonly host: Pick<typeof os, 'platform' | 'release' | 'type' | 'hostname'> = os, private readonly appVersion: () => Promise<string | null> | string | null = () => null) {}

  platform(): DesktopDeviceMetadata['platform'] {
    const p = this.host.platform();
    if (p === 'darwin') return 'macos';
    if (p === 'win32') return 'windows';

    return 'linux';
  }

  model(): string {
    const platform = this.platform();
    if (platform === 'macos') return 'Mac';
    if (platform === 'windows') return 'PC';

    return 'Linux box';
  }

  osVersion(): string {
    const platform = this.platform();
    const release = this.host.release();
    if (platform === 'macos') return `macOS ${ release }`;
    if (platform === 'windows') return `Windows ${ release }`;

    return `${ this.host.type() } ${ release }`;
  }

  async metadata(deviceId: string): Promise<DesktopDeviceMetadata> {
    const hostname = this.host.hostname();
    let appVersion: string | null = null;
    try { appVersion = (await this.appVersion()) ?? null } catch { /* unknown version */ }

    return {
      deviceId,
      deviceType: 'desktop',
      platform:   this.platform(),
      model:      this.model(),
      hostname,
      name:       hostname || this.model() || 'Sulla Desktop',
      osVersion:  this.osVersion(),
      appVersion,
    };
  }
}

/** The id used to live in SullaSettings (Electron userData); loaded lazily so the key path stays DB-free. */
export class SettingsLegacyDeviceIdSource implements LegacyDeviceIdSource {
  static readonly KEY = 'sullaCloudDeviceId';

  async read(): Promise<string | null> {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    const existing = (await SullaSettingsModel.get(SettingsLegacyDeviceIdSource.KEY, '')) as string;

    return existing || null;
  }
}

/**
 * Composition root for this install's device identity. The identity itself is the shared domain
 * `DeviceIdentityService` (@sulla/domain); this class only wires the Desktop adapters into it (files in ~/.sulla,
 * node:crypto, the CSPRNG, the system clock) and adds the Desktop-only bits (register metadata, a sync id peek).
 * One instance per process, created on first use.
 */
export class DesktopDeviceIdentity {
  private static shared: DesktopDeviceIdentity | null = null;

  constructor(readonly service: DeviceIdentityService, private readonly ids: FileDeviceIdStore, private readonly host: DesktopHostInfo) {}

  static forDirectory(directory: () => string, appVersion: () => Promise<string | null> | string | null, legacy: LegacyDeviceIdSource | null): DesktopDeviceIdentity {
    const clock = new SystemClock();
    const ids = FileDeviceIdStore.in(directory, legacy);

    return new DesktopDeviceIdentity(
      new DeviceIdentityService(ids, FileDeviceKeyStore.in(directory, clock), new NodeDeviceCrypto(), new NodeRandomSource(), clock),
      ids,
      new DesktopHostInfo(os, appVersion),
    );
  }

  /** The process-wide instance (lazy). */
  static current(): DesktopDeviceIdentity {
    DesktopDeviceIdentity.shared ??= DesktopDeviceIdentity.forDirectory(
      () => paths.sullaConfig,
      async() => (await import('@pkg/utils/version')).getProductionVersion(),
      new SettingsLegacyDeviceIdSource(),
    );

    return DesktopDeviceIdentity.shared;
  }

  /** Test seam: swap the process-wide instance (null = rebuild from paths on next use). */
  static useInstance(instance: DesktopDeviceIdentity | null): void {
    DesktopDeviceIdentity.shared = instance;
  }

  async metadata(): Promise<DesktopDeviceMetadata> {
    return this.host.metadata((await this.service.deviceId()).value);
  }

  /** The device id if this install already has one; never creates one or touches the database. */
  readExistingDeviceId(): string | null {
    return this.ids.readExisting();
  }
}

/**
 * THE accessor for this install's device identity: one process-wide domain `DeviceIdentityService`.
 * Device id, signing key, purpose-bound signatures, the /devices/register key-rotation proof and
 * `signerFor(purpose)` (vault enrollment) all come from here.
 */
export function desktopDeviceIdentity(): DeviceIdentityService {
  return DesktopDeviceIdentity.current().service;
}
