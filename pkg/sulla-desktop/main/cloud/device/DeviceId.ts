// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DeviceIdentityError, type RandomSource } from './DeviceIdentityPorts';

/**
 * The stable Cloud device id. New ids are UUIDv4 built only from a CSPRNG; there is no
 * Math.random fallback, so a missing CSPRNG fails closed instead of minting a guessable id.
 */
export class DeviceId {
  /** UUIDs and the other id shapes older installs may have saved; no whitespace, no newlines. */
  private static readonly SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

  private constructor(readonly value: string) {}

  static generate(random: RandomSource): DeviceId {
    let bytes: Uint8Array;
    try {
      bytes = random.bytes(16);
    } catch (error) {
      throw new DeviceIdentityError('csprng_unavailable', `No secure random source for a device id: ${ error instanceof Error ? error.message : String(error) }`);
    }
    if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
      throw new DeviceIdentityError('csprng_unavailable', 'The secure random source returned the wrong number of bytes.');
    }
    const b = Uint8Array.from(bytes);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Buffer.from(b).toString('hex');

    return new DeviceId(`${ hex.slice(0, 8) }-${ hex.slice(8, 12) }-${ hex.slice(12, 16) }-${ hex.slice(16, 20) }-${ hex.slice(20) }`);
  }

  /** Throws `device_id_malformed` for anything that isn't a plausible stored id. */
  static parse(raw: string): DeviceId {
    const value = raw.trim();
    if (!DeviceId.SHAPE.test(value)) throw new DeviceIdentityError('device_id_malformed', 'The saved device id is malformed.');

    return new DeviceId(value);
  }

  static tryParse(raw: string | null | undefined): DeviceId | null {
    if (!raw) return null;
    try { return DeviceId.parse(raw) } catch { return null }
  }

  toString(): string { return this.value }
}
