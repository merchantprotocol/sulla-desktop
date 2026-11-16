// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import { join } from 'node:path';

import pg from 'pg';
import type { LocalEncryptedItem, LocalItemContext } from '@sulla/domain';

import {
  agentPolicyAllows,
  type AgentAccessLevel,
  type AgentPolicy,
  validateVaultItemProxy,
  type VaultItemPlaintext,
} from '@sulla/vault-crypto';

import { BitwardenExportImporter } from './bitwarden/BitwardenExportImporter.js';
import { validateCatalogRequest } from './catalogPolicy.js';
import { validateEnterpriseGatewayHttp } from './gatewayPolicy.js';
import { brokerTransferLimits, FILES_SYNC_OPERATION, isTrustedFilesCloudCall, validateItemHttpOperation, validateOperation } from './operationPolicy.js';
import { validateOAuthDestination } from './oauthPolicy.js';
import { pinnedAddressesLookup, pinnedLookup, type PinnedAddress } from './pinnedLookup.js';
import {
  describeUpstreamError, familySummary, formatUpstreamFailureLog, isReconnectableUpstreamError, retryAddressOrder,
  UPSTREAM_CONNECT_TIMEOUT_MS, UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS, UPSTREAM_MAX_ATTEMPTS,
  UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS, UPSTREAM_RETRY_DELAYS_MS,
  upstreamFailurePhase, upstreamFailureReason,
} from './upstreamEgress.js';
import { DefaultVaultRelayManager } from './relays.js';
import { buildTranscriptionProviderRequest } from './transcriptionPolicy.js';

import type { VaultConfig } from './config.js';
import type { FilesAuthorityIdentityLease, UnlockedFilesAuthorityIdentity } from './filesKeyBundleAuthority.js';
import type {
  BrokerCredentialRef,
  BrokerItemListResponse,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  LocalVaultState,
} from './contracts.js';
import { FilesTransportEnvelopeService } from '@sulla/vault-crypto';
import { type SyncBundle, type SyncHead } from './browserEnvelope/envelope.js';
import { DomainVaultSyncCodecProvider } from './browserEnvelope/DomainVaultSyncCodecProvider.js';
import { StoredKeyEnvelopeReaderProvider } from './browserEnvelope/StoredKeyEnvelopeReaderProvider.js';
import type { VaultRelayManager } from './relays.js';
import type { Database, Queryable } from './db.js';
import { PostgresLocalAuthorityRepository } from './repositories/PostgresLocalAuthorityRepository.js';
import { PostgresRewrapHistoryRepository } from './repositories/PostgresRewrapHistoryRepository.js';
import { PostgresSullaCloudRevocationRepository } from './repositories/PostgresSullaCloudRevocationRepository.js';
import { AgentMailboxCloudLane } from './sullaCloudSession/AgentMailboxCloudLane.js';
import { SullaCloudSessionManager } from './sullaCloudSession/SullaCloudSessionManager.js';
import { PostgresVaultAuditLogRepository, PostgresVaultItemRepository } from './repositories/PostgresVaultItemRepositories.js';
import { PostgresIntegrationStateRepository, PostgresLegacyCredentialRepository, PostgresVaultMigrationRepository, PostgresVaultRecoveryRepository, PostgresVaultSyncStateRepository, PostgresVaultUserRepository } from './repositories/PostgresVaultAuthorityRepositories.js';
import { AuditFileSink } from './auditFileSink.js';
import { FilesAuditEmitter } from './filesAudit.js';
import { OutboundAuditRecorder } from './outboundAudit.js';
import { BrokerRedirectPolicy } from './brokerRedirectPolicy.js';
import { LocalVaultCryptoProvider } from './localCrypto/LocalVaultCryptoProvider.js';
import type { BootstrapUnlockService } from './localAuthority/BootstrapUnlockService.js';
import type { HumanSessionService } from './localAuthority/HumanSessionService.js';
import type { HumanItemService } from './localAuthority/HumanItemService.js';
import type { BitwardenImportService } from './localAuthority/BitwardenImportService.js';
import type { AccountPasswordService } from './localAuthority/AccountPasswordService.js';
import type { HumanRecoveryService } from './localAuthority/HumanRecoveryService.js';
import type { VaultEnrollmentService } from './localAuthority/VaultEnrollmentService.js';
import type { AgentItemWriter } from './localAuthority/AgentItemWriter.js';
import type { IntegrationAccountService } from './localAuthority/IntegrationAccountService.js';
import type { LegacyMigrationService } from './localAuthority/LegacyMigrationService.js';
import type { SullaCloudService } from './localAuthority/SullaCloudService.js';
import type { BrokerRelayService } from './localAuthority/BrokerRelayService.js';
import { LocalAuthorityCollaborators } from './localAuthority/LocalAuthorityCollaborators.js';
import type { LocalAuthorityHost } from './localAuthority/LocalAuthorityHost.js';
import type { VaultKeyActivation } from './localAuthority/VaultKeyActivation.js';
import { BrokerAddressPolicy } from './localAuthority/BrokerAddressPolicy.js';
import { BrokerCredentialFields } from './localAuthority/BrokerCredentialFields.js';
import { BrokerHttpBody } from './localAuthority/BrokerHttpBody.js';
import { LocalAuthorityCrypto } from './localAuthority/LocalAuthorityCrypto.js';
import {
  APPROVAL_TTL_MS,
  BROKER_IDENTIFIER_PATTERN,
  CACHE_UPDATE_TTL_MS,
  MAX_CREDENTIAL_BYTES,
  MAX_GIT_STREAM_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_STREAM_BYTES,
  UUID_PATTERN,
} from './localAuthority/LocalAuthorityLimits.js';
import type {
  BrokerStreamSink,
  Challenge,
  HumanSession,
  ItemRow,
  PreparedBrokerRequest,
  StagedCacheUpdate,
  UnlockedKeys,
} from './localAuthority/LocalAuthorityTypes.js';
import { LocalVaultError } from './localAuthority/LocalVaultError.js';
import { StreamingRedactor } from './localAuthority/StreamingRedactor.js';
import { SullaCloudDesktopRoutePolicy } from './localAuthority/SullaCloudDesktopRoutePolicy.js';

export { LocalVaultError } from './localAuthority/LocalVaultError.js';
export type { BrokerStreamSink } from './localAuthority/LocalAuthorityTypes.js';

/** @deprecated use BrokerCredentialFields.extractBoundedChatgptAccountId — E9 alias, removed in final cleanup */
export function extractBoundedChatgptAccountId(...tokens: unknown[]): string | undefined {
  return BrokerCredentialFields.extractBoundedChatgptAccountId(...tokens);
}

// Local names for the moved helpers so the method bodies below stay verbatim (E9).
const constantEqual = LocalAuthorityCrypto.constantEqual;
const operationDigest = LocalAuthorityCrypto.operationDigest;
const serializeBrokerBody = BrokerHttpBody.serializeBrokerBody;
const headerValue = BrokerHttpBody.headerValue;
const setContentType = BrokerHttpBody.setContentType;
const formFromObject = BrokerHttpBody.formFromObject;
const applyJsonPath = BrokerHttpBody.applyJsonPath;
const streamResponseIsBodyless = BrokerHttpBody.streamResponseIsBodyless;
const credentialField = BrokerCredentialFields.credentialField;
const proxySource = BrokerCredentialFields.proxySource;
const proxyHostMatches = BrokerCredentialFields.proxyHostMatches;
const deriveChatgptAccountRoutingForRequest = BrokerCredentialFields.deriveChatgptAccountRoutingForRequest;
const redact = BrokerCredentialFields.redact;
const privateAddress = BrokerAddressPolicy.privateAddress;
const allowsSullaCloudDesktopRequest = SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest;

export const localAuthorityTestHooks = {
  allowsByoUsageCloudRequest: SullaCloudDesktopRoutePolicy.allowsByoUsageCloudRequest,
  allowsSullaCloudDesktopRequest,
  credentialField,
  operationDigest,
  privateAddress,
  streamResponseIsBodyless,
  deriveChatgptAccountRoutingForRequest,
  StreamingRedactor,
};

/**
 * The local Desktop vault authority. It owns all vault state (unlocked keys, generation, grants,
 * challenges, in-flight requests) and the shared guards; the behaviour lives in collaborators
 * under ./localAuthority/ that receive this instance as their LocalAuthorityHost (E9). Members
 * without `private` below are the collaborator surface, not part of the HTTP-facing API.
 */
export class LocalVaultAuthority implements FilesAuthorityIdentityLease, LocalAuthorityHost {
  readonly filesTransport = new FilesTransportEnvelopeService();
  keys: UnlockedKeys | null = null;
  generation = 0;
  readonly inFlight = new Set<ReturnType<typeof https.request>>();
  readonly challenges = new Map<string, Challenge>();
  readonly cacheChallenges = new Map<string, Challenge>();
  readonly challengeRate = new Map<string, { count: number; resetAt: number }>();
  readonly pendingApprovals = new Map<string, number>();
  readonly pendingVaultEnrollments = new Map<string,{expiresAt:number;bundle:SyncBundle;head:SyncHead;userKey:Uint8Array;privateKey:Uint8Array;masterKey:Uint8Array;cloudUserId:string}>();
  readonly approvals = new Map<string, { digest: string; expiresAt: number }>();
  readonly humanSessions = new Map<string, HumanSession>();
  readonly oauthRefreshQueues = new Map<string, Promise<void>>();
  sullaCloudSessionManager: SullaCloudSessionManager | null = null;
  agentMailboxCloudLane: AgentMailboxCloudLane | null = null;
  readonly relaySessions = new Map<string, { generation: number; controller: AbortController }>();
  securityOperationTail: Promise<void> = Promise.resolve();
  migrationState: LocalVaultState = 'locked';
  stagedCacheUpdate: StagedCacheUpdate | null = null;
  readonly filesAudit: FilesAuditEmitter;
  readonly outboundAuditSink: AuditFileSink;
  readonly outboundAudit: OutboundAuditRecorder;
  codecProvider = new DomainVaultSyncCodecProvider();

