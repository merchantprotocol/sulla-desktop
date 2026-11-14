// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

/**
 * The message a device signs to bind one Sulla Cloud sign-in or refresh to itself (Cloud W-ID-6, sulla-workers
 * `DeviceSessionProof`):
 *
 *   sulla-session-bind-v1\n<deviceId>\n<ts>\n<request path, no query>\n<lowercase sha256 hex of the exact body bytes>
 *
 * Signing the endpoint and the exact body ties the proof to this one request, so it can't be replayed onto another
 * endpoint or another credential. This class only frames; `SessionBindSigner` gets the device to sign it.
 */
export class SessionBindProof {
  static readonly TAG = 'sulla-session-bind-v1';
  static readonly DEVICE_HEADER = 'X-Sulla-Device-Id';
  static readonly TIMESTAMP_HEADER = 'X-Sulla-Timestamp';
  static readonly SIGNATURE_HEADER = 'X-Sulla-Device-Signature';

  private constructor(readonly deviceId: string, readonly timestamp: number, readonly path: string, readonly bodyHash: string) {}

  /** Frames a proof for `body` (the exact string sent) to `requestPath`. Throws on a part that would change the framing. */
  static frame(deviceId: string, timestamp: number, requestPath: string, body: string): SessionBindProof {
    if (!deviceId || /[\r\n]/.test(deviceId)) throw new TypeError('session-bind: invalid device id');
    if (!Number.isInteger(timestamp)) throw new TypeError('session-bind: timestamp must be integer unix seconds');
    const path = SessionBindProof.pathOf(requestPath);
    if (!path.startsWith('/') || /[\r\n]/.test(path)) throw new TypeError('session-bind: invalid request path');

    return new SessionBindProof(deviceId, timestamp, path, crypto.createHash('sha256').update(body, 'utf8').digest('hex'));
  }

  /** The path Cloud sees (`c.req.path`): no query string or fragment. */
  static pathOf(requestPath: string): string {
    return requestPath.split(/[?#]/, 1)[0];
  }

  message(): string {
    return [SessionBindProof.TAG, this.deviceId, String(this.timestamp), this.path, this.bodyHash].join('\n');
  }

  bytes(): Uint8Array {
    return new Uint8Array(Buffer.from(this.message(), 'utf8'));
  }

  headers(signature: string): Record<string, string> {
    return {
      [SessionBindProof.DEVICE_HEADER]:    this.deviceId,
      [SessionBindProof.TIMESTAMP_HEADER]: String(this.timestamp),
      [SessionBindProof.SIGNATURE_HEADER]: signature,
    };
  }
}
