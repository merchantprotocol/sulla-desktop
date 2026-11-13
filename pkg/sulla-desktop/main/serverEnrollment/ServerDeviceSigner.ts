// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import type { DeviceIdentityService } from '@sulla/domain';
import type { Clock } from '@sulla/foundation';

import { ServerDeviceMessage } from './ServerDeviceMessage';

/** The slice of the domain `DeviceIdentityService` (`desktopDeviceIdentity()`) the Sulla Server protocol needs. */
export type ServerDeviceIdentity = Pick<DeviceIdentityService, 'deviceId' | 'publicKey' | 'signBytes' | 'keyRotationProof'>;

/** Random bytes for request nonces. */
export interface NonceSource { bytes(length: number): Uint8Array }

/** Waits `ms` milliseconds. */
export type Sleeper = (ms: number) => Promise<void>;

export class NodeNonceSource implements NonceSource {
  bytes(length: number): Uint8Array {
    return new Uint8Array(crypto.randomBytes(length));
  }
}

export interface SignedProof { ts: number; signature: string }

export interface EnrollmentProof {
  deviceId: string;
  publicKey: string;
  proof: SignedProof;
}

export interface DeviceRequestHeaders {
  'x-sulla-device-ts': string;
  'x-sulla-device-nonce': string;
  'x-sulla-device-signature': string;
}

/**
 * Signs Sulla Server enrollment proofs and device requests with this install's device key. Never holds the key: every
 * signature comes from the identity service. Timestamps are whole unix seconds from the injected clock.
 */
export class ServerDeviceSigner {
  static readonly NONCE_BYTES = 16;
  static readonly TS_HEADER = 'x-sulla-device-ts';
  static readonly NONCE_HEADER = 'x-sulla-device-nonce';
  static readonly SIGNATURE_HEADER = 'x-sulla-device-signature';

  /** Second of the last enrollment proof. The server refuses an identical proof as a replay, so the next waits a second. */
  private lastEnrollmentSecond: number | null = null;

  constructor(
    private readonly serverId: string,
    private readonly identity: ServerDeviceIdentity,
    private readonly clock: Clock,
    private readonly nonces: NonceSource = new NodeNonceSource(),
    private readonly sleep: Sleeper = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {
    if (!serverId || serverId.includes('\n')) throw new TypeError('serverId is invalid');
  }

  async deviceId(): Promise<string> {
    return (await this.identity.deviceId()).value;
  }

  /** The enrollment fields: device id, public key and the possession proof bound to this server and organization. */
  async enrollmentProof(organizationId: string): Promise<EnrollmentProof> {
    const [deviceId, publicKey] = await Promise.all([this.deviceId(), this.identity.publicKey()]);
    const ts = await this.nextEnrollmentSecond();
    const message = ServerDeviceMessage.enrollment({ serverId: this.serverId, organizationId, deviceId, publicKey, ts });

    return { deviceId, publicKey, proof: { ts, signature: await this.identity.signBytes(message.toBytes()) } };
  }

  /** Proof headers for one device call; `path` is the canonical `/desktop/v1/...` path and `rawBody` the exact bytes sent. */
  async requestHeaders(method: string, path: string, rawBody: string): Promise<DeviceRequestHeaders> {
    const ts = this.nowSeconds();
    const nonce = Buffer.from(this.nonces.bytes(ServerDeviceSigner.NONCE_BYTES)).toString('base64url');
    const message = ServerDeviceMessage.request({
      serverId: this.serverId, deviceId: await this.deviceId(), method, path, ts, nonce, bodySha256: ServerDeviceMessage.bodyDigest(rawBody),
    });

    return {
      'x-sulla-device-ts':        String(ts),
      'x-sulla-device-nonce':     nonce,
      'x-sulla-device-signature': await this.identity.signBytes(message.toBytes()),
    };
  }

  /** The current key's proof that this device moves to `nextPublicKey` (`sulla-key-rotate-v1`). */
  keyRotationProof(userId: string, nextPublicKey: string): Promise<SignedProof> {
    return this.identity.keyRotationProof(userId, nextPublicKey);
  }

  private async nextEnrollmentSecond(): Promise<number> {
    let ts = this.nowSeconds();
    while (this.lastEnrollmentSecond !== null && ts <= this.lastEnrollmentSecond) {
      await this.sleep(1000 - (this.clock.now().getTime() % 1000));
      ts = this.nowSeconds();
    }
    this.lastEnrollmentSecond = ts;

    return ts;
  }

  private nowSeconds(): number {
    const ms = this.clock.now().getTime();
    if (!Number.isFinite(ms)) throw new TypeError('clock returned an invalid date');

    return Math.floor(ms / 1000);
  }
}
