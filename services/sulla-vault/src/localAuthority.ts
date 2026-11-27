// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type https from 'node:https';
import { join } from 'node:path';

import type pg from 'pg';
import type { LocalEncryptedItem, LocalItemContext } from '@sulla/domain';

import { BitwardenExportImporter } from './bitwarden/BitwardenExportImporter.js';
import { DefaultVaultRelayManager } from './relays.js';

import type { VaultConfig } from './config.js';
import type { FilesAuthorityIdentityLease, UnlockedFilesAuthorityIdentity } from './filesKeyBundleAuthority.js';
import type { LocalVaultState } from './contracts.js';
import { FilesTransportEnvelopeService } from '@sulla/vault-crypto';
import { DomainVaultSyncCodecProvider } from './browserEnvelope/DomainVaultSyncCodecProvider.js';
import { StoredKeyEnvelopeReaderProvider } from './browserEnvelope/StoredKeyEnvelopeReaderProvider.js';
import type { VaultRelayManager } from './relays.js';
import type { Database, Queryable } from './db.js';
import { VaultRepositories } from './repositories/VaultRepositories.js';
import { VaultProfileSessionFactory } from './profiles/VaultProfileSessionFactory.js';
import { AgentMailboxCloudLane } from './sullaCloudSession/AgentMailboxCloudLane.js';
import { SullaCloudSessionManager } from './sullaCloudSession/SullaCloudSessionManager.js';
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
import type { BrokerExecutionService } from './localAuthority/BrokerExecutionService.js';
import type { ServiceIdentityGuard } from './localAuthority/ServiceIdentityGuard.js';
import type { CacheUpdateStager } from './localAuthority/CacheUpdateStager.js';
import { LocalAuthorityCollaborators } from './localAuthority/LocalAuthorityCollaborators.js';
import type { LocalAuthorityHost, LocalAuthoritySeam, LocalAuthorityVaultSecrets } from './localAuthority/LocalAuthorityHost.js';
import type { VaultKeyActivation } from './localAuthority/VaultKeyActivation.js';
import { BrokerAddressPolicy } from './localAuthority/BrokerAddressPolicy.js';
import { BrokerCredentialFields } from './localAuthority/BrokerCredentialFields.js';
import { BrokerHttpBody } from './localAuthority/BrokerHttpBody.js';
import { LocalAuthorityCrypto } from './localAuthority/LocalAuthorityCrypto.js';
import type { UnlockedKeys } from './localAuthority/LocalAuthorityTypes.js';
import { LocalVaultError } from './localAuthority/LocalVaultError.js';
import { StreamingRedactor } from './localAuthority/StreamingRedactor.js';
import { SullaCloudDesktopRoutePolicy } from './localAuthority/SullaCloudDesktopRoutePolicy.js';
import { ProfileScopedMap } from './profiles/ProfileScopedMap.js';

export { LocalVaultError } from './localAuthority/LocalVaultError.js';
export type { BrokerStreamSink } from './localAuthority/LocalAuthorityTypes.js';

/** @deprecated use BrokerCredentialFields.extractBoundedChatgptAccountId — E9 alias, removed in final cleanup */
export function extractBoundedChatgptAccountId(...tokens: unknown[]): string | undefined {
  return BrokerCredentialFields.extractBoundedChatgptAccountId(...tokens);
}

/** Pure helpers exposed for specs (same functions as before E9, now static methods that never use `this`). */
export const localAuthorityTestHooks = {
  allowsByoUsageCloudRequest:             SullaCloudDesktopRoutePolicy.allowsByoUsageCloudRequest,
  allowsSullaCloudDesktopRequest:         SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest,
  credentialField:                        BrokerCredentialFields.credentialField,
  operationDigest:                        LocalAuthorityCrypto.operationDigest,
  privateAddress:                         BrokerAddressPolicy.privateAddress,
  streamResponseIsBodyless:               BrokerHttpBody.streamResponseIsBodyless,
  deriveChatgptAccountRoutingForRequest:  BrokerCredentialFields.deriveChatgptAccountRoutingForRequest,
  StreamingRedactor,
};

/**
 * The local Desktop vault authority. It owns all vault state (unlocked keys, generation, grants,
 * challenges, in-flight requests) and the shared guards; the behaviour lives in collaborators
 * under ./localAuthority/ that receive this instance as their LocalAuthorityHost (E9). Key material
 * and grants (LocalAuthorityVaultSecrets) are `private`: only the collaborators reach them, through
 * collaboratorHost(). Other members without `private` are the collaborator surface, not part of the
 * HTTP-facing API.
 */
