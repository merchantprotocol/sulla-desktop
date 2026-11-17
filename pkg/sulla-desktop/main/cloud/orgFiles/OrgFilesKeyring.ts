// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { OrgFilesKeyCipher, type OrgCollectionKeyWrap, type OrgFilesKeyWrap, type OrgFilesRecipientKey, type OrgFilesCollectionContext } from '@sulla/domain';
import { createHash } from 'node:crypto';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { OrgFilesCloudClient } from './OrgFilesCloudClient';
import { OrgFilesRecipientKeyStore } from './OrgFilesRecipientKeyStore';

export interface OrgFilesKeyringIdentity { userId(): Promise<string> }

/** Keep the cache identity identical to ProfileCatalogEntry without importing
 * the catalog package into the packaged Desktop runtime. */
export class OrgFilesProfileIdentity {
  static fromCloudUserId(cloudUserId: string): string {
    if (typeof cloudUserId !== 'string' || cloudUserId.trim().length === 0) throw new TypeError('cloudUserId is required');
    if (Buffer.byteLength(cloudUserId) > 256) throw new TypeError('cloudUserId is too long');
    return `profile_${createHash('sha256').update(cloudUserId, 'utf8').digest('hex')}`;
  }
}

export class OrgFilesKeyring {
  private readonly keys = new Map<string, Uint8Array>();
  private readonly profileEpochs = new Map<string, number>();

  constructor(
    private readonly cloud: Pick<OrgFilesCloudClient, 'myKeyWraps' | 'recipientKeys' | 'putKeyWraps' | 'pendingKeyWraps'>,
    private readonly recipientKeys: OrgFilesRecipientKeyStore,
    private readonly cipher: OrgFilesKeyCipher,
    private readonly canWrapForPending: (orgId: string) => Promise<boolean> = async () => false,
    private readonly identity: OrgFilesKeyringIdentity = { userId: getCurrentUserId },
    /** Files holds its own copy of the profile's org roots; sign-out and lock must reach it too. */
    private readonly filesCache: { invalidateProfile(profileId: string): Promise<unknown> } = { invalidateProfile: async () => undefined },
  ) {}

  ensureRecipientKey(orgId: string) { return this.recipientKeys.ensure(orgId); }

  async getOrgKey(orgId: string, keyVersion: number): Promise<Uint8Array> {
    const userId = await this.identity.userId();
    const profileId = OrgFilesProfileIdentity.fromCloudUserId(userId);
    const epoch = this.profileEpochs.get(profileId) ?? 0;
    const cacheKey = this.cacheKey(profileId, orgId, keyVersion);
    const cached = this.keys.get(cacheKey);
    if (cached) return new Uint8Array(cached);
    const [response, privateKey] = await Promise.all([this.cloud.myKeyWraps(orgId, keyVersion), this.recipientKeys.privateKey(orgId, userId)]);
    const wrap = response.wraps.find(value => value.keyVersion === keyVersion && value.recipientUserId === userId);
    if (!wrap) throw new Error(`No Org Files key wrap available for version ${keyVersion}`);
    const orgKey = await this.cipher.unwrapOrgKey(wrap, privateKey);
    if (epoch !== (this.profileEpochs.get(profileId) ?? 0)) { orgKey.fill(0); throw new Error('Org Files profile was invalidated during key access'); }
    this.keys.set(cacheKey, new Uint8Array(orgKey));
    return orgKey;
  }

