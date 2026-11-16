// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { LocalEncryptedItem, LocalItemContext } from '@sulla/domain';

import type { BitwardenExportImporter } from '../bitwarden/BitwardenExportImporter.js';
import type { VaultConfig } from '../config.js';
import type { LocalVaultState } from '../contracts.js';
import type { Database, Queryable } from '../db.js';
import type { LocalVaultCryptoProvider } from '../localCrypto/LocalVaultCryptoProvider.js';
import type { PostgresLocalAuthorityRepository } from '../repositories/PostgresLocalAuthorityRepository.js';
import type { PostgresRewrapHistoryRepository } from '../repositories/PostgresRewrapHistoryRepository.js';
import type {
  PostgresVaultMigrationRepository, PostgresVaultRecoveryRepository, PostgresVaultUserRepository,
} from '../repositories/PostgresVaultAuthorityRepositories.js';
import type { PostgresVaultAuditLogRepository, PostgresVaultItemRepository } from '../repositories/PostgresVaultItemRepositories.js';
import type { LocalAuthorityCollaborators } from './LocalAuthorityCollaborators.js';
import type { Challenge, HumanSession, StagedCacheUpdate, UnlockedKeys } from './LocalAuthorityTypes.js';

/**
 * What LocalVaultAuthority's collaborators may read and change on it (E9). The authority keeps
 * all vault state (unlocked keys, generation, grants, challenges) so lock, generation checks and
 * the security-operation queue stay in one place; collaborators hold only this host reference
 * and read it at call time.
 */
export interface LocalAuthorityHost {
  // Vault state.
  keys:              UnlockedKeys | null;
  generation:        number;
  migrationState:    LocalVaultState;
  stagedCacheUpdate: StagedCacheUpdate | null;
  readonly challenges:      Map<string, Challenge>;
  readonly cacheChallenges: Map<string, Challenge>;
  readonly challengeRate:   Map<string, { count: number; resetAt: number }>;
  readonly humanSessions:   Map<string, HumanSession>;

  // Dependencies.
  readonly db:                  Database;
  readonly config:              VaultConfig;
  readonly userRepository:      PostgresVaultUserRepository;
  readonly migrationRepository: PostgresVaultMigrationRepository;
  readonly recoveryRepository:  PostgresVaultRecoveryRepository;
  readonly itemRepository:      PostgresVaultItemRepository;
  readonly auditLogRepository:  PostgresVaultAuditLogRepository;
  readonly rewrapHistory:       PostgresRewrapHistoryRepository;
  readonly localCryptoProvider: LocalVaultCryptoProvider;
  readonly bitwardenImporter:   BitwardenExportImporter;
  readonly localStore:          PostgresLocalAuthorityRepository;
  readonly parts:               LocalAuthorityCollaborators;

  // Shared guards and transitions.
  requireKeys(): UnlockedKeys;
  requireGeneration(generation: number): void;
  requireStableGeneration(generation: number): void;
  runSecurityOperation<T>(operation: () => Promise<T>): Promise<T>;
  runTransaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  auditHumanAction(db: Queryable, actorId: string, action: string, itemId?: string | null, path?: string): Promise<void>;
  sealItem(plaintext: string, userKey: Uint8Array, context: LocalItemContext): Promise<LocalEncryptedItem>;
  openItemText(item: LocalEncryptedItem, userKey: Uint8Array, context: LocalItemContext): Promise<string>;
  bootstrapToken(): string;
  lockNow(): void;
  stageCacheUpdate(masterKey: Uint8Array): void;
  expireStagedCacheUpdate(): void;
  retryPendingSullaCloudRevocations(): void;
  requireControlIdentity(callerId: string, token: string | undefined): void;
  requireApprovalIdentity(callerId: string, token: string | undefined): void;
  isSetupRequired(): Promise<boolean>;
  validateHumanSession(sessionId: string | undefined, csrf?: string): HumanSession;
  unlockWithPassword(password: string): Promise<{ state: LocalVaultState; cacheUpdateRequired: boolean }>;
  activateMasterKey(masterKey: Uint8Array, legacyVmk?: Buffer, newAccountKdf?: unknown, attemptGeneration?: number): Promise<{ state: LocalVaultState }>;
}
