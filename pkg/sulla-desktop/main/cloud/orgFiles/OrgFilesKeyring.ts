// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { OrgFilesKeyCipher, type OrgCollectionKeyWrap, type OrgFilesKeyWrap, type OrgFilesRecipientKey, type OrgFilesCollectionContext } from '@sulla/domain';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { OrgFilesCloudClient } from './OrgFilesCloudClient';
import { OrgFilesRecipientKeyStore } from './OrgFilesRecipientKeyStore';

export interface OrgFilesKeyringIdentity { userId(): Promise<string> }

export class OrgFilesKeyring {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(
    private readonly cloud: Pick<OrgFilesCloudClient, 'myKeyWraps' | 'recipientKeys' | 'putKeyWraps' | 'pendingKeyWraps'>,
    private readonly recipientKeys: OrgFilesRecipientKeyStore,
    private readonly cipher: OrgFilesKeyCipher,
    private readonly canWrapForPending: (orgId: string) => Promise<boolean> = async () => false,
    private readonly identity: OrgFilesKeyringIdentity = { userId: getCurrentUserId },
  ) {}

  ensureRecipientKey(orgId: string) { return this.recipientKeys.ensure(orgId); }

  async getOrgKey(orgId: string, keyVersion: number): Promise<Uint8Array> {
    const cacheKey = this.cacheKey(orgId, keyVersion);
    const cached = this.keys.get(cacheKey);
    if (cached) return new Uint8Array(cached);
    const userId = await this.identity.userId();
    const [response, privateKey] = await Promise.all([this.cloud.myKeyWraps(orgId, keyVersion), this.recipientKeys.privateKey(orgId, userId)]);
    const wrap = response.wraps.find(value => value.keyVersion === keyVersion && value.recipientUserId === userId);
    if (!wrap) throw new Error(`No Org Files key wrap available for version ${keyVersion}`);
    const orgKey = await this.cipher.unwrapOrgKey(wrap, privateKey);
    this.keys.set(cacheKey, new Uint8Array(orgKey));
    return orgKey;
  }

  async createOrgKeyIfMissing(orgId: string): Promise<Uint8Array> {
    await this.ensureRecipientKey(orgId);
    const userId = await this.identity.userId();
    const response = await this.cloud.myKeyWraps(orgId, 1);
    const existing = response.wraps.find(wrap => wrap.keyVersion === 1 && wrap.recipientUserId === userId);
    if (existing) return this.getOrgKey(orgId, 1);
    const orgKey = this.cipher.generateOrgKey();
    const recipients = await this.cloud.recipientKeys(orgId);
    try {
      const wraps = await this.wrapForRecipients(orgId, 1, orgKey, recipients.keys, userId);
      if (!wraps.length) throw new Error('Org Files has no recipient keys');
      await this.cloud.putKeyWraps(orgId, wraps);
      this.keys.set(this.cacheKey(orgId, 1), new Uint8Array(orgKey));
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

  onLock(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }

  onSignOut(): void { this.onLock(); }

  private async wrapForRecipients(orgId: string, keyVersion: number, orgKey: Uint8Array,
    recipients: OrgFilesRecipientKey[], wrappedByUserId: string): Promise<OrgFilesKeyWrap[]> {
    const createdAt = new Date().toISOString();
    const unique = [...new Map(recipients.map(recipient => [recipient.userId, recipient])).values()];
    return Promise.all(unique.map(recipient => this.cipher.wrapOrgKeyFor(recipient, orgKey, {
      orgId, keyVersion, recipientUserId: recipient.userId, recipientKeyId: recipient.keyId, wrappedByUserId, createdAt,
    })));
  }

  private cacheKey(orgId: string, version: number): string { return `${orgId}:${version}`; }
}
