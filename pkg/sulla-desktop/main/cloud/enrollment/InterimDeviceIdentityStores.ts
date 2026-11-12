// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/*
 * INTERIM (M3 S6) — replace with M4's device identity adapters (PR #2207) by changing the stores passed
 * to the domain `DeviceIdentityService` in DesktopVaultEnrollmentModule. Do not grow these.
 *
 * They read today's files and never overwrite one: the id comes from `getDesktopDeviceId()` (which keeps its
 * SullaSettings migration), the key from `~/.sulla/device-key.json` after `deviceKey.ts` has ensured it
 * exists, so both code paths sign with the same key while they coexist.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DeviceIdStore, DeviceKeyStore } from '@sulla/domain';

/** `~/.sulla/device-id`, through today's reader. */
export class InterimDeviceIdStore implements DeviceIdStore {
  constructor(
    private readonly current: () => Promise<string>,
    private readonly file: () => string,
  ) {}

  async read(): Promise<string | null> {
    return (await this.current()) || null;
  }

  async createIfAbsent(id: string): Promise<boolean> {
    return new ExclusiveFileWriter().write(this.file(), id);
  }
}

/** `~/.sulla/device-key.json` (v1, PKCS#8 PEM) as the raw 32-byte Ed25519 seed. */
export class InterimDeviceKeyStore implements DeviceKeyStore {
  private static readonly PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

  constructor(
    private readonly ensureKey: () => unknown,
    private readonly file: () => string,
  ) {}

  async read(): Promise<Uint8Array | null> {
    this.ensureKey();
    let text: string;
    try {
      text = fs.readFileSync(this.file(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const stored = JSON.parse(text) as { v?: number; privateKey?: string };
    if (stored.v !== 1 || !stored.privateKey) throw new Error('device key file is not v1');
    const jwk = crypto.createPrivateKey(stored.privateKey).export({ format: 'jwk' }) as { crv?: string; d?: string };
    if (jwk.crv !== 'Ed25519' || !jwk.d) throw new Error('device key is not Ed25519');
    return new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  }

  async createIfAbsent(seed: Uint8Array): Promise<boolean> {
    const key = crypto.createPrivateKey({ key: Buffer.concat([InterimDeviceKeyStore.PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
    const publicKey = Buffer.from((crypto.createPublicKey(key).export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
    const stored = { v: 1, publicKey, privateKey: key.export({ format: 'pem', type: 'pkcs8' }).toString(), createdAt: new Date().toISOString() };
    return new ExclusiveFileWriter().write(this.file(), JSON.stringify(stored));
  }
}

/** Creates a 0600 file only if none exists (`wx`); never replaces one. */
class ExclusiveFileWriter {
  write(file: string, contents: string): boolean {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
}
