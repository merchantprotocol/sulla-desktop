// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { LocalEncryptedItem, LocalItemContext } from '@sulla/domain';

import type { FilesTransportEnvelopeService } from '@sulla/vault-crypto';

import type { BitwardenExportImporter } from '../bitwarden/BitwardenExportImporter.js';
import type { DomainVaultSyncCodecProvider } from '../browserEnvelope/DomainVaultSyncCodecProvider.js';
import type { SyncBundle, SyncHead } from '../browserEnvelope/envelope.js';
import type { StoredKeyEnvelopeReaderProvider } from '../browserEnvelope/StoredKeyEnvelopeReaderProvider.js';
import type { VaultConfig } from '../config.js';
import type {
  BrokerCredentialRef, BrokerExecuteRequest, BrokerExecuteResponse, BrokerIntegrationMetadataResponse, LocalVaultState,
} from '../contracts.js';
import type { Database, Queryable } from '../db.js';
import type { LocalVaultCryptoProvider } from '../localCrypto/LocalVaultCryptoProvider.js';
import type { PinnedAddress } from '../pinnedLookup.js';
import type { VaultRelayManager } from '../relays.js';
import type { PostgresLocalAuthorityRepository } from '../repositories/PostgresLocalAuthorityRepository.js';
import type { PostgresRewrapHistoryRepository } from '../repositories/PostgresRewrapHistoryRepository.js';
import type {
  PostgresIntegrationStateRepository, PostgresLegacyCredentialRepository, PostgresVaultMigrationRepository,
  PostgresVaultRecoveryRepository, PostgresVaultSyncStateRepository, PostgresVaultUserRepository,
} from '../repositories/PostgresVaultAuthorityRepositories.js';
import type { PostgresSullaCloudRevocationRepository } from '../repositories/PostgresSullaCloudRevocationRepository.js';
import type { PostgresVaultAuditLogRepository, PostgresVaultItemRepository } from '../repositories/PostgresVaultItemRepositories.js';
import type { AgentMailboxCloudLane } from '../sullaCloudSession/AgentMailboxCloudLane.js';
import type { SullaCloudSessionManager } from '../sullaCloudSession/SullaCloudSessionManager.js';
import type { LocalAuthorityCollaborators } from './LocalAuthorityCollaborators.js';
import type { Challenge, HumanSession, ItemRow, StagedCacheUpdate, UnlockedKeys } from './LocalAuthorityTypes.js';

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
  sullaCloudSessionManager: SullaCloudSessionManager | null;
  agentMailboxCloudLane:    AgentMailboxCloudLane | null;
  readonly pendingApprovals: Map<string, number>;
  readonly approvals:        Map<string, { digest: string; expiresAt: number }>;
  readonly relaySessions:    Map<string, { generation: number; controller: AbortController }>;
  readonly pendingVaultEnrollments: Map<string, {
    expiresAt: number; bundle: SyncBundle; head: SyncHead; userKey: Uint8Array; privateKey: Uint8Array; masterKey: Uint8Array; cloudUserId: string;
  }>;

  // Dependencies.
  readonly db:                  Database;
  readonly config:              VaultConfig;
  readonly userRepository:      PostgresVaultUserRepository;
  readonly migrationRepository: PostgresVaultMigrationRepository;
  readonly recoveryRepository:  PostgresVaultRecoveryRepository;
  readonly itemRepository:      PostgresVaultItemRepository;
  readonly auditLogRepository:  PostgresVaultAuditLogRepository;
  readonly rewrapHistory:       PostgresRewrapHistoryRepository;
  readonly syncStateRepository: PostgresVaultSyncStateRepository;
  readonly integrationStateRepository: PostgresIntegrationStateRepository;
  readonly legacyCredentialRepository: PostgresLegacyCredentialRepository;
  readonly keyEnvelopeReaderProvider: StoredKeyEnvelopeReaderProvider;
  readonly filesTransport:      FilesTransportEnvelopeService;
  readonly codecProvider:       DomainVaultSyncCodecProvider;
  readonly relayManager:        VaultRelayManager;
  readonly revocationRepository: PostgresSullaCloudRevocationRepository;
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
  requireDesktopIdentity(callerId: string, token: string | undefined): void;
  requireBrokerIdentity(callerId: string, token: string | undefined): void;
  validateTarget(raw: string): Promise<URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses: PinnedAddress[] }>;
  loadBrokerItem(input: BrokerExecuteRequest, host: string | null, bypassAgentPolicy?: boolean): Promise<ItemRow>;
  send(
    url: URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] }, methodInput: string, headersInput: Record<string, string>,
    bodyInput: unknown, responseType: 'json' | 'text' | 'base64', secrets: string[], generation: number, redactResponseBody?: boolean,
    maxRequestBytes?: number, maxResponseBytes?: number, operation?: string, integrationId?: string,
  ): Promise<BrokerExecuteResponse>;
  audit(input: BrokerExecuteRequest, item: ItemRow, blocked: boolean, reason: string | null, db?: Queryable): Promise<void>;
  withCredentialQueue<T>(ref: BrokerCredentialRef, operation: () => Promise<T>): Promise<T>;
  integrationMetadata(callerId: string, token: string | undefined, integrationId: string, accountFilter?: string): Promise<BrokerIntegrationMetadataResponse>;
  isSetupRequired(): Promise<boolean>;
  validateHumanSession(sessionId: string | undefined, csrf?: string): HumanSession;
  unlockWithPassword(password: string): Promise<{ state: LocalVaultState; cacheUpdateRequired: boolean }>;
  activateMasterKey(masterKey: Uint8Array, legacyVmk?: Buffer, newAccountKdf?: unknown, attemptGeneration?: number): Promise<{ state: LocalVaultState }>;
}
