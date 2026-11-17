// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { getCurrentUserId } from '../../sullaCloudAuth';
import type { OrgFilesCloudClient } from './OrgFilesCloudClient';
import type { OrgFilesFilesClient } from './OrgFilesFilesClient';
import type { OrgFilesKeyring } from './OrgFilesKeyring';

export interface OrgCollectionCreateResult { collectionId: string; path: string }
export interface OrgCollectionCreatorIdentity { userId(): Promise<string> }

/** Creates a Cloud org collection, then provisions and enables its local Files counterpart. */
export class OrgCollectionCreator {
  constructor(
    private readonly cloud: Pick<OrgFilesCloudClient, 'createCollection'>,
    private readonly keyring: Pick<OrgFilesKeyring, 'createOrgKeyIfMissing' | 'wrapCollectionRoot'>,
    private readonly files: Pick<OrgFilesFilesClient, 'enroll' | 'pushRoot' | 'enableSync'>,
    private readonly identity: OrgCollectionCreatorIdentity = { userId: getCurrentUserId },
    private readonly uuid: () => string = randomUUID,
    private readonly crypto: Crypto = globalThis.crypto,
  ) {}

  async create(input: { orgId: string; orgName: string; name: string }): Promise<OrgCollectionCreateResult> {
    const name = input.name.trim();
    if (!input.orgId || !name || name.length > 128 || /[\\/\0]/.test(name)) throw new Error('A valid organization and collection name are required');
    const creatorUserId = await this.identity.userId();
    if (!creatorUserId) throw new Error('Sign in to Sulla Cloud before creating an org collection');
    const collectionId = this.uuid();
    const keyVersion = 1;
    const root = this.crypto.getRandomValues(new Uint8Array(32));
    try {
      const orgKey = await this.keyring.createOrgKeyIfMissing(input.orgId);
      orgKey.fill(0);
      const collectionKeyWrap = await this.keyring.wrapCollectionRoot(input.orgId, root, { orgId: input.orgId, collectionId, keyVersion });
      await this.cloud.createCollection(input.orgId, { collectionId, name, collectionKeyWrap });
      await this.files.enroll({ id: collectionId, orgId: input.orgId, orgName: input.orgName, name, creatorUserId, level: 'manage' });
      await this.files.pushRoot(collectionId, keyVersion, root);
      await this.files.enableSync(collectionId, keyVersion);
      return { collectionId, path: `/mnt/sulla-files/Organizations/${input.orgName}/${name}` };
    } catch (error) {
      if (this.isForbidden(error)) throw new Error('Only an org owner or admin can create a shared collection');
      throw error;
    } finally { root.fill(0); }
  }

  private isForbidden(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'status' in error && [403, 404].includes(Number((error as { status: unknown }).status));
  }
}