  readonly brokerRedirectPolicy = new BrokerRedirectPolicy();
  /** Created on first use from `db`, so instances built without the constructor (specs) still work. */
  private localAuthorityRepository?: PostgresLocalAuthorityRepository;
  /** Created on first use for the same reason. */
  private collaborators?: LocalAuthorityCollaborators;

  constructor(
    readonly db: Database,
    readonly config: VaultConfig,
    readonly relayManager: VaultRelayManager = new DefaultVaultRelayManager(),
    readonly rewrapHistory: PostgresRewrapHistoryRepository = new PostgresRewrapHistoryRepository(db),
    readonly itemRepository: PostgresVaultItemRepository = new PostgresVaultItemRepository(db),
    readonly auditLogRepository: PostgresVaultAuditLogRepository = new PostgresVaultAuditLogRepository(db),
    readonly userRepository: PostgresVaultUserRepository = new PostgresVaultUserRepository(db),
    readonly recoveryRepository: PostgresVaultRecoveryRepository = new PostgresVaultRecoveryRepository(db),
    readonly integrationStateRepository: PostgresIntegrationStateRepository = new PostgresIntegrationStateRepository(db),
    readonly migrationRepository: PostgresVaultMigrationRepository = new PostgresVaultMigrationRepository(db),
    readonly syncStateRepository: PostgresVaultSyncStateRepository = new PostgresVaultSyncStateRepository(db),
    readonly legacyCredentialRepository: PostgresLegacyCredentialRepository = new PostgresLegacyCredentialRepository(),
    readonly keyEnvelopeReaderProvider: StoredKeyEnvelopeReaderProvider = new StoredKeyEnvelopeReaderProvider(),
    readonly revocationRepository: PostgresSullaCloudRevocationRepository = new PostgresSullaCloudRevocationRepository(db),
    readonly localCryptoProvider: LocalVaultCryptoProvider = new LocalVaultCryptoProvider(),
    readonly bitwardenImporter: BitwardenExportImporter = new BitwardenExportImporter(),
  ) {
    this.filesAudit = new FilesAuditEmitter(config);
    this.outboundAuditSink = new AuditFileSink({ dir: join(config.auditSpoolDir ?? '/var/lib/sulla-vault', 'audit-logs') });
    this.outboundAudit = new OutboundAuditRecorder(this.outboundAuditSink);
    const credentials = [
      ['bootstrap', config.bootstrapServiceToken],
      ['control', config.controlServiceToken],
      ['approval', config.approvalServiceToken],
      ['broker', config.brokerServiceToken],
      ['files', config.filesServiceToken],
    ] as const;
    for (const [name, value] of credentials) {
      if (!value || Buffer.byteLength(value) < 32) throw new Error(`Desktop vault ${ name } credential is not configured`);
    }
    if (new Set(credentials.map(([, value]) => value)).size !== credentials.length) {
      throw new Error('Desktop vault service credentials must be distinct');
    }
  }

  emitFilesAudit(event: Parameters<FilesAuditEmitter['emit']>[0]): void { this.filesAudit.emit(event); }

  get parts(): LocalAuthorityCollaborators {
    this.collaborators ??= new LocalAuthorityCollaborators(this);
    return this.collaborators;
  }

  get localStore(): PostgresLocalAuthorityRepository {
    this.localAuthorityRepository ??= new PostgresLocalAuthorityRepository(this.db);
    return this.localAuthorityRepository;
  }

  /** Seals one item for its `items` row (domain `LocalItemCipher`: fresh item key, AAD binds owner + item id). */
  async sealItem(plaintext: string, userKey: Uint8Array, context: LocalItemContext): Promise<LocalEncryptedItem> {
    return (await this.localCryptoProvider.get()).sealItem(plaintext, userKey, context);
  }

  /** Opens one `items` row to its exact UTF-8 plaintext. */
  async openItemText(item: LocalEncryptedItem, userKey: Uint8Array, context: LocalItemContext): Promise<string> {
    return (await this.localCryptoProvider.get()).openItemText(item, userKey, context);
  }

  status(): { state: LocalVaultState; unlocked: boolean; principalId?: string; cacheUpdateRequired: boolean } {
    this.expireStagedCacheUpdate();
    return {
      state: this.keys ? this.migrationState : 'locked',
      unlocked: Boolean(this.keys),
      principalId: this.keys?.userId,
      cacheUpdateRequired: Boolean(this.stagedCacheUpdate),
    };
  }

  createCacheUpdateChallenge(...args: Parameters<BootstrapUnlockService['createCacheUpdateChallenge']>) { return this.parts.bootstrap.createCacheUpdateChallenge(...args) }
  fetchCacheUpdate(...args: Parameters<BootstrapUnlockService['fetchCacheUpdate']>) { return this.parts.bootstrap.fetchCacheUpdate(...args) }
  createChallenge(...args: Parameters<BootstrapUnlockService['createChallenge']>) { return this.parts.bootstrap.createChallenge(...args) }
  unlock(...args: Parameters<BootstrapUnlockService['unlock']>) { return this.parts.bootstrap.unlock(...args) }
  unlockWithPassword(...args: Parameters<VaultKeyActivation['unlockWithPassword']>) { return this.parts.keyActivation.unlockWithPassword(...args) }
  activateMasterKey(...args: Parameters<VaultKeyActivation['activateMasterKey']>) { return this.parts.keyActivation.activateMasterKey(...args) }
  createHumanSession(...args: Parameters<HumanSessionService['createHumanSession']>) { return this.parts.humanSessions.createHumanSession(...args) }
  validateHumanSession(...args: Parameters<HumanSessionService['validateHumanSession']>) { return this.parts.humanSessions.validateHumanSession(...args) }
  unlockHumanSession(...args: Parameters<HumanSessionService['unlockHumanSession']>) { return this.parts.humanSessions.unlockHumanSession(...args) }
  exchangeHumanGrant(...args: Parameters<HumanSessionService['exchangeHumanGrant']>) { return this.parts.humanSessions.exchangeHumanGrant(...args) }
  humanSessionStatus(...args: Parameters<HumanSessionService['humanSessionStatus']>) { return this.parts.humanSessions.humanSessionStatus(...args) }
  lockHumanSession(...args: Parameters<HumanSessionService['lockHumanSession']>) { return this.parts.humanSessions.lockHumanSession(...args) }
  listHumanItems(...args: Parameters<HumanItemService['listHumanItems']>) { return this.parts.humanItems.listHumanItems(...args) }
  listHumanItemActivity(...args: Parameters<HumanItemService['listHumanItemActivity']>) { return this.parts.humanItems.listHumanItemActivity(...args) }
  revealHumanItem(...args: Parameters<HumanItemService['revealHumanItem']>) { return this.parts.humanItems.revealHumanItem(...args) }
  saveHumanItem(...args: Parameters<HumanItemService['saveHumanItem']>) { return this.parts.humanItems.saveHumanItem(...args) }
  deleteHumanItem(...args: Parameters<HumanItemService['deleteHumanItem']>) { return this.parts.humanItems.deleteHumanItem(...args) }
  previewBitwardenImport(...args: Parameters<BitwardenImportService['previewBitwardenImport']>) { return this.parts.bitwarden.previewBitwardenImport(...args) }
  importBitwarden(...args: Parameters<BitwardenImportService['importBitwarden']>) { return this.parts.bitwarden.importBitwarden(...args) }
  changeHumanPassword(...args: Parameters<AccountPasswordService['changeHumanPassword']>) { return this.parts.accountPasswords.changeHumanPassword(...args) }
  rewrapForAccountPassword(...args: Parameters<AccountPasswordService['rewrapForAccountPassword']>) { return this.parts.accountPasswords.rewrapForAccountPassword(...args) }
  rotateAccountRecoveryKey(...args: Parameters<HumanRecoveryService['rotateAccountRecoveryKey']>) { return this.parts.recovery.rotateAccountRecoveryKey(...args) }
  configureHumanRecovery(...args: Parameters<HumanRecoveryService['configureHumanRecovery']>) { return this.parts.recovery.configureHumanRecovery(...args) }
  recoverHumanSession(...args: Parameters<HumanRecoveryService['recoverHumanSession']>) { return this.parts.recovery.recoverHumanSession(...args) }
  exportHumanBackup(...args: Parameters<HumanRecoveryService['exportHumanBackup']>) { return this.parts.recovery.exportHumanBackup(...args) }
  importHumanBackup(...args: Parameters<HumanRecoveryService['importHumanBackup']>) { return this.parts.recovery.importHumanBackup(...args) }
  wrapVaultEnrollment(...args: Parameters<VaultEnrollmentService['wrapVaultEnrollment']>) { return this.parts.enrollment.wrapVaultEnrollment(...args) }
  adoptVaultEnrollment(...args: Parameters<VaultEnrollmentService['adoptVaultEnrollment']>) { return this.parts.enrollment.adoptVaultEnrollment(...args) }
  commitVaultEnrollment(...args: Parameters<VaultEnrollmentService['commitVaultEnrollment']>) { return this.parts.enrollment.commitVaultEnrollment(...args) }
  wrapUserKeyForApprovedDevice(...args: Parameters<VaultEnrollmentService['wrapUserKeyForApprovedDevice']>) { return this.parts.enrollment.wrapUserKeyForApprovedDevice(...args) }
  createAgentVaultItem(...args: Parameters<AgentItemWriter['createAgentVaultItem']>) { return this.parts.agentItems.createAgentVaultItem(...args) }
  updateAgentVaultItem(...args: Parameters<AgentItemWriter['updateAgentVaultItem']>) { return this.parts.agentItems.updateAgentVaultItem(...args) }
  setAgentIntegrationCredential(...args: Parameters<AgentItemWriter['setAgentIntegrationCredential']>) { return this.parts.agentItems.setAgentIntegrationCredential(...args) }
  backupCredentials(...args: Parameters<IntegrationAccountService['backupCredentials']>) { return this.parts.integrations.backupCredentials(...args) }
  integrationMetadata(...args: Parameters<IntegrationAccountService['integrationMetadata']>) { return this.parts.integrations.integrationMetadata(...args) }
  setActiveIntegrationAccount(...args: Parameters<IntegrationAccountService['setActiveIntegrationAccount']>) { return this.parts.integrations.setActiveIntegrationAccount(...args) }
  ensureOAuthAccount(...args: Parameters<IntegrationAccountService['ensureOAuthAccount']>) { return this.parts.integrations.ensureOAuthAccount(...args) }
  importDesktopIntegrationAccount(...args: Parameters<IntegrationAccountService['importDesktopIntegrationAccount']>) { return this.parts.integrations.importDesktopIntegrationAccount(...args) }
  migrateLegacy(...args: Parameters<LegacyMigrationService['migrateLegacy']>) { return this.parts.legacyMigration.migrateLegacy(...args) }
  adoptSullaCloudSession(...args: Parameters<SullaCloudService['adoptSullaCloudSession']>) { return this.parts.sullaCloud.adoptSullaCloudSession(...args) }
  clearSullaCloudSession(...args: Parameters<SullaCloudService['clearSullaCloudSession']>) { return this.parts.sullaCloud.clearSullaCloudSession(...args) }
  executeDesktopSullaCloudRequest(...args: Parameters<SullaCloudService['executeDesktopSullaCloudRequest']>) { return this.parts.sullaCloud.executeDesktopSullaCloudRequest(...args) }
  retryPendingSullaCloudRevocations(...args: Parameters<SullaCloudService['retryPendingSullaCloudRevocations']>) { return this.parts.sullaCloud.retryPendingSullaCloudRevocations(...args) }
  createRelay(...args: Parameters<BrokerRelayService['createRelay']>) { return this.parts.relays.createRelay(...args) }
  relayEvents(...args: Parameters<BrokerRelayService['relayEvents']>) { return this.parts.relays.relayEvents(...args) }
  sendRelay(...args: Parameters<BrokerRelayService['sendRelay']>) { return this.parts.relays.sendRelay(...args) }
  closeRelay(...args: Parameters<BrokerRelayService['closeRelay']>) { return this.parts.relays.closeRelay(...args) }

