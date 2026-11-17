// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'crypto';
import { OrgFilesContract, OrgFilesRecipientKeyPayload, type OrgFilesRecipientKey } from '@sulla/domain';
import { getDesktopDeviceId } from '../../deviceIdentity';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { signDeviceMessageExact } from '../deviceKey';
import { OrgFilesCloudClient } from './OrgFilesCloudClient';

/** Signing domain for org Files recipient keys. Cloud verifies deviceMessage(ORG_FILES_KEY_DOMAIN, [canonical]). */
export const ORG_FILES_KEY_DOMAIN = 'org-files-key-v1' as const;

/** Implemented by the existing encrypted Vault item client; never by Files or disk. */
export interface OrgFilesVaultKeyStore {
  read(itemKey: string): Promise<JsonWebKey | null>;
  write(itemKey: string, value: JsonWebKey): Promise<void>;
}

export class OrgFilesRecipientKeyStore {
  constructor(
    private readonly vault: OrgFilesVaultKeyStore,
    private readonly cloud: Pick<OrgFilesCloudClient, 'publishRecipientKey' | 'recipientKeys'>,
    private readonly crypto: Crypto = globalThis.crypto,
    private readonly identity: () => Promise<{ userId: string; deviceId: string }> = async () => ({ userId: await getCurrentUserId(), deviceId: await getDesktopDeviceId() }),
    // Exact framing: Cloud verifies deviceMessage('org-files-key-v1', [canonical]), with no timestamp appended.
    private readonly sign: (domain: typeof ORG_FILES_KEY_DOMAIN, payload: string) => Promise<string> = (domain, payload) => signDeviceMessageExact(domain, [payload]),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async ensure(orgId: string): Promise<OrgFilesRecipientKey> {
    const { userId, deviceId } = await this.identity();
    if (!orgId || !userId || !deviceId) throw new Error('Org Files identity is unavailable');
    const itemKey = this.itemKey(userId, orgId);
    let privateJwk = await this.vault.read(itemKey);
    if (!privateJwk) {
      const pair = await this.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
      privateJwk = await this.crypto.subtle.exportKey('jwk', pair.privateKey);
      await this.vault.write(itemKey, privateJwk);
    }
    // A private JWK may be reconstructed only in memory. Public JWK is derived from its x/y coordinates.
    const publicKey: JsonWebKey = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, ext: true, key_ops: [] };
    const fingerprint = createHash('sha256').update(JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y })).digest('base64url');
    const existing = (await this.cloud.recipientKeys(orgId)).keys.find(key => key.userId === userId && key.keyId === fingerprint);
    if (existing?.deviceId === deviceId) return existing;
    const bare = { orgId, userId, deviceId, publicKey, keyId: fingerprint, createdAt: existing?.createdAt ?? this.now() };
    const payload = new OrgFilesRecipientKeyPayload(bare).canonical();
    const key = new OrgFilesContract().recipientKeyRequest({ key: { ...bare, signature: await this.sign(ORG_FILES_KEY_DOMAIN, payload) } }).key;
    await this.cloud.publishRecipientKey(orgId, key);
    return key;
  }

  async privateKey(orgId: string, userId: string): Promise<CryptoKey> {
    const jwk = await this.vault.read(this.itemKey(userId, orgId));
    if (!jwk) throw new Error('Org Files recipient key is unavailable');
    return this.crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  }

  private itemKey(userId: string, orgId: string): string { return `org-files-recipient:${userId}:${orgId}`; }
}
