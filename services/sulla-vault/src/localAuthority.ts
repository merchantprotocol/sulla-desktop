// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes } from 'node:crypto';
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
import { brokerTransferLimits, FILES_SYNC_OPERATION } from './operationPolicy.js';
import { DefaultVaultRelayManager } from './relays.js';

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
const streamResponseIsBodyless = BrokerHttpBody.streamResponseIsBodyless;
const credentialField = BrokerCredentialFields.credentialField;
const deriveChatgptAccountRoutingForRequest = BrokerCredentialFields.deriveChatgptAccountRoutingForRequest;
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
    this.parts.brokerRequests.validateBrokerRequestIdentity(input, serviceId, token);
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
      const prepared = await this.parts.brokerRequests.prepareBrokerRequest(input, serviceId, token);
      const result = await this.parts.upstream.send(
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
      const prepared = await this.parts.brokerRequests.prepareBrokerRequest(input, serviceId, token);
      const result = await this.parts.upstream.send(
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
    this.parts.brokerRequests.validateBrokerRequestIdentity(input, serviceId, token);
    const streamInput = {
      ...input,
      responseType: input.responseType === 'binary-stream' ? 'binary-stream' as const : 'stream' as const,
    };
    try {
      const prepared = await this.parts.brokerRequests.prepareBrokerRequest(streamInput, serviceId, token);
      await this.parts.streams.sendStream(prepared, streamInput, sink);
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


