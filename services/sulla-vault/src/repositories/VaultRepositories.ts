// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Queryable } from '../db.js';
import type { VaultProfileSession } from '../profiles/VaultProfileSession.js';
import { PostgresRewrapHistoryRepository } from './PostgresRewrapHistoryRepository.js';
import { PostgresSullaCloudRevocationRepository } from './PostgresSullaCloudRevocationRepository.js';
import { PostgresVaultAuditLogRepository, PostgresVaultItemRepository } from './PostgresVaultItemRepositories.js';
import { PostgresIntegrationStateRepository, PostgresLegacyCredentialRepository, PostgresVaultMigrationRepository, PostgresVaultRecoveryRepository, PostgresVaultSyncStateRepository, PostgresVaultUserRepository } from './PostgresVaultAuthorityRepositories.js';
import { PostgresDesktopAccountRepository } from './PostgresDesktopAccountRepository.js';
import { PostgresFilesCloudEscrowRepository } from './PostgresFilesCloudEscrowRepository.js';
import { PostgresFilesKeyBundleRepository } from './PostgresFilesKeyBundleRepository.js';
import { PgTransactionRunner } from './PgTransactionRunner.js';
import { PostgresLocalAuthorityRepository } from './PostgresLocalAuthorityRepository.js';
import { CloudSyncRepositories } from '../browserEnvelope/sync/CloudSyncRepositories.js';
import { PostgresSyncStateRepository } from '../browserEnvelope/sync/repositories/PostgresSyncStateRepository.js';
import { PostgresPersonalItemRepository } from '../browserEnvelope/sync/repositories/PostgresPersonalItemRepository.js';
import { PostgresLegacyAuditRepository } from './PostgresLegacyAuditRepository.js';
import { PostgresHumanActivityRepository } from './PostgresHumanActivityRepository.js';

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
  readonly cloudSync: CloudSyncRepositories;
  readonly legacyAudit: PostgresLegacyAuditRepository;
  readonly humanActivity: PostgresHumanActivityRepository;

  constructor(session: VaultProfileSession, transactions: PgTransactionRunner = new PgTransactionRunner()) {
    const pool = session.database;
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
    this.cloudSync = new CloudSyncRepositories(new PostgresSyncStateRepository(), new PostgresPersonalItemRepository());
    this.legacyAudit = VaultRepositories.createLegacyAuditRepository(pool);
    this.humanActivity = new PostgresHumanActivityRepository(pool);
  }

  static createLegacyAuditRepository(connection: Queryable): PostgresLegacyAuditRepository {
    return new PostgresLegacyAuditRepository(connection);
  }
}