export class LocalVaultAuthority implements FilesAuthorityIdentityLease, LocalAuthoritySeam {
  readonly filesTransport = new FilesTransportEnvelopeService();
  private readonly keysByProfile = new Map<string, NonNullable<LocalAuthorityVaultSecrets['keys']>>();
  generation = 0;
  readonly inFlight = new Set<ReturnType<typeof https.request>>();
  private readonly challenges!: LocalAuthorityVaultSecrets['challenges'];
  private readonly cacheChallenges!: LocalAuthorityVaultSecrets['cacheChallenges'];
  private readonly challengeRate!: LocalAuthorityVaultSecrets['challengeRate'];
  private readonly pendingApprovals!: LocalAuthorityVaultSecrets['pendingApprovals'];
  private readonly pendingClerkApprovals!: LocalAuthorityVaultSecrets['pendingClerkApprovals'];
  private readonly pendingVaultEnrollments!: LocalAuthorityVaultSecrets['pendingVaultEnrollments'];
  private readonly approvals!: LocalAuthorityVaultSecrets['approvals'];
  private readonly humanSessions!: LocalAuthorityVaultSecrets['humanSessions'];
  readonly oauthRefreshQueues!: Map<string, Promise<void>>;
  sullaCloudSessionManager: SullaCloudSessionManager | null = null;
  agentMailboxCloudLane: AgentMailboxCloudLane | null = null;
  private readonly relaySessions!: LocalAuthorityVaultSecrets['relaySessions'];
  securityOperationTail: Promise<void> = Promise.resolve();
  migrationState: LocalVaultState = 'locked';
  private readonly stagedCacheUpdates = new Map<string, NonNullable<LocalAuthorityVaultSecrets['stagedCacheUpdate']>>();
  readonly filesAudit: FilesAuditEmitter;
  readonly outboundAuditSink: AuditFileSink;
  readonly outboundAudit: OutboundAuditRecorder;
  codecProvider = new DomainVaultSyncCodecProvider();

  readonly brokerRedirectPolicy = new BrokerRedirectPolicy();
  /** Created on first use for the same reason. */
  private collaborators?: LocalAuthorityCollaborators;

  private get keys(): LocalAuthorityVaultSecrets['keys'] {
    return this.keysByProfile.get(this.repositories.session.context.profileId) ?? null;
  }

  private set keys(value: LocalAuthorityVaultSecrets['keys']) {
    const profileId = this.repositories.session.context.profileId;
    if (value) this.keysByProfile.set(profileId, value);
    else this.keysByProfile.delete(profileId);
  }

  private get stagedCacheUpdate(): LocalAuthorityVaultSecrets['stagedCacheUpdate'] {
    return this.stagedCacheUpdates.get(this.repositories.session.context.profileId) ?? null;
  }

  private set stagedCacheUpdate(value: LocalAuthorityVaultSecrets['stagedCacheUpdate']) {
    const profileId = this.repositories.session.context.profileId;
    if (value) this.stagedCacheUpdates.set(profileId, value);
    else this.stagedCacheUpdates.delete(profileId);
  }

  get rewrapHistory() { return this.repositories.rewrapHistory; }
  get itemRepository() { return this.repositories.items; }
  get auditLogRepository() { return this.repositories.auditLog; }
  get userRepository() { return this.repositories.users; }
  get recoveryRepository() { return this.repositories.recovery; }
  get integrationStateRepository() { return this.repositories.integrationState; }
  get migrationRepository() { return this.repositories.migration; }
  get syncStateRepository() { return this.repositories.syncState; }
  get legacyCredentialRepository() { return this.repositories.legacyCredentials; }
  get revocationRepository() { return this.repositories.revocations; }
  get localStore() { return this.repositories.localAuthority; }

