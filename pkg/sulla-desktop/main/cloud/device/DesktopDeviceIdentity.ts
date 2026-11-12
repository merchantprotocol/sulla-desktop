// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import os from 'node:os';

import type { DevicePurpose } from '@sulla/domain';

import type { DeviceIdentityHealth, KeyOrigin, KeyRotateProof, LegacyDeviceIdSource } from './DeviceIdentityPorts';
import { DeviceIdentityService } from './DeviceIdentityService';
import { FileDeviceIdStore } from './FileDeviceIdStore';
import { FileDeviceKeyStore } from './FileDeviceKeyStore';
import { NodeCryptoRandomSource, NodeEd25519Primitives } from './NodeDeviceCrypto';

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

  async write(id: string): Promise<void> {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    await SullaSettingsModel.set(SettingsLegacyDeviceIdSource.KEY, id, 'string');
  }
}

/**
 * This install's device identity: the only object the app uses for the Cloud device id,
 * the Ed25519 device key, signatures and the register-time key-rotate proof.
 * `main/deviceIdentity.ts` and `main/cloud/deviceKey.ts` are thin delegates to it.
 */
export class DesktopDeviceIdentity {
  constructor(private readonly service: DeviceIdentityService, private readonly host: DesktopHostInfo) {}

  /** Production wiring: files in ~/.sulla (resolved lazily), node:crypto, app settings migration. */
  static forDirectory(directory: () => string, appVersion: () => Promise<string | null> | string | null, legacyIds: LegacyDeviceIdSource | null, logger: { warn(message: string): void } = console): DesktopDeviceIdentity {
    return new DesktopDeviceIdentity(new DeviceIdentityService({
      ids:    FileDeviceIdStore.in(directory),
      keys:   FileDeviceKeyStore.in(directory),
      legacyIds,
      crypto: new NodeEd25519Primitives(),
      random: new NodeCryptoRandomSource(),
      clock:  { nowSeconds: () => Math.floor(Date.now() / 1000), nowIso: () => new Date().toISOString() },
      logger,
    }), new DesktopHostInfo(os, appVersion));
  }

  async deviceId(): Promise<string> { return this.service.loadOrCreateId() }

  readExistingDeviceId(): string | null { return this.service.readExistingId() }

  async metadata(): Promise<DesktopDeviceMetadata> { return this.host.metadata(await this.service.loadOrCreateId()) }

  publicKey(): string { return this.service.publicKey() }

  /** First 16 hex of SHA-256(base64 public key), grouped; identical to Cloud's KeyFingerprint. */
  keyFingerprint(): string {
    const hex = crypto.createHash('sha256').update(this.publicKey()).digest('hex').slice(0, 16);

    return hex.replace(/(.{4})(?!$)/g, '$1-');
  }

  keyOrigin(): KeyOrigin | null { return this.service.keyOrigin() }

  health(): DeviceIdentityHealth { return this.service.identityHealth() }

  signExact(purpose: DevicePurpose, parts: (string | number)[]): string { return this.service.signExact(purpose, parts) }

  sign(purpose: DevicePurpose, parts: (string | number)[]): KeyRotateProof { return this.service.sign(purpose, parts) }

  keyRotateProof(userId: string): Promise<KeyRotateProof> { return this.service.keyRotateProof(userId) }

  resetCache(): void { this.service.resetCache() }
}
