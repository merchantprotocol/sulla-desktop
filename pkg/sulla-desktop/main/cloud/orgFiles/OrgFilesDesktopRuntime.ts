// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomBytes, webcrypto } from 'node:crypto';
import { safeStorage } from 'electron';
import { OrgFilesKeyCipher } from '@sulla/domain';
import { CloudOrgMembershipSource, OrgMembershipDirectory } from '../../../agent/services/OrgMembershipDirectory';
import { FileOrgFilesKeyStore } from '../device/FileOrgFilesKeyStore';
import { OrgFilesCloudClient } from './OrgFilesCloudClient';
import { OrgFilesRecipientKeyStore } from './OrgFilesRecipientKeyStore';
import { OrgFilesKeyring } from './OrgFilesKeyring';
import { OrgFilesFilesClient } from './OrgFilesFilesClient';
import { OrgCollectionSyncDriver } from './OrgCollectionSyncDriver';
import { OrgCollectionCreator } from './OrgCollectionCreator';

/** Main-process composition root for org Files sync and collection creation. */
export class OrgFilesDesktopRuntime {
  private static shared: OrgFilesDesktopRuntime | null = null;
  private readonly keyring: OrgFilesKeyring;
  private readonly driver: OrgCollectionSyncDriver;
  private readonly memberships: OrgMembershipDirectory;
  readonly creator: OrgCollectionCreator;

  constructor() {
    const cloud = new OrgFilesCloudClient();
    const recipientStore = new OrgFilesRecipientKeyStore(new FileOrgFilesKeyStore(() => safeStorage), cloud);
    const files = new OrgFilesFilesClient();
    this.keyring = new OrgFilesKeyring(
      cloud, recipientStore, new OrgFilesKeyCipher(webcrypto.subtle, size => new Uint8Array(randomBytes(size))),
      async () => true, undefined, files,
    );
    this.memberships = new OrgMembershipDirectory(new CloudOrgMembershipSource());
    this.driver = new OrgCollectionSyncDriver(this.memberships, cloud, this.keyring, files);
    this.creator = new OrgCollectionCreator(cloud, this.keyring, files);
  }

  static current(): OrgFilesDesktopRuntime { return this.shared ??= new OrgFilesDesktopRuntime(); }
  static currentOrNull(): OrgFilesDesktopRuntime | null { return this.shared; }
  start(): void { this.driver.start(); }
  wake(): void { this.driver.wake(); }
  stop(): void { this.driver.stop(); void this.keyring.onSignOut(); }
  onVaultUnlocked(): void { this.driver.wake(); }
  onVaultLocked(): void { void this.keyring.onLock(); }

  async createCollection(input: { orgId?: string; orgName?: string; name: string }) {
    const requested = input.orgId?.trim() || input.orgName?.trim();
    if (!requested) throw new Error('orgId or orgName is required');
    const organization = await this.memberships.require(requested);
    return this.creator.create({ orgId: organization.orgId, orgName: organization.name, name: input.name });
  }
}
