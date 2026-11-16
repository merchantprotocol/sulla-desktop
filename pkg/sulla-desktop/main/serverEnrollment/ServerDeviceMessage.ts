// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

/**
 * The exact messages a Desktop signs for a self-hosted Sulla Server (sulla-server `ServerDeviceMessage`, M6 S8), framed
 * the way the domain `DeviceMessage` frames every device message: `tag\npart1\npart2...`, UTF-8.
 *
 * - Enrollment: `sulla-server-device-v1\nenroll\n<serverId>\n<organizationId>\n<deviceId>\n<publicKey>\n<ts>`
 *   (= `DeviceIdentityService.sign('server-device-v1', ['enroll', serverId, organizationId, deviceId, publicKey])`).
 * - Request: `sulla-server-device-v1\nrequest\n<serverId>\n<deviceId>\n<METHOD>\n<path>\n<ts>\n<nonce>\n<sha256hex(rawBody)>`.
 *
 * The `server-device-v1` purpose only exists in @sulla/domain >= 0.3.5; Desktop vendors 0.3.3, so the framing lives here
 * and the bytes are signed with `DeviceIdentityService.signBytes`. The shared test vectors pin the bytes.
 */
export class ServerDeviceMessage {
  static readonly TAG = 'sulla-server-device-v1';
  static readonly ENROLL = 'enroll';
  static readonly REQUEST = 'request';

  private constructor(readonly text: string) {}

  static enrollment(fields: { serverId: string; organizationId: string; deviceId: string; publicKey: string; ts: number }): ServerDeviceMessage {
    return ServerDeviceMessage.of([ServerDeviceMessage.ENROLL, fields.serverId, fields.organizationId, fields.deviceId, fields.publicKey, fields.ts]);
  }

  static request(fields: { serverId: string; deviceId: string; method: string; path: string; ts: number; nonce: string; bodySha256: string }): ServerDeviceMessage {
    return ServerDeviceMessage.of([
      ServerDeviceMessage.REQUEST, fields.serverId, fields.deviceId, fields.method.toUpperCase(), fields.path, fields.ts, fields.nonce, fields.bodySha256,
    ]);
  }

  /** Lowercase hex SHA-256 of the raw body bytes; no body hashes as the empty string. */
  static bodyDigest(raw: string | Uint8Array | undefined): string {
    return crypto.createHash('sha256').update(raw ?? '').digest('hex');
  }

  /** A newline inside a part would let two different field lists sign to the same bytes, so it is refused. */
  private static of(parts: ReadonlyArray<string | number>): ServerDeviceMessage {
    const values = parts.map(String);
    if (values.some(value => value.includes('\n'))) throw new TypeError('message parts must not contain newlines');

    return new ServerDeviceMessage([ServerDeviceMessage.TAG, ...values].join('\n'));
  }

  toBytes(): Uint8Array {
    return new Uint8Array(Buffer.from(this.text, 'utf8'));
  }

  toString(): string {
    return this.text;
  }
}