  async createOrgKeyIfMissing(orgId: string): Promise<Uint8Array> {
    await this.ensureRecipientKey(orgId);
    const userId = await this.identity.userId();
    const profileId = OrgFilesProfileIdentity.fromCloudUserId(userId);
    const epoch = this.profileEpochs.get(profileId) ?? 0;
    const response = await this.cloud.myKeyWraps(orgId, 1);
    const existing = response.wraps.find(wrap => wrap.keyVersion === 1 && wrap.recipientUserId === userId);
    if (existing) return this.getOrgKey(orgId, 1);
    const orgKey = this.cipher.generateOrgKey();
    const recipients = await this.cloud.recipientKeys(orgId);
    try {
      const wraps = await this.wrapForRecipients(orgId, 1, orgKey, recipients.keys, userId);
      if (!wraps.length) throw new Error('Org Files has no recipient keys');
      await this.cloud.putKeyWraps(orgId, wraps);
      if (epoch !== (this.profileEpochs.get(profileId) ?? 0)) throw new Error('Org Files profile was invalidated during key creation');
      this.keys.set(this.cacheKey(profileId, orgId, 1), new Uint8Array(orgKey));
      return orgKey;
    } catch (error) { orgKey.fill(0); throw error; }
  }

  async wrapPendingMembers(orgId: string): Promise<OrgFilesKeyWrap[]> {
    if (!await this.canWrapForPending(orgId)) return [];
    const pending = await this.cloud.pendingKeyWraps(orgId);
    const [userId, recipients, orgKey] = await Promise.all([
      this.identity.userId(), this.cloud.recipientKeys(orgId), this.getOrgKey(orgId, pending.keyVersion),
    ]);
    const pendingUsers = new Set(pending.userIds);
    try {
      const wraps = await this.wrapForRecipients(orgId, pending.keyVersion, orgKey,
        recipients.keys.filter(key => pendingUsers.has(key.userId)), userId);
      if (wraps.length) await this.cloud.putKeyWraps(orgId, wraps);
      return wraps;
    } finally { orgKey.fill(0); }
  }

  async unwrapCollectionRoot(orgId: string, wrap: OrgCollectionKeyWrap): Promise<Uint8Array> {
    const key = await this.getOrgKey(orgId, wrap.keyVersion);
    try { return await this.cipher.unwrapCollectionRoot(key, wrap); }
    finally { key.fill(0); }
  }

  async wrapCollectionRoot(orgId: string, rootKey: Uint8Array, ctx: OrgFilesCollectionContext): Promise<OrgCollectionKeyWrap> {
    if (ctx.orgId !== orgId) throw new Error('Org Files collection context does not match org');
    const orgKey = await this.getOrgKey(orgId, ctx.keyVersion);
    try { return await this.cipher.wrapCollectionRoot(orgKey, rootKey, ctx); }
    finally { orgKey.fill(0); }
  }

  async onLock(): Promise<void> {
    let profileId: string;
    try { profileId = OrgFilesProfileIdentity.fromCloudUserId(await this.identity.userId()); }
    catch { this.invalidateAll(); return; }
    this.invalidateProfile(profileId);
    // Local zeroization already happened; a Files outage must not fail the lock (Files drops its keys on stop).
    await this.filesCache.invalidateProfile(profileId).catch(() => undefined);
  }

  async onSignOut(): Promise<void> { await this.onLock(); }

  invalidateProfile(profileId: string): void {
    this.profileEpochs.set(profileId, (this.profileEpochs.get(profileId) ?? 0) + 1);
    for (const [cacheKey, key] of this.keys) {
      if (!cacheKey.startsWith(`${profileId}:`)) continue;
      key.fill(0);
      this.keys.delete(cacheKey);
    }
  }

  private invalidateAll(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    for (const profileId of this.profileEpochs.keys()) this.profileEpochs.set(profileId, this.profileEpochs.get(profileId)! + 1);
  }

  private async wrapForRecipients(orgId: string, keyVersion: number, orgKey: Uint8Array,
    recipients: OrgFilesRecipientKey[], wrappedByUserId: string): Promise<OrgFilesKeyWrap[]> {
    const createdAt = new Date().toISOString();
    const unique = [...new Map(recipients.map(recipient => [recipient.userId, recipient])).values()];
    return Promise.all(unique.map(recipient => this.cipher.wrapOrgKeyFor(recipient, orgKey, {
      orgId, keyVersion, recipientUserId: recipient.userId, recipientKeyId: recipient.keyId, wrappedByUserId, createdAt,
    })));
  }

  private cacheKey(profileId: string, orgId: string, version: number): string { return `${profileId}:${orgId}:${version}`; }
}
