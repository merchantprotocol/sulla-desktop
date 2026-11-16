// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  Bytes,
  type EnrollmentContext, type EnrollmentKeyAgreement, type EnrollmentKeyHandle, type EnrollmentKeyPair,
  type EnrollmentPayload, type EnrollmentTransportEnvelope,
} from '@sulla/domain';

import type { LocalVaultApprovalClient } from '@pkg/vault-broker';
import type { VaultBundleResponse, VaultRecordsResponse } from '../vaultSyncV3/transport';

/*
 * KEY CUSTODY. The vault user key lives only in the vault container. Electron main never unwraps or wraps
 * it: the container's broker routes do (services/sulla-vault localAuthority.ts adopt/wrap/commit), including
 * the bundle signature check, the head scope check, the master-key == user-key check and the 60 s staged
 * commit. These adapters plug those routes into the domain `EnrollmentKeyAgreement` port, so the domain
 * services drive the protocol while the key stays put:
 * - requester: `unwrap` asks the broker to adopt and returns only the two MACs Cloud's confirm needs
 *   (`userKey` is empty — main never holds it);
 * - approver: `wrap` asks the broker to wrap for the requester's public key (`userKey`/`payload` passed to
 *   the domain are ignored; the container reads its own key and the current Cloud bundle/records).
 */

export type VaultEnrollmentBroker = Pick<LocalVaultApprovalClient, 'adoptVaultEnrollment' | 'commitVaultEnrollment' | 'wrapVaultEnrollment'>;

/** Finds the vault container's broker client at call time (it may not be configured yet). */
export class VaultEnrollmentBrokerSource {
  constructor(private readonly lookup: () => VaultEnrollmentBroker | null) {}

  require(): VaultEnrollmentBroker {
    const client = this.lookup();
    if (!client) throw new Error('vault enrollment service unavailable');
    return client;
  }
}

/** The requester's ECDH P-256 request key. The private half is an extractable JWK only so the vault container can import it. */
export class EnrollmentRequestKey {
  private constructor(readonly publicKey: Uint8Array, readonly privateKeyJwk: JsonWebKey) {}

  static async generate(subtle: SubtleCrypto): Promise<EnrollmentRequestKey> {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    return new EnrollmentRequestKey(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)), await subtle.exportKey('jwk', pair.privateKey));
  }

  publicKeyBase64Url(): string { return Bytes.toBase64Url(this.publicKey) }
}

export interface EnrollmentAdoptionCredentials {
  readonly masterKey: Uint8Array;
  readonly cloudUserId: string;
}

class UnsupportedKeyAgreement {
  protected unsupported(): never {
    throw new Error('vault key material stays in the vault container; this key agreement only delegates to its broker');
  }
}

/** Requester side: hands the domain `EnrollmentService` the already-open request key; unwrap = broker adopt. */
export class BrokerAdoptionKeyAgreement extends UnsupportedKeyAgreement implements EnrollmentKeyAgreement {
  constructor(
    private readonly key: EnrollmentRequestKey,
    private readonly credentials: EnrollmentAdoptionCredentials,
    private readonly broker: VaultEnrollmentBrokerSource,
  ) { super() }

  async generateKeyHandle(): Promise<EnrollmentKeyHandle> {
    return {
      publicKey: this.key.publicKey,
      unwrap:    (envelope, context) => this.adopt(envelope, context),
      // The open request (and its key) outlives one poll run: a timed-out enrollment is retried with it.
      dispose:   () => undefined,
    };
  }

  async generateKeyPair(): Promise<EnrollmentKeyPair> { return this.unsupported() }
  async unwrap(): Promise<EnrollmentPayload> { return this.unsupported() }
  async wrap(): Promise<EnrollmentTransportEnvelope> { return this.unsupported() }

  private async adopt(envelope: unknown, context: EnrollmentContext): Promise<EnrollmentPayload> {
    const proof = await this.broker.require().adoptVaultEnrollment({
      requestId:      context.requestId,
      vaultId:        context.vaultId,
      vaultEpoch:     context.epoch,
      privateKeyJwk:  this.key.privateKeyJwk,
      wrappedUserKey: envelope,
      masterKey:      Buffer.from(this.credentials.masterKey).toString('base64url'),
      cloudUserId:    this.credentials.cloudUserId,
    });
    return { userKey: new Uint8Array(0), bundle: { mac: proof.bundleMac }, head: { mac: proof.headMac } };
  }
}

/** What the approver's broker wrap needs from Cloud, fetched only after the human approved. */
export interface ApprovalVaultSource {
  bundle(vaultId: string): Promise<VaultBundleResponse>;
  records(vaultId: string): Promise<VaultRecordsResponse>;
}

/** Approver side, one per request: wrap = fetch bundle + records, then broker wrap for the requester's key. */
export class BrokerWrapKeyAgreement extends UnsupportedKeyAgreement implements EnrollmentKeyAgreement {
  constructor(
    private readonly requesterPublicKey: string,
    private readonly statusEpoch: unknown,
    private readonly vault: ApprovalVaultSource,
    private readonly broker: VaultEnrollmentBrokerSource,
  ) { super() }

  async wrap(_recipient: Uint8Array, _payload: EnrollmentPayload, context: EnrollmentContext): Promise<EnrollmentTransportEnvelope> {
    const broker = this.broker.require();
    const [bundleBody, recordsBody] = await Promise.all([this.vault.bundle(context.vaultId), this.vault.records(context.vaultId)]);
    const wrapped = await broker.wrapVaultEnrollment({
      requestId:  context.requestId,
      vaultId:    context.vaultId,
      vaultEpoch: Number(this.statusEpoch ?? (bundleBody.bundle as { epoch?: unknown } | undefined)?.epoch),
      publicKey:  this.requesterPublicKey,
      bundle:     bundleBody.bundle ?? bundleBody,
      head:       recordsBody.head,
      records:    recordsBody.records,
      approved:   true,
    });
    return wrapped.wrappedUserKey as EnrollmentTransportEnvelope;
  }

  async generateKeyPair(): Promise<EnrollmentKeyPair> { return this.unsupported() }
  async unwrap(): Promise<EnrollmentPayload> { return this.unsupported() }
}