  constructor(
    readonly db: Database,
    readonly config: VaultConfig,
    readonly relayManager: VaultRelayManager = new DefaultVaultRelayManager(),
    repositories: VaultRepositories = new VaultRepositories(
      new VaultProfileSessionFactory(db, config.profileProvisioningEnabled ?? false).legacy(),
    ),
    readonly keyEnvelopeReaderProvider: StoredKeyEnvelopeReaderProvider = new StoredKeyEnvelopeReaderProvider(),
    readonly localCryptoProvider: LocalVaultCryptoProvider = new LocalVaultCryptoProvider(),
    readonly bitwardenImporter: BitwardenExportImporter = new BitwardenExportImporter(),
  ) {
    this.repositories = repositories;
    const profileId = repositories.session.context.profileId;
    this.challenges = new ProfileScopedMap(profileId);
    this.cacheChallenges = new ProfileScopedMap(profileId);
    this.challengeRate = new ProfileScopedMap(profileId);
    this.pendingApprovals = new ProfileScopedMap(profileId);
    this.pendingClerkApprovals = new ProfileScopedMap(profileId);
    this.pendingVaultEnrollments = new ProfileScopedMap(profileId);
    this.approvals = new ProfileScopedMap(profileId);
    this.humanSessions = new ProfileScopedMap(profileId);
    this.oauthRefreshQueues = new ProfileScopedMap(profileId);
    this.relaySessions = new ProfileScopedMap(profileId);
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

  private repositories: VaultRepositories;

  /** The repository registry this authority is bound to; route composition must share it, never build a second one. */
  get vaultRepositories(): VaultRepositories { return this.repositories; }

  get profileContext() { return this.repositories.session.context; }

  assertProfileCurrent(profileId: string, generation: this['profileContext']['generation']): void {
    const active = this.repositories.session.context;
    if (active.profileId !== profileId || active.generation.value !== generation.value) throw new LocalVaultError('vault_locked', 423, 'Vault profile changed during operation');
    this.repositories.session.assertCurrent();
  }

  /** Erase this profile's in-memory secrets on lock without retiring its query fence. */
  lockProfileSecrets(profileId: string): void {
    if (this.repositories.session.context.profileId !== profileId) return;
    this.keys?.userKey.fill(0);
    this.keys?.privateKey.fill(0);
    this.keys?.legacyVmk?.fill(0);
    this.keys = null;
    this.keysByProfile.delete(profileId);
    this.stagedCacheUpdate?.masterKey.fill(0);
    this.stagedCacheUpdate = null;
    this.stagedCacheUpdates.delete(profileId);
    this.parts.enrollment.discardAllPendingEnrollments();
    this.challenges.clear();
    this.cacheChallenges.clear();
    this.challengeRate.clear();
    this.pendingApprovals.clear();
    this.pendingClerkApprovals.clear();
    this.approvals.clear();
    this.humanSessions.clear();
    this.oauthRefreshQueues.clear();
    for (const relay of this.relaySessions.values()) relay.controller.abort(new Error('vault_locked'));
    this.relaySessions.clear();
    this.relayManager.closeAll('vault_locked');
    this.agentMailboxCloudLane = null;
    this.sullaCloudSessionManager = null;
  }

  /** Retire a profile's query session during an explicit profile switch. */
  retireProfileSession(profileId: string): void {
    if (this.repositories.session.context.profileId !== profileId) return;
    this.lockProfileSecrets(profileId);
    this.repositories.session.invalidate();
  }

  emitFilesAudit(event: Parameters<FilesAuditEmitter['emit']>[0]): void { this.filesAudit.emit(event); }

  get parts(): LocalAuthorityCollaborators {
    this.collaborators ??= new LocalAuthorityCollaborators(this.collaboratorHost());
    return this.collaborators;
  }

  /**
   * @internal The collaborator view of this instance: the public seam plus the private vault
   * secrets. Handed only to LocalAuthorityCollaborators; never returned to callers.
   */
  private collaboratorHost(): LocalAuthorityHost {
    return this as unknown as LocalAuthorityHost;
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
  integrationMetadataForAgent(...args: Parameters<IntegrationAccountService['integrationMetadataForAgent']>) { return this.parts.integrations.integrationMetadataForAgent(...args) }
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
  withUnlockedIdentity<T>(operation: (identity: UnlockedFilesAuthorityIdentity) => Promise<T>): Promise<T> { return this.parts.keyLender.withUnlockedIdentity(operation) }
  withUnlockedUserKey<T>(operation: (keys: { userId: string; userKey: Uint8Array; assertCurrent: () => void }) => Promise<T>): Promise<T> {
    return this.parts.keyLender.withUnlockedUserKey(operation);
  }
  approve(...args: Parameters<BrokerExecutionService['approve']>) { return this.parts.brokerExecution.approve(...args) }
  execute(...args: Parameters<BrokerExecutionService['execute']>) { return this.parts.brokerExecution.execute(...args) }
  listBrokerItems(...args: Parameters<BrokerExecutionService['listBrokerItems']>) { return this.parts.brokerExecution.listBrokerItems(...args) }
  executeStream(...args: Parameters<BrokerExecutionService['executeStream']>) { return this.parts.brokerExecution.executeStream(...args) }
  requireControlIdentity(...args: Parameters<ServiceIdentityGuard['requireControlIdentity']>) { return this.parts.identities.requireControlIdentity(...args) }
  requireApprovalIdentity(...args: Parameters<ServiceIdentityGuard['requireApprovalIdentity']>) { return this.parts.identities.requireApprovalIdentity(...args) }
  requireDesktopIdentity(...args: Parameters<ServiceIdentityGuard['requireDesktopIdentity']>) { return this.parts.identities.requireDesktopIdentity(...args) }
  requireBrokerIdentity(...args: Parameters<ServiceIdentityGuard['requireBrokerIdentity']>) { return this.parts.identities.requireBrokerIdentity(...args) }
  bootstrapToken(...args: Parameters<ServiceIdentityGuard['bootstrapToken']>) { return this.parts.identities.bootstrapToken(...args) }
  stageCacheUpdate(...args: Parameters<CacheUpdateStager['stageCacheUpdate']>) { return this.parts.cacheStager.stageCacheUpdate(...args) }
  expireStagedCacheUpdate(...args: Parameters<CacheUpdateStager['expireStagedCacheUpdate']>) { return this.parts.cacheStager.expireStagedCacheUpdate(...args) }

  async lock(): Promise<void> {
    await this.runSecurityOperation(async() => this.lockNow());
  }

  lockNow(): void {
    this.generation += 1;
    for (const request of this.inFlight) request.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
    this.inFlight.clear();
    this.lockProfileSecrets(this.repositories.session.context.profileId);
    this.migrationState = 'locked';
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

  brokerStatus(callerId: string, token: string | undefined): {
    state: LocalVaultState; unlocked: boolean; principalId?: string;
  } {
    this.requireBrokerIdentity(callerId, token);
    const { state, unlocked, principalId } = this.status();
    return { state, unlocked, principalId };
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
}

