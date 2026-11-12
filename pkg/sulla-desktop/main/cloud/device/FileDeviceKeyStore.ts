// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { DeviceIdentityError, type DeviceKeyStore, type StoredDeviceKey } from './DeviceIdentityPorts';
import { NodeEd25519Primitives } from './NodeDeviceCrypto';
import { PrivateFile } from './PrivateFile';

/** The on-disk v1 format, unchanged so existing installs keep their key. */
interface DeviceKeyFileV1 {
  v:          1;
  publicKey:  string; // base64 raw 32-byte Ed25519 key
  privateKey: string; // PKCS#8 PEM
  createdAt:  string;
}

/** `~/.sulla/device-key.json`. A file that exists but can't be read or parsed throws (fails closed). */
export class FileDeviceKeyStore implements DeviceKeyStore {
  static readonly FILE_NAME = 'device-key.json';

  constructor(private readonly file: PrivateFile) {}

  static in(directory: () => string): FileDeviceKeyStore {
    return new FileDeviceKeyStore(new PrivateFile(directory, FileDeviceKeyStore.FILE_NAME));
  }

  read(): StoredDeviceKey | null {
    let text: string | null;
    try {
      text = this.file.read();
    } catch (error) {
      throw this.unreadable(error);
    }
    if (text === null) return null;
    try {
      const stored = JSON.parse(text) as DeviceKeyFileV1;
      if (stored?.v !== 1 || !stored.privateKey || !stored.publicKey) throw new Error('not a v1 device key file');

      return {
        publicKey: stored.publicKey,
        seed:      NodeEd25519Primitives.seedFromPrivateKey(crypto.createPrivateKey(stored.privateKey)),
        createdAt: stored.createdAt,
      };
    } catch (error) {
      throw this.unreadable(error);
    }
  }

  write(key: StoredDeviceKey): void {
    const stored: DeviceKeyFileV1 = {
      v:          1,
      publicKey:  key.publicKey,
      privateKey: NodeEd25519Primitives.privateKeyFromSeed(key.seed).export({ format: 'pem', type: 'pkcs8' }).toString(),
      createdAt:  key.createdAt,
    };
    try {
      this.file.write(JSON.stringify(stored));
    } catch (error) {
      throw new DeviceIdentityError('device_key_not_saved', `[deviceKey] could not save ${ this.file.path }: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }

  private unreadable(error: unknown): DeviceIdentityError {
    return new DeviceIdentityError('device_key_unreadable', `[deviceKey] unreadable ${ this.file.path }: ${ error instanceof Error ? error.message : String(error) }`);
  }
}