  /**
   * Lend a bounded copy of the unlocked user X25519 identity to another
   * Vault-owned component. Lock remains responsive while the operation is in
   * flight; generation checks prevent any result from escaping after a lock or
   * re-unlock, and the private-key copy is always erased.
   */
  async withUnlockedIdentity<T>(
    operation:(identity:UnlockedFilesAuthorityIdentity) => Promise<T>,
  ):Promise<T> {
    const keys = this.requireKeys();
    const generation = this.generation;
    const privateKey = Uint8Array.from(keys.privateKey);
    try {
      const result = await operation({
        principalId: keys.userId,
        publicKey: keys.publicKey,
        privateKey,
        generation,
        assertCurrent: () => this.requireGeneration(generation),
      });
      this.requireGeneration(generation);
      return result;
    } finally {
      privateKey.fill(0);
    }
  }

  /**
   * Lend the unlocked user key to the Passwords sync v3 runner
   * (browserEnvelope/syncRunner.ts) for one operation. Same generation guard
   * as withUnlockedIdentity: a lock during the operation fails it, and the
   * copy is erased afterwards.
   */
  async withUnlockedUserKey<T>(
    operation: (keys: { userId: string; userKey: Uint8Array; assertCurrent: () => void }) => Promise<T>,
  ): Promise<T> {
    const keys = this.requireKeys();
    const generation = this.generation;
    const userKey = Uint8Array.from(keys.userKey);
    try {
      const result = await operation({ userId: keys.userId, userKey, assertCurrent: () => this.requireGeneration(generation) });
      this.requireGeneration(generation);
      return result;
    } finally {
      userKey.fill(0);
    }
  }

  /** The Electron main approval identity (also used for Sulla Cloud relay). */
  requireApprovalIdentity(callerId: string, token: string | undefined): void {
    this.requireDesktopIdentity(callerId, token);
  }

  async lock(): Promise<void> {
    await this.runSecurityOperation(async() => this.lockNow());
  }

  lockNow(): void {
    this.generation += 1;
    for (const request of this.inFlight) request.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
    this.inFlight.clear();
    for (const relay of this.relaySessions.values()) relay.controller.abort(new Error('vault_locked'));
    this.relaySessions.clear();
    this.relayManager.closeAll('vault_locked');
    this.keys?.userKey.fill(0);
    this.keys?.privateKey.fill(0);
    this.keys?.legacyVmk?.fill(0);
    this.keys = null;
    this.migrationState = 'locked';
    this.challenges.clear();
    this.cacheChallenges.clear();
    this.challengeRate.clear();
    this.pendingApprovals.clear();
    this.approvals.clear();
    this.humanSessions.clear();
    this.stagedCacheUpdate?.masterKey.fill(0);
    this.stagedCacheUpdate = null;
  }

  /**
   * True while no vault user exists yet. The first password submitted to
   * /v1/human/unlock then creates the vault, so the page asks the person to
   * create a password (with confirmation) instead of unlocking one.
   */
  async isSetupRequired(): Promise<boolean> {
    const existing = await this.userRepository.existsActive();
    return !existing.rowCount;
  }

  requireControlIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.config.controlServiceId || !constantEqual(token, this.config.controlServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Desktop control identity is invalid');
    }
  }

  brokerStatus(callerId: string, token: string | undefined): {
    state: LocalVaultState; unlocked: boolean; principalId?: string;
  } {
    this.requireBrokerIdentity(callerId, token);
    const { state, unlocked, principalId } = this.status();
    return { state, unlocked, principalId };
  }

  requireDesktopIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.config.approvalServiceId || !constantEqual(token, this.config.approvalServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Desktop service identity is invalid');
    }
  }

  requireBrokerIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.config.brokerServiceId || !constantEqual(token, this.config.brokerServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Broker service identity is invalid');
    }
  }

  private validateBrokerRequestIdentity(input: BrokerExecuteRequest, callerId: string, token: string | undefined): void {
    this.requireBrokerIdentity(callerId, token);
    const claims = input?.claims;
    const validIdentifier = (value: unknown) => typeof value === 'string' && BROKER_IDENTIFIER_PATTERN.test(value);
    if (!input || typeof input.operation !== 'string' || !/^[a-z][a-z0-9_.:-]{1,79}$/i.test(input.operation) ||
        !claims || !UUID_PATTERN.test(claims.sub) || !validIdentifier(claims.agent_id) || !validIdentifier(claims.pod_id) ||
        (claims.org_id !== undefined && !UUID_PATTERN.test(claims.org_id)) ||
        (claims.thread_id !== undefined && !validIdentifier(claims.thread_id)) ||
        (claims.job_id !== undefined && !validIdentifier(claims.job_id)) ||
        (claims.workflow_execution_id !== undefined && !validIdentifier(claims.workflow_execution_id))) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller identity is invalid');
    }
    if (input.operation !== 'item.http' && input.ref?.itemId) {
      throw new LocalVaultError('policy_denied', 403, 'Direct item references are only accepted for item.http');
    }
    const scope = claims.credential_scope;
    if (scope && input.operation !== 'item.http' &&
        (!validIdentifier(scope.integration_id) || !validIdentifier(scope.account_id) || scope.item_id !== undefined)) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker integration scope is invalid');
    }
    if (scope && ((scope.integration_id !== undefined && !validIdentifier(scope.integration_id)) ||
        (scope.account_id !== undefined && !validIdentifier(scope.account_id)) ||
        (scope.item_id !== undefined && !UUID_PATTERN.test(scope.item_id)) ||
        (scope.repository !== undefined && !validIdentifier(scope.repository)))) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller scope is invalid');
    }
    const ref = input.ref;
    if (!ref || (ref.integrationId !== undefined && !validIdentifier(ref.integrationId)) ||
        (ref.accountId !== undefined && !validIdentifier(ref.accountId)) ||
        (ref.itemId !== undefined && !UUID_PATTERN.test(ref.itemId)) || !Array.isArray(input.injections)) {
      throw new LocalVaultError('invalid_operation', 400, 'Broker credential reference is invalid');
    }
  }

  approve(callerId: string, token: string | undefined, operationId: string): { approvalId: string; expiresAt: number } {
    if (callerId !== this.config.approvalServiceId || !constantEqual(token, this.config.approvalServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Approval service identity is invalid');
    }
    const pendingExpiry = this.pendingApprovals.get(operationId);
    this.pendingApprovals.delete(operationId);
    if (!pendingExpiry || pendingExpiry <= Date.now()) throw new LocalVaultError('approval_not_pending', 404, 'Approval request is not pending');
    const approvalId = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + APPROVAL_TTL_MS;
    this.approvals.set(approvalId, { digest: operationId, expiresAt });
    return { approvalId, expiresAt };
  }

  async execute(input: BrokerExecuteRequest, serviceId: string, token: string | undefined): Promise<BrokerExecuteResponse> {
    this.validateBrokerRequestIdentity(input, serviceId, token);
    try {
      if (input.responseType === 'stream' || input.responseType === 'binary-stream') {
        throw new LocalVaultError('invalid_operation', 400, 'Use execute-stream for streaming operations');
      }
      if (input.responseType === 'base64' && input.operation !== FILES_SYNC_OPERATION && input.operation !== 'provider.audio') {
        throw new LocalVaultError('invalid_operation', 400, 'Binary responses are limited to Files sync');
      }
      if (['oauth.exchange', 'oauth.adopt', 'oauth.refresh', 'oauth.revoke', 'oauth.register'].includes(input.operation)) {
        return await this.executeOAuthMutation(input, serviceId, token);
      }
      if (AgentMailboxCloudLane.handles(input.operation)) return await this.parts.sullaCloud.agentMailboxes().execute(input);
      const prepared = await this.prepareBrokerRequest(input, serviceId, token);
      const result = await this.send(
        prepared.target, input.method, prepared.headers, prepared.body,
        input.responseType ?? 'json', prepared.secrets, prepared.generation, true, prepared.maxRequestBytes,
        brokerTransferLimits(input.operation).response, input.operation, input.ref.integrationId,
      );
      if (prepared.item) await this.audit(input, prepared.item, false, null);
      return result;
    } catch (error) {
      if (error instanceof LocalVaultError) await this.auditBrokerDenial(input, error.code === 'invalid_upstream_response' ? `${ error.code }: ${ error.message }` : error.code);
      throw error;
    }
  }

  async listBrokerItems(
    claims: BrokerExecuteRequest['claims'], serviceId: string, token: string | undefined,
  ): Promise<BrokerItemListResponse> {
    this.requireBrokerIdentity(serviceId, token);
    const validIdentifier = (value: unknown) => typeof value === 'string' && BROKER_IDENTIFIER_PATTERN.test(value);
    if (!claims || !UUID_PATTERN.test(claims.sub) || !validIdentifier(claims.agent_id) || !validIdentifier(claims.pod_id)) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller identity is invalid');
    }
    const keys = this.requireKeys();
    const generation = this.generation;
    if (claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const result = await this.itemRepository.listAgentAccessiblePersonal<ItemRow>([keys.userId]);
    const items: BrokerItemListResponse['items'] = [];
    for (const row of result.rows) {
      const plaintext = JSON.parse(await this.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
        { itemId: row.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      const checked = validateVaultItemProxy(plaintext);
      if (!checked.ok) continue;
      const policy = row.agent_policy ?? plaintext.agentPolicy;
      if (!Array.isArray(policy?.sites)) continue;
      const usable = agentPolicyAllows({ ...policy, sites: [] }, {
        agentId: claims.agent_id, level: 'autofill', onServer: false,
      }).allowed;
      if (!usable) continue;
      items.push({
        id: row.id, name: plaintext.name, type: plaintext.type, hosts: checked.proxy.hosts,
        rules: checked.proxy.rules.map(({ target, name, scheme }) => ({ target, name, scheme })),
      });
    }
    this.requireGeneration(generation);
    return { items };
  }

  /** Serialize token mutations per integration account (refresh tokens rotate). */
  async withCredentialQueue<T>(ref: BrokerCredentialRef, operation: () => Promise<T>): Promise<T> {
    const queueKey = `${ ref.integrationId ?? '' }/${ ref.accountId ?? '' }`;
    const previous = this.oauthRefreshQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.oauthRefreshQueues.set(queueKey, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.oauthRefreshQueues.get(queueKey) === queued) this.oauthRefreshQueues.delete(queueKey);
    }
  }

  private async executeOAuthMutation(input: BrokerExecuteRequest, serviceId: string, token: string | undefined): Promise<BrokerExecuteResponse> {
    return this.withCredentialQueue(input.ref, async() => {
      const prepared = await this.prepareBrokerRequest(input, serviceId, token);
      const result = await this.send(
        prepared.target, input.method, prepared.headers, prepared.body,
        input.responseType === 'text' ? 'text' : 'json', prepared.secrets, prepared.generation, false,
        prepared.maxRequestBytes,
      );
      if (result.status < 200 || result.status >= 300) {
        // Status and the standard OAuth error code (e.g. invalid_grant) only, so the audit says why without copying response text.
        const oauthError = (result.body as { error?: unknown } | null)?.error;
        const code = typeof oauthError === 'string' && /^[a-z_]{1,64}$/.test(oauthError) ? ` ${ oauthError }` : '';
        throw new LocalVaultError('invalid_upstream_response', 502, `OAuth upstream rejected the request (HTTP ${ result.status }${ code })`);
      }
      return await this.runSecurityOperation(() => this.runTransaction(async(client) => {
        this.requireGeneration(prepared.generation);
        if (input.operation === 'oauth.revoke') {
          await this.clearOAuthTokens(prepared, client);
          await this.audit(input, prepared.item!, false, null, client);
          this.requireGeneration(prepared.generation);
          return { ...result, body: { revoked: true } };
        }
        if (input.operation === 'oauth.register') {
          const clientId = await this.storeOAuthRegistration(prepared, result.body, client);
          await this.audit(input, prepared.item!, false, null, client);
          this.requireGeneration(prepared.generation);
          return { ...result, body: { updated: true, operation: 'oauth.register', client_id: clientId } };
        }
        await this.storeOAuthTokens(prepared, result.body, client);
        await this.audit(input, prepared.item!, false, null, client);
        this.requireGeneration(prepared.generation);
        return { ...result, body: this.sanitizeOAuthResult(input.operation, result.body) };
      }));
    });
  }

  async executeStream(
    input: BrokerExecuteRequest,
    serviceId: string,
    token: string | undefined,
    sink: BrokerStreamSink,
  ): Promise<void> {
    this.validateBrokerRequestIdentity(input, serviceId, token);
    const streamInput = {
      ...input,
      responseType: input.responseType === 'binary-stream' ? 'binary-stream' as const : 'stream' as const,
    };
    try {
      const prepared = await this.prepareBrokerRequest(streamInput, serviceId, token);
      await this.sendStream(prepared, streamInput, sink);
      if (prepared.item) await this.audit(streamInput, prepared.item, false, null);
    } catch (error) {
      if (error instanceof LocalVaultError) {
        // invalid_upstream_response covers two distinct sendStream checks (compressed
        // encoding, non-textual content-type); fold in the observed header values so
        // audit_log says which one actually fired instead of just the shared code.
        const reason = error.code === 'invalid_upstream_response' ? `${ error.code }: ${ error.message }` : error.code;
        await this.auditBrokerDenial(streamInput, reason);
      }
      throw error;
    }
  }

  private async prepareBrokerRequest(
    input: BrokerExecuteRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<PreparedBrokerRequest> {
    this.validateBrokerRequestIdentity(input, serviceId, token);
    if (!/^[a-z][a-z0-9_.:-]{1,79}$/i.test(input.operation)) {
      throw new LocalVaultError('invalid_operation', 400, 'Broker operation is invalid');
    }
    const keys = this.requireKeys();
    const generation = this.generation;
    if (input.claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const target = await this.validateTarget(input.url);
    let catalogDecision = null;
    if (['catalog.http', 'mcp.http'].includes(input.operation)) {
      try {
        catalogDecision = await validateCatalogRequest(this.db, input, target);
      } catch {
        throw new LocalVaultError('policy_denied', 403, 'Registered catalog policy denied the request');
      }
    }
    if (catalogDecision?.credentialFree) {
      const scope = input.claims.credential_scope;
      if (!scope || scope.integration_id !== input.ref.integrationId || scope.account_id !== input.ref.accountId) {
        throw new LocalVaultError('policy_denied', 403, 'Public request is outside the signed caller scope');
      }
      this.requireGeneration(generation);
      return {
        target,
        headers: { ...(input.headers ?? {}), 'accept-encoding': 'identity' },
        body: input.body,
        secrets: [],
        generation,
        maxRequestBytes: MAX_RESPONSE_BYTES,
      };
    }
    const item = await this.loadBrokerItem(input, input.operation.startsWith('oauth.') ? null : target.hostname);
    const plaintext = JSON.parse(await this.openItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
      keys.userKey,
      { itemId: item.id, ownerId: item.collection_id ?? item.owner_user_id ?? keys.userId },
    )) as VaultItemPlaintext;
    const itemPolicy = item.agent_policy ?? plaintext.agentPolicy;
    if (input.operation === 'item.http') {
      const checked = validateVaultItemProxy(plaintext);
      if (!checked.ok) throw new LocalVaultError('policy_denied', 403, 'Vault item has no valid agent usage rules');
      try { validateItemHttpOperation(input) } catch (error) {
        const reason = error instanceof Error ? error.message : 'policy_denied';
        throw new LocalVaultError(reason === 'method_denied' ? 'method_denied' : 'invalid_injection', 403,
          reason === 'injection_denied' ? 'Caller-supplied injections are not allowed for item requests' : 'Item request is not allowed');
      }
      if (!checked.proxy.hosts.some(host => proxyHostMatches(target.hostname.toLowerCase(), host))) {
        throw new LocalVaultError('destination_denied', 403, `Vault item is not allowed on ${ target.hostname }`);
      }
      const decision = agentPolicyAllows(itemPolicy, {
        agentId: input.claims.agent_id, level: 'autofill', host: target.hostname, onServer: false,
      });
      if (!decision.allowed) throw new LocalVaultError('policy_denied', 403, decision.reason ?? 'Credential policy denied the operation');
      const digest = operationDigest(input);
      if (itemPolicy.askFirst) {
        const approval = input.approvalId ? this.approvals.get(input.approvalId) : undefined;
        if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
          if (input.approvalId) this.approvals.delete(input.approvalId);
          this.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
          throw new LocalVaultError('approval_required', 428, digest);
        }
        this.approvals.delete(input.approvalId!);
      }
      const ruleHeaderNames = new Set(checked.proxy.rules.map(rule => rule.name.toLowerCase()));
      ruleHeaderNames.add('authorization');
      const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([name]) => !ruleHeaderNames.has(name.toLowerCase())));
      headers['accept-encoding'] = 'identity';
      const secrets: string[] = [];
      const rememberSecret = (value: string) => {
        secrets.push(value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2));
      };
      for (const rule of checked.proxy.rules) {
        let value: string | undefined;
        if (rule.scheme === 'Basic') {
          if (typeof plaintext.username !== 'string' || typeof plaintext.password !== 'string') {
            throw new LocalVaultError('credential_field_missing', 404, 'Basic auth requires username and password');
          }
          if (Buffer.byteLength(plaintext.username) + Buffer.byteLength(plaintext.password) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('policy_denied', 403, 'Credential field exceeds the broker limit');
          value = `Basic ${ Buffer.from(`${ plaintext.username }:${ plaintext.password }`).toString('base64') }`;
          rememberSecret(plaintext.username);
          rememberSecret(plaintext.password);
          rememberSecret(Buffer.from(`${ plaintext.username }:${ plaintext.password }`).toString('base64'));
        } else {
          const source = proxySource(plaintext, rule.source);
          if (typeof source !== 'string') throw new LocalVaultError('credential_field_missing', 404, 'Agent usage source is unavailable');
          if (Buffer.byteLength(source) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('policy_denied', 403, 'Credential field exceeds the broker limit');
          value = rule.scheme === 'raw' ? source : `${ rule.scheme } ${ source }`;
          rememberSecret(source);
        }
        if (rule.target === 'header' && /[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new LocalVaultError('policy_denied', 403, 'Agent usage value is not a valid HTTP header');
        rememberSecret(value);
        if (rule.target === 'header') headers[rule.name] = value;
        else target.searchParams.set(rule.name, value);
      }
      this.requireGeneration(generation);
      return { target, headers, body: input.body, secrets, generation, maxRequestBytes: MAX_RESPONSE_BYTES, item, plaintext };
    }
    let effectivePolicy = itemPolicy;
    if (input.operation.startsWith('oauth.')) {
      try {
        await validateOAuthDestination(this.db, input, plaintext);
        effectivePolicy = { ...itemPolicy, sites: [target.hostname] };
      } catch {
        throw new LocalVaultError('destination_denied', 403, 'OAuth destination is not registered for this provider');
      }
    }
    // The Files service acts for the owner on their own Cloud account, so the
    // owner-only agent policy doesn't apply; its operation policy still does.
    const decision: { allowed: boolean; reason?: string } = isTrustedFilesCloudCall(input) ? { allowed: true } : agentPolicyAllows(effectivePolicy, {
      agentId: input.claims.agent_id,
      level: 'autofill',
      host: target.hostname,
      onServer: false,
    });
    if (!decision.allowed) throw new LocalVaultError('policy_denied', 403, decision.reason ?? 'Credential policy denied the operation');
    if (input.operation === 'enterprise.gateway.http') {
      const gatewayUrl = plaintext.integration?.properties.gateway_url;
      try {
        validateEnterpriseGatewayHttp(input, gatewayUrl ?? '');
      } catch {
        throw new LocalVaultError('destination_denied', 403, 'Enterprise gateway destination is not bound to this account');
      }
    }
    try {
      if (!catalogDecision) validateOperation(input, target.hostname, effectivePolicy);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'policy_denied';
      const code = reason === 'method_denied' ? 'method_denied' : reason === 'destination_denied' ? 'destination_denied' : 'policy_denied';
      throw new LocalVaultError(code, 403, 'Registered operation policy denied the request');
    }

    const digest = operationDigest(input);
    if ((item.agent_policy ?? plaintext.agentPolicy).askFirst) {
      const approval = input.approvalId ? this.approvals.get(input.approvalId) : undefined;
      if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
        if (input.approvalId) this.approvals.delete(input.approvalId);
        this.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
        throw new LocalVaultError('approval_required', 428, digest);
      }
      this.approvals.delete(input.approvalId!);
    }

    deriveChatgptAccountRoutingForRequest(input, plaintext);

    const secrets: string[] = [];
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    headers['accept-encoding'] = 'identity';
    let body: unknown = input.bodyEncoding === 'base64' && typeof input.body === 'string'
      ? Buffer.from(input.body, 'base64')
      : input.body;
    for (const injection of input.injections) {
      const value = credentialField(plaintext, injection.field) ??
        (input.operation.startsWith('sulla-cloud.') && injection.field === 'api_token'
          ? credentialField(plaintext, 'access_token')
          : undefined);
      if (typeof value !== 'string') throw new LocalVaultError('credential_field_missing', 404, 'Requested credential field is unavailable');
      if (Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('policy_denied', 403, 'Credential field exceeds the broker limit');
      secrets.push(value);
      const basicClientId = injection.scheme === 'BasicClient' ? credentialField(plaintext, 'client_id') : undefined;
      if (injection.scheme === 'BasicClient' && typeof basicClientId !== 'string') {
        throw new LocalVaultError('credential_field_missing', 404, 'OAuth client identity is unavailable');
      }
      const injected = injection.scheme === 'GitHubBasic'
        ? `Basic ${ Buffer.from(`x-access-token:${ value }`).toString('base64') }`
        : injection.scheme === 'BasicClient'
          ? `Basic ${ Buffer.from(`${ basicClientId }:${ value }`).toString('base64') }`
        : injection.scheme && injection.scheme !== 'raw' ? `${ injection.scheme } ${ value }` : value;
      secrets.push(injected);
      if (injection.target === 'header') {
        if (!/^[A-Za-z0-9-]+$/.test(injection.name)) throw new LocalVaultError('invalid_injection', 400, 'Invalid header injection name');
        headers[injection.name] = injected;
      } else if (injection.target === 'query') {
        target.searchParams.set(injection.name, injected);
      } else if (injection.target === 'form') {
        const form = body instanceof URLSearchParams
          ? body
          : typeof body === 'string' ? new URLSearchParams(body) : formFromObject(body);
        form.set(injection.name, injected);
        body = form;
        setContentType(headers, 'application/x-www-form-urlencoded');
      } else {
        body = applyJsonPath(body, injection.name, injected);
      }
    }
    // Public OAuth clients (PKCE, no secret) get no form injection, so an object body declared as a
    // form would otherwise go out as JSON; token endpoints like auth.x.ai reject that with a 415.
    const declaredType = headerValue(headers, 'content-type');
    if (declaredType && /^application\/x-www-form-urlencoded\b/i.test(declaredType) &&
        body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
      body = formFromObject(body);
      setContentType(headers, 'application/x-www-form-urlencoded');
    }
    if (input.operation === 'provider.transcription') {
      try {
        const transformed = buildTranscriptionProviderRequest(body, headers);
        body = transformed.body;
        for (const name of Object.keys(headers)) delete headers[name];
        Object.assign(headers, transformed.headers);
      } catch {
        throw new LocalVaultError('invalid_operation', 400, 'Transcription request is invalid');
      }
    }
    if (input.operation === 'oauth.register') setContentType(headers, 'application/json');
    this.requireGeneration(generation);
    return {
      target,
      headers,
      body,
      secrets,
      generation,
      maxRequestBytes: brokerTransferLimits(input.operation).request,
      item,
      plaintext,
    };
  }

  bootstrapToken(): string {
    if (!this.config.bootstrapServiceToken || Buffer.byteLength(this.config.bootstrapServiceToken) < 32) {
      throw new LocalVaultError('vault_unavailable', 503, 'Bootstrap identity is not configured');
    }
    return this.config.bootstrapServiceToken;
  }

  requireKeys(): UnlockedKeys {
    if (!this.keys) throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    return this.keys;
  }

  requireGeneration(generation: number): void {
    if (!this.keys || generation !== this.generation) {
      throw new LocalVaultError('vault_locked', 423, 'Vault locked during request');
    }
  }

  requireStableGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new LocalVaultError('vault_locked', 423, 'Vault state changed during request');
    }
  }

  runSecurityOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.securityOperationTail;
    let release!: () => void;
    this.securityOperationTail = new Promise<void>(resolve => { release = resolve; });
    return (async() => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  }

  async auditHumanAction(db: Queryable, actorId: string, action: string, itemId: string | null = null, path?: string): Promise<void> {
    await this.auditLogRepository.recordHumanAction([actorId, itemId, action], db);
    if (itemId) this.filesAudit.emit({ subjectKind: 'vault-secret', subjectId: itemId, action, actor: actorId, result: 'allowed', ...(path ? { path } : {}) });
  }

  async runTransaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.localStore.transaction(operation);
  }

  async validateTarget(raw: string): Promise<URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses: PinnedAddress[] }> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new LocalVaultError('invalid_destination', 400, 'Destination URL is invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new LocalVaultError('invalid_destination', 403, 'Destination must be HTTPS without credentials or fragments');
    }
    const pinnedAddresses = await this.resolvePinnedAddresses(url.hostname);
    return Object.assign(url, {
      pinnedAddress: pinnedAddresses[0].address,
      pinnedFamily: pinnedAddresses[0].family,
      pinnedAddresses,
    });
  }

  /**
   * Resolve and validate public addresses. Called per request (and again for
   * a connect retry); nothing is cached across requests, so a network change
   * never leaves a stale pin behind.
   */
  private async resolvePinnedAddresses(hostname: string, attempt = 1): Promise<PinnedAddress[]> {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      const detail = describeUpstreamError(error);
      const willRetry = detail.code === 'EAI_AGAIN' && attempt < UPSTREAM_MAX_ATTEMPTS;
      console.warn(formatUpstreamFailureLog({
        operation: 'dns.lookup', hostname, attempt, maxAttempts: UPSTREAM_MAX_ATTEMPTS, phase: 'dns', detail,
        families: 'none', reusedSocket: false, willRetry,
      }));
      if (willRetry) {
        await new Promise(resolve => setTimeout(resolve, UPSTREAM_RETRY_DELAYS_MS[attempt - 1]));
        return this.resolvePinnedAddresses(hostname, attempt + 1);
      }
      throw new LocalVaultError('upstream_failed', 502, 'Broker upstream DNS lookup failed', upstreamFailureReason('dns', detail.code));
    }
    if (!addresses.length || addresses.some(candidate => privateAddress(candidate.address))) {
      throw new LocalVaultError('destination_denied', 403, 'Destination resolved to a private, local, or invalid address');
    }
    return addresses.map(candidate => ({ address: candidate.address, family: candidate.family as 4 | 6 }));
  }

  /**
   * Open one upstream HTTPS request with connect-phase self-healing.
   *
   * A failure before the TLS handshake completes on a fresh socket means no
   * request bytes reached the upstream, so it is safe to re-resolve DNS and
   * try twice more (other address family first). Reused keep-alive sockets and
   * failures after the handshake are never retried. Every failure is logged
   * with its errno/syscall/family and surfaces a non-secret reason code.
   */
  private openUpstream(
    target: URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] },
    options: {
      operation:  string;
      method:     string;
      headers:    Record<string, string>;
      timeoutMs:  number;
      payload?:   Buffer;
      generation: number;
      failureMessage: string;
      timeoutError: () => LocalVaultError;
    },
    hooks: {
      onRequest(request: ClientRequest): void;
      onResponse(request: ClientRequest, response: IncomingMessage): void;
      onError(request: ClientRequest, error: LocalVaultError): void;
      canRetry?(): boolean;
    },
  ): void {
    const maxAttempts = UPSTREAM_MAX_ATTEMPTS;
    const start = (addresses: PinnedAddress[], attempt: number) => {
      let connected = false;
      let reusedSocket = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const clearConnectTimer = () => { if (connectTimer) clearTimeout(connectTimer); connectTimer = undefined };
      this.requireGeneration(options.generation);
      // Family-autoselection fields are honoured by net.connect but missing from http's option types.
      const requestOptions: https.RequestOptions & { autoSelectFamily?: boolean; autoSelectFamilyAttemptTimeout?: number } = {
        protocol: 'https:',
        hostname: target.hostname,
        servername: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${ target.pathname }${ target.search }`,
        method: options.method,
        headers: options.headers,
        timeout: options.timeoutMs,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: attempt === 1 ? UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS : UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS,
        lookup: addresses.length ? pinnedAddressesLookup(addresses) : pinnedLookup(target.pinnedAddress, target.pinnedFamily),
      };
      const request = https.request(requestOptions, response => hooks.onResponse(request, response));
      this.inFlight.add(request);
      hooks.onRequest(request);
      request.on('socket', socket => {
        if (request.reusedSocket) {
          connected = true;
          reusedSocket = true;
          return;
        }
        connectTimer = setTimeout(() => {
          request.destroy(Object.assign(new Error('Upstream connect timed out'), { code: 'UPSTREAM_CONNECT_TIMEOUT', syscall: 'connect' }));
        }, UPSTREAM_CONNECT_TIMEOUT_MS);
        connectTimer.unref?.();
        socket.once('secureConnect', () => { connected = true; clearConnectTimer() });
        socket.once('close', clearConnectTimer);
      });
      request.on('timeout', () => request.destroy(options.timeoutError()));
      request.on('error', error => {
        clearConnectTimer();
        this.inFlight.delete(request);
        if (error instanceof LocalVaultError) {
          hooks.onError(request, error);
          return;
        }
        const detail = describeUpstreamError(error);
        const phase = upstreamFailurePhase(detail.code, connected);
        const reason = upstreamFailureReason(phase, detail.code === 'UPSTREAM_CONNECT_TIMEOUT' ? 'timeout' : detail.code);
        const willRetry = attempt < maxAttempts && isReconnectableUpstreamError(error, connected) && (hooks.canRetry?.() ?? true);
        console.warn(formatUpstreamFailureLog({
          operation: options.operation, hostname: target.hostname, attempt, maxAttempts, phase, detail,
          families: familySummary(addresses), reusedSocket, willRetry,
        }));
        const failure = new LocalVaultError('upstream_failed', 502, options.failureMessage, reason);
        if (!willRetry) {
          hooks.onError(request, failure);
          return;
        }
        this.resolvePinnedAddresses(target.hostname).then(fresh => {
          if (!(hooks.canRetry?.() ?? true)) {
            hooks.onError(request, failure);
            return;
          }
          const retryAddresses = retryAddressOrder(fresh, detail.attempts.length ? detail.attempts : addresses.map(candidate => `v${ candidate.family }:${ detail.code }`));
          setTimeout(() => {
            if (!(hooks.canRetry?.() ?? true)) {
              hooks.onError(request, failure);
              return;
            }
            try {
              start(retryAddresses, attempt + 1);
            } catch (retryError) {
              hooks.onError(request, retryError instanceof LocalVaultError ? retryError : failure);
            }
          }, UPSTREAM_RETRY_DELAYS_MS[attempt - 1]);
        }).catch(resolveError => {
          hooks.onError(request, resolveError instanceof LocalVaultError ? resolveError : failure);
        });
      });
      if (options.payload) request.write(options.payload);
      request.end();
    };
    start(target.pinnedAddresses?.length ? [...target.pinnedAddresses] : [], 1);
  }

  async loadBrokerItem(input: BrokerExecuteRequest, host: string | null, bypassAgentPolicy = false): Promise<ItemRow> {
    const ref = input.ref ?? {};
    const scope = input.claims.credential_scope;
    if (input.operation === 'item.http') {
      if (!scope?.item_id || !ref.itemId || scope.item_id !== ref.itemId || scope.integration_id || scope.account_id || ref.integrationId || ref.accountId) {
        throw new LocalVaultError('policy_denied', 403, 'Vault item reference is outside the signed caller scope');
      }
    } else {
      if (!scope || !ref.integrationId || !ref.accountId ||
          scope.integration_id !== ref.integrationId || scope.account_id !== ref.accountId) {
        throw new LocalVaultError('policy_denied', 403, 'Credential reference is outside the signed caller scope');
      }
      if (ref.itemId) throw new LocalVaultError('policy_denied', 403, 'Direct item references are not accepted by the local broker');
    }
    if (input.operation === 'github.git') {
      const path = new URL(input.url).pathname;
      const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      const repository = match ? `${ match[1] }/${ match[2] }`.toLowerCase() : '';
      if (!scope.repository || repository !== scope.repository.replace(/\.git$/i, '').toLowerCase()) {
        throw new LocalVaultError('policy_denied', 403, 'Git repository is outside the signed caller scope');
      }
    }
    const integrationRef = ref.integrationId ? `${ ref.integrationId }/${ ref.accountId ?? 'default' }` : null;
    const result = await this.itemRepository.findBrokerCredential<ItemRow>([input.claims.sub, ref.itemId ?? null, integrationRef]);
    const item = result.rows[0];
    const personal = item?.owner_user_id === input.claims.sub;
    // Local authority has only the personal user key in memory. It must never
    // attempt to decrypt a collection item with that key; collection-key
    // custody remains a separate server-mode path until explicitly supported.
    if (!item || !personal || item.collection_id) {
      throw new LocalVaultError('policy_denied', 403, 'Credential is unavailable to this caller');
    }
    const trustedFirstParty = bypassAgentPolicy || isTrustedFilesCloudCall(input);
    if (host && input.operation !== 'item.http' && !trustedFirstParty) {
      const siteDecision = agentPolicyAllows(item.agent_policy, { agentId: input.claims.agent_id, level: 'autofill', host, onServer: false });
      if (!siteDecision.allowed) {
        throw new LocalVaultError('policy_denied', 403, siteDecision.reason ?? 'Credential policy denied the destination');
      }
    }
    return item;
  }

  private async sendStream(
    prepared: PreparedBrokerRequest,
    input: BrokerExecuteRequest,
    sink: BrokerStreamSink,
  ): Promise<void> {
    const method = input.method.toUpperCase();
    const blockedRequestHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'x-sulla-git-request-id']);
    const headers = Object.fromEntries(Object.entries(prepared.headers).filter(([name]) => !blockedRequestHeaders.has(name.toLowerCase())));
    headers['accept-encoding'] = 'identity';
    const streamLimit = input.operation === 'github.git' ? MAX_GIT_STREAM_BYTES : MAX_STREAM_BYTES;
    let payload: Buffer | undefined;
    if (prepared.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      payload = serializeBrokerBody(prepared.body);
      if (payload.byteLength > streamLimit) throw new LocalVaultError('request_too_large', 413, 'Broker request body is too large');
      headers['content-length'] = String(payload.byteLength);
    }
    const binary = input.responseType === 'binary-stream';
    const redactor = binary ? null : new StreamingRedactor(prepared.secrets);
    const requestedId = Object.entries(input.headers ?? {}).find(([name]) => name.toLowerCase() === 'x-sulla-git-request-id')?.[1];
    const requestId = typeof requestedId === 'string' && /^[0-9a-f-]{36}$/i.test(requestedId) ? requestedId : randomUUID();
    const startedAt = Date.now();
    let received = 0;
    let logged = false;
    let endedBy = 'unknown';
    let terminalReason: unknown;
    const target = new URL(prepared.target);
    const pathParts = target.pathname.split('/').filter(Boolean);
    const repository = target.hostname === 'github.com' && pathParts.length >= 2 ? `${ pathParts[0] }/${ pathParts[1].replace(/\.git$/, '') }` : 'unknown';
    const service = input.operation === 'github.git' ? (target.pathname.includes('git-receive-pack') ? 'receive-pack' : 'upload-pack') : input.operation;
    const logTermination = () => {
      if (logged) return;
      logged = true;
      const error = terminalReason instanceof Error ? { name: terminalReason.name, code: (terminalReason as NodeJS.ErrnoException).code, message: prepared.secrets.reduce((message, secret) => secret ? message.split(secret).join('[secret redacted]') : message, terminalReason.message) } : terminalReason;
      console.info(JSON.stringify({ component: 'vault.broker.stream', requestId, repository, service, startedAt: new Date(startedAt).toISOString(), bytesReceived: received, durationMs: Date.now() - startedAt, endedBy, ...(error ? { reason: error } : {}) }));
    };
    if (binary) console.info(JSON.stringify({ component: 'vault.broker.stream', requestId, repository, service, startedAt: new Date(startedAt).toISOString(), event: 'start' }));

    await new Promise<void>((resolve, reject) => {
      let started = false;
      let aborted = false;
      let current: ClientRequest | undefined;
      sink.onAbort(() => {
        aborted = true;
        endedBy = 'downstream-abort';
        terminalReason = 'broker client disconnected';
        current?.destroy(new LocalVaultError('upstream_failed', 499, 'Broker client disconnected'));
      });
      this.openUpstream(prepared.target, {
        operation: input.operation,
        method,
        headers,
        timeoutMs: 120_000,
        payload,
        generation: prepared.generation,
        failureMessage: 'Broker upstream stream failed',
        timeoutError: () => new LocalVaultError('upstream_timeout', 504, 'Broker stream timed out'),
      }, {
        canRetry: () => !aborted && !started,
        onRequest: request => {
          current = request;
          if (aborted) request.destroy(new LocalVaultError('upstream_failed', 499, 'Broker client disconnected'));
        },
        onError: (_request, safe) => {
          if (endedBy === 'unknown') endedBy = safe instanceof Error && /timed out/i.test(safe.message) ? 'vault-timeout' : 'upstream-error';
          terminalReason = safe;
          if (started) {
            sink.destroy(safe);
            logTermination();
            resolve();
          } else {
            logTermination();
            reject(safe);
          }
        },
        onResponse: (request, response) => {
          if (prepared.generation !== this.generation) {
            response.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
            return;
          }
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            if (typeof location === 'string' && this.brokerRedirectPolicy.allowsGitHubLogRedirect({
              operation: input.operation, integrationId: input.ref.integrationId, requestUrl: prepared.target,
              status: response.statusCode, location,
            })) {
              response.resume();
              started = true;
              sink.start(302, { location });
              this.inFlight.delete(request);
              sink.end();
              endedBy = 'upstream-redirect';
              logTermination();
              resolve();
              return;
            }
            response.resume();
            request.destroy(new LocalVaultError('redirect_denied', 403, 'Broker redirects are disabled'));
            return;
          }
          const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
          const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (contentEncoding && contentEncoding !== 'identity') {
            response.resume();
            request.destroy(new LocalVaultError('invalid_upstream_response', 502, `Compressed broker streams are not accepted (content-encoding: ${ contentEncoding })`));
            return;
          }
          const bodyless = streamResponseIsBodyless(method, response.statusCode ?? 0, response.headers['content-length']);
          // Untyped bodies still pass through the redactor; providers (chatgpt.com)
          // send untyped error replies, and blocking them hid the real status.
          if (!binary && !bodyless && contentType && !contentType.startsWith('text/') && !contentType.includes('json') && !contentType.includes('event-stream') && !contentType.includes('ndjson')) {
            response.resume();
            request.destroy(new LocalVaultError('invalid_upstream_response', 502, `Streaming adapter requires a textual upstream response (status: ${ response.statusCode ?? 'none' }, content-type: ${ contentType })`));
            return;
          }
          const blockedResponseHeaders = /^(set-cookie|cookie|authorization|proxy-authenticate|www-authenticate|x-api-key|content-length)$/i;
          const outputHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (!blockedResponseHeaders.test(name) && typeof value === 'string') outputHeaders[name] = redact(value, prepared.secrets);
          }
          if (binary && typeof response.headers['content-length'] === 'string') outputHeaders['content-length'] = response.headers['content-length'];
          started = true;
          sink.start(response.statusCode ?? 502, outputHeaders);
          response.on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > streamLimit) {
              request.destroy(new LocalVaultError('response_too_large', 502, 'Broker stream exceeded the size limit'));
              return;
            }
            const output = redactor ? redactor.transform(chunk) : chunk;
            if (output.byteLength && !sink.write(output)) {
              response.pause();
              sink.onceDrain(() => response.resume());
            }
          });
          response.on('end', () => {
            try { this.requireGeneration(prepared.generation); } catch (error) { endedBy = 'vault-generation-change'; terminalReason = error; request.destroy(error as Error); return; }
            const tail = redactor?.flush();
            if (tail?.byteLength) sink.write(tail);
            this.inFlight.delete(request);
            sink.end();
            endedBy = 'upstream-end';
            logTermination();
            resolve();
          });
          response.on('error', error => { endedBy = 'upstream-response-error'; terminalReason = error; request.destroy(error); });
        },
      });
    });
  }

  async send(
    url: URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] },
    methodInput: string,
    headersInput: Record<string, string>,
    bodyInput: unknown,
    responseType: 'json' | 'text' | 'base64',
    secrets: string[],
    generation: number,
    redactResponseBody = true,
    maxRequestBytes = MAX_RESPONSE_BYTES,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    operation = 'broker.request',
    integrationId?: string,
  ): Promise<BrokerExecuteResponse> {
    const method = methodInput.toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new LocalVaultError('method_denied', 403, 'HTTP method is not allowed');
    }
    const blockedRequestHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);
    const headers = Object.fromEntries(Object.entries(headersInput).filter(([name]) => !blockedRequestHeaders.has(name.toLowerCase())));
    headers['accept-encoding'] = 'identity';
    let payload: Buffer | undefined;
    if (bodyInput !== undefined && method !== 'GET' && method !== 'HEAD') {
      payload = serializeBrokerBody(bodyInput);
      if (payload.byteLength > maxRequestBytes) throw new LocalVaultError('request_too_large', 413, 'Broker request body is too large');
      headers['content-length'] = String(payload.byteLength);
      if (!headerValue(headers, 'content-type')) {
        headers['content-type'] = Buffer.isBuffer(bodyInput)
          ? 'application/octet-stream'
          : bodyInput instanceof URLSearchParams ? 'application/x-www-form-urlencoded'
            : typeof bodyInput === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
      }
    }

    return new Promise<BrokerExecuteResponse>((resolve, reject) => {
      this.openUpstream(url, {
        operation: 'broker.request',
        method,
        headers,
        timeoutMs: 30_000,
        payload,
        generation,
        failureMessage: 'Broker upstream request failed',
        timeoutError: () => new LocalVaultError('upstream_timeout', 504, 'Broker request timed out'),
      }, {
        onRequest: () => undefined,
        onError: (_request, error) => reject(error),
        onResponse: (request, response) => {
          if (generation !== this.generation) {
            response.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
            return;
          }
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            if (typeof location === 'string' && this.brokerRedirectPolicy.allowsGitHubLogRedirect({
              operation, integrationId, requestUrl: url,
              status: response.statusCode, location,
            })) {
              response.resume();
              this.inFlight.delete(request);
              resolve({ status: 302, headers: { location }, body: '' });
              return;
            }
            response.resume();
            reject(new LocalVaultError('redirect_denied', 403, 'Broker redirects are disabled'));
            return;
          }
          const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (contentEncoding && contentEncoding !== 'identity') {
            response.resume();
            request.destroy(new LocalVaultError('invalid_upstream_response', 502, 'Compressed broker responses are not accepted'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > maxResponseBytes) request.destroy(new LocalVaultError('response_too_large', 502, 'Broker response exceeded the size limit'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            try { this.requireGeneration(generation); } catch (error) { reject(error); return; }
            if (responseType === 'base64') {
              // Binary bodies cannot be redacted in place, so one that echoes a credential is refused outright.
              const bytes = Buffer.concat(chunks);
              if (secrets.some(secret => secret && bytes.includes(Buffer.from(secret)))) {
                reject(new LocalVaultError('invalid_upstream_response', 502, 'Upstream response echoed a credential'));
                return;
              }
              const binaryHeaders: Record<string, string> = {};
              for (const name of ['content-type', 'content-length', 'x-content-sha256']) {
                const value = response.headers[name];
                if (typeof value === 'string') binaryHeaders[name] = value;
              }
              this.inFlight.delete(request);
              resolve({ status: response.statusCode ?? 502, headers: binaryHeaders, body: bytes.toString('base64') });
              return;
            }
            const upstream = Buffer.concat(chunks).toString('utf8');
            const raw = redactResponseBody ? redact(upstream, secrets) : upstream;
            const blockedResponseHeaders = /^(set-cookie|cookie|authorization|proxy-authenticate|www-authenticate|x-api-key)$/i;
            const outputHeaders: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (!blockedResponseHeaders.test(name) && typeof value === 'string') outputHeaders[name] = redact(value, secrets);
            }
            let body: unknown = raw;
            if (responseType === 'json' && raw) {
              // Error responses are often plain text; keep them so the caller sees the real HTTP status.
              const ok = (response.statusCode ?? 502) >= 200 && (response.statusCode ?? 502) < 300;
              try { body = JSON.parse(raw); } catch {
                if (ok) { reject(new LocalVaultError('invalid_upstream_response', 502, 'Expected a JSON response')); return; }
              }
            }
            this.inFlight.delete(request);
            resolve({ status: response.statusCode ?? 502, headers: outputHeaders, body });
          });
        },
      });
    });
  }

  private async storeOAuthTokens(prepared: PreparedBrokerRequest, body: unknown, db: Queryable): Promise<void> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth token response is invalid');
    }
    const response = body as Record<string, unknown>;
    if (typeof response.access_token !== 'string' || !response.access_token) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth response did not contain an access token');
    }
    const keys = this.requireKeys();
    this.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext) throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    const integration = prepared.plaintext.integration;
    if (!integration) throw new LocalVaultError('migration_failed', 409, 'OAuth item is missing its integration reference');
    integration.properties.access_token = response.access_token;
    if (typeof response.refresh_token === 'string' && response.refresh_token) integration.properties.refresh_token = response.refresh_token;
    if (typeof response.expires_in === 'number') integration.properties.expires_in = String(response.expires_in);
    if (typeof response.expires_in === 'number') integration.properties.expires_at = String(Date.now() + Math.max(0, response.expires_in) * 1000);
    if (typeof response.scope === 'string') integration.properties.scope = response.scope;
    if (typeof response.token_type === 'string') integration.properties.token_type = response.token_type;
    if (typeof response.id_token === 'string' && response.id_token) integration.properties.id_token = response.id_token;
    const chatgptAccountId = extractBoundedChatgptAccountId(response.id_token, response.access_token);
    if (chatgptAccountId) integration.properties.chatgpt_account_id = chatgptAccountId;
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
  }

  private async storeOAuthRegistration(prepared: PreparedBrokerRequest, body: unknown, db: Queryable): Promise<string> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response is invalid');
    }
    const response = body as Record<string, unknown>;
    if (typeof response.client_id !== 'string' || response.client_id.length < 1 || response.client_id.length > 4096) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response did not contain a valid client identity');
    }
    const keys = this.requireKeys();
    this.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext?.integration) {
      throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    }
    prepared.plaintext.integration.properties.oauth_client_id = response.client_id;
    for (const field of ['client_secret', 'registration_access_token'] as const) {
      const value = response[field];
      if (value !== undefined && (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES)) {
        throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response contained invalid secret material');
      }
      if (typeof value === 'string') prepared.plaintext.integration.properties[field] = value;
    }
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
    return response.client_id;
  }

  private async clearOAuthTokens(prepared: PreparedBrokerRequest, db: Queryable): Promise<void> {
    const keys = this.requireKeys();
    this.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext?.integration) {
      throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    }
    for (const field of ['access_token', 'refresh_token', 'id_token', 'chatgpt_account_id', 'expires_in', 'expires_at', 'scope', 'token_type']) {
      delete prepared.plaintext.integration.properties[field];
    }
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
  }

  private async persistOAuthItem(
    prepared: Pick<PreparedBrokerRequest, 'item' | 'plaintext' | 'generation'>, keys: UnlockedKeys,
    db: Queryable,
  ): Promise<number> {
    if (!prepared.item || !prepared.plaintext) throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    const ownerId = prepared.item.collection_id ?? prepared.item.owner_user_id ?? keys.userId;
    const encrypted = await this.sealItem(JSON.stringify(prepared.plaintext), keys.userKey, {
      itemId: prepared.item.id,
      ownerId,
    });
    this.requireGeneration(prepared.generation);
    const updated = await this.itemRepository.updateOAuthCiphertextIfRevision([encrypted.ciphertext, encrypted.encryptedItemKey, prepared.item.id, prepared.item.revision], db);
    if (!updated.rowCount) throw new LocalVaultError('migration_failed', 409, 'OAuth item changed during token update');
    this.requireGeneration(prepared.generation);
    return Number(updated.rows[0].revision);
  }

  private sanitizeOAuthResult(operation: string, body: unknown): Record<string, unknown> {
    const response = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    return {
      updated:    true,
      operation,
      expires_in: typeof response.expires_in === 'number' ? response.expires_in : undefined,
      expires_at: typeof response.expires_in === 'number' ? Date.now() + Math.max(0, response.expires_in) * 1000 : undefined,
      scope:      typeof response.scope === 'string' ? response.scope : undefined,
      token_type: typeof response.token_type === 'string' ? response.token_type : undefined,
    };
  }

  stageCacheUpdate(masterKey: Uint8Array): void {
    this.stagedCacheUpdate?.masterKey.fill(0);
    this.cacheChallenges.clear();
    this.stagedCacheUpdate = {
      masterKey: Buffer.from(masterKey),
      expiresAt: Date.now() + CACHE_UPDATE_TTL_MS,
      generation: this.generation,
    };
  }

  expireStagedCacheUpdate(): void {
    if (this.stagedCacheUpdate &&
        (this.stagedCacheUpdate.expiresAt <= Date.now() || this.stagedCacheUpdate.generation !== this.generation)) {
      this.stagedCacheUpdate.masterKey.fill(0);
      this.stagedCacheUpdate = null;
      this.cacheChallenges.clear();
    }
  }

  /** Agent credential use goes to the rotating file sink, never Postgres or the Files per-secret audit, and never as a reveal. */
  async audit(
    input: BrokerExecuteRequest,
    item: ItemRow,
    blocked: boolean,
    reason: string | null,
    _db?: Queryable,
  ): Promise<void> {
    this.outboundAudit.record({
      actorUserId: input.claims.sub, orgId: item.org_id ?? null, collectionId: item.collection_id, itemId: item.id,
      podId: input.claims.pod_id, agentId: input.claims.agent_id, operation: input.operation,
      destination: input.operation === 'item.http' ? new URL(input.url).hostname : new URL(input.url).origin,
      blocked, reason,
    });
  }

  private async auditBrokerDenial(input: BrokerExecuteRequest, reason: string): Promise<void> {
    let destination: string | undefined;
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') destination = input.operation === 'item.http' ? parsed.hostname : parsed.origin;
    } catch {
      // Invalid destinations are represented by the denial reason, never copied into audit metadata.
    }
    this.outboundAudit.record({
      actorUserId: input.claims.sub, podId: input.claims.pod_id, agentId: input.claims.agent_id, operation: input.operation,
      ...(input.operation === 'item.http' && UUID_PATTERN.test(input.ref?.itemId ?? '') ? { itemId: input.ref.itemId } : {}),
      ...(destination ? { destination } : {}),
      blocked: true, reason,
    });
  }
}


