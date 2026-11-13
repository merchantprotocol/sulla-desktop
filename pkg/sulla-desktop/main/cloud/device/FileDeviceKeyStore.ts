// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Clock } from '@sulla/foundation';
import type { DeviceKeyStore } from '@sulla/domain';

import { NodeDeviceCrypto } from './NodeDeviceCrypto';
import { PrivateFile } from './PrivateFile';

/** The on-disk v1 format, unchanged so existing installs keep their exact key. */
interface DeviceKeyFileV1 {
  v:          1;
  publicKey:  string; // base64 raw 32-byte Ed25519 key (informational; always recomputed from the private key)
  privateKey: string; // PKCS#8 PEM
  createdAt:  string;
}

/**
 * `~/.sulla/device-key.json` (0600, dir 0700). Implements the domain `DeviceKeyStore` by converting the stored
 * PKCS#8 PEM to and from the raw 32-byte Ed25519 seed, so no stored file changes. Null only when the file does not
 * exist; an unreadable or corrupt file throws (fails closed: a replaced key orphans the device in Cloud).
 */
export class FileDeviceKeyStore implements DeviceKeyStore {
  static readonly FILE_NAME = 'device-key.json';

  constructor(private readonly file: PrivateFile, private readonly clock: Clock, private readonly crypto: NodeDeviceCrypto = new NodeDeviceCrypto()) {}

  static in(directory: () => string, clock: Clock): FileDeviceKeyStore {
    return new FileDeviceKeyStore(new PrivateFile(directory, FileDeviceKeyStore.FILE_NAME), clock);
  }

  async read(): Promise<Uint8Array | null> {
    const text = this.file.read();
    if (text === null) return null;
    const stored = JSON.parse(text) as DeviceKeyFileV1;
    if (stored?.v !== 1 || typeof stored.privateKey !== 'string' || !stored.privateKey) {
      throw new Error(`[deviceKey] ${ this.file.path } is not a v1 device key file`);
    }

    return NodeDeviceCrypto.seedFromPem(stored.privateKey);
  }

  async createIfAbsent(seed: Uint8Array): Promise<boolean> {
    const stored: DeviceKeyFileV1 = {
      v:          1,
      publicKey:  Buffer.from(this.crypto.ed25519PublicKey(seed)).toString('base64'),
      privateKey: NodeDeviceCrypto.pemFromSeed(seed),
      createdAt:  this.clock.now().toISOString(),
    };

    return this.file.createExclusive(JSON.stringify(stored));
  }
}
