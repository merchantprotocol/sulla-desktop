// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Database } from '../db.js';
import { PostgresRewrapHistoryRepository } from './PostgresRewrapHistoryRepository.js';
import { PostgresSullaCloudRevocationRepository } from './PostgresSullaCloudRevocationRepository.js';
import { PostgresVaultAuditLogRepository, PostgresVaultItemRepository } from './PostgresVaultItemRepositories.js';
import { PostgresIntegrationStateRepository, PostgresLegacyCredentialRepository, PostgresVaultMigrationRepository, PostgresVaultRecoveryRepository, PostgresVaultSyncStateRepository, PostgresVaultUserRepository } from './PostgresVaultAuthorityRepositories.js';
import { PostgresDesktopAccountRepository } from './PostgresDesktopAccountRepository.js';
import { PostgresFilesCloudEscrowRepository } from './PostgresFilesCloudEscrowRepository.js';
import { PostgresFilesKeyBundleRepository } from './PostgresFilesKeyBundleRepository.js';
import { PgTransactionRunner } from './PgTransactionRunner.js';
import { PostgresLocalAuthorityRepository } from './PostgresLocalAuthorityRepository.js';

/** Single composition point for profile-protected repositories. SQL, pool, and construction order stay unchanged. */
export class VaultRepositories {
  readonly rewrapHistory: PostgresRewrapHistoryRepository;
  readonly items: PostgresVaultItemRepository;
  readonly auditLog: PostgresVaultAuditLogRepository;
  readonly users: PostgresVaultUserRepository;
  readonly recovery: PostgresVaultRecoveryRepository;
  readonly integrationState: PostgresIntegrationStateRepository;
  readonly migration: PostgresVaultMigrationRepository;
  readonly syncState: PostgresVaultSyncStateRepository;
  readonly legacyCredentials: PostgresLegacyCredentialRepository;
  readonly revocations: PostgresSullaCloudRevocationRepository;
  readonly desktopAccount: PostgresDesktopAccountRepository;
  readonly filesCloudEscrow: PostgresFilesCloudEscrowRepository;
  readonly filesKeyBundles: PostgresFilesKeyBundleRepository;
  readonly localAuthority: PostgresLocalAuthorityRepository;

  constructor(pool: Database, transactions: PgTransactionRunner = new PgTransactionRunner()) {
    this.rewrapHistory = new PostgresRewrapHistoryRepository(pool);
    this.items = new PostgresVaultItemRepository(pool);
    this.auditLog = new PostgresVaultAuditLogRepository(pool);
    this.users = new PostgresVaultUserRepository(pool);
    this.recovery = new PostgresVaultRecoveryRepository(pool);
    this.integrationState = new PostgresIntegrationStateRepository(pool);
    this.migration = new PostgresVaultMigrationRepository(pool);
    this.syncState = new PostgresVaultSyncStateRepository(pool);
    this.legacyCredentials = new PostgresLegacyCredentialRepository();
    this.revocations = new PostgresSullaCloudRevocationRepository(pool);
    this.desktopAccount = new PostgresDesktopAccountRepository(pool);
    this.filesCloudEscrow = new PostgresFilesCloudEscrowRepository(pool);
    this.filesKeyBundles = new PostgresFilesKeyBundleRepository(pool, transactions);
    this.localAuthority = new PostgresLocalAuthorityRepository(pool, transactions);
  }
}
