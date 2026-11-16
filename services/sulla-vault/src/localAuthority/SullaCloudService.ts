// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { IdentityError } from '@sulla/domain';
import type { VaultItemPlaintext } from '@sulla/vault-crypto';

import type {
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerRelayCreateRequest,
  BrokerRelayCreateResponse,
  SullaCloudDesktopRequest,
  SullaCloudSessionAdoptRequest,
  SullaCloudSessionResponse,
} from '../contracts.js';
import { createRelayId } from '../relays.js';
import { SULLA_CLOUD_HOST, SULLA_CLOUD_INTEGRATION_ID, sullaCloudRelayUrl, validateSullaCloudRelayParams } from '../sullaCloudRelay.js';
import { AgentMailboxCloudLane } from '../sullaCloudSession/AgentMailboxCloudLane.js';
import type { SullaCloudSessionManager } from '../sullaCloudSession/SullaCloudSessionManager.js';
import { SullaCloudSessionManagerFactory } from '../sullaCloudSession/SullaCloudSessionManagerFactory.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { APPROVAL_TTL_MS, MAX_CREDENTIAL_BYTES, MAX_FILES_SYNC_UPLOAD_BYTES, MAX_RESPONSE_BYTES, MAX_STREAM_BYTES } from './LocalAuthorityLimits.js';
import type { ItemRow } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';
import { SullaCloudDesktopRoutePolicy } from './SullaCloudDesktopRoutePolicy.js';

/**
 * The owner's Sulla Cloud session inside the vault: token adoption and sign-out, refresh-ahead
 * access tokens, allowlisted Desktop requests, agent mailboxes and the Cloud relay room.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class SullaCloudService {
  constructor(private readonly host: LocalAuthorityHost) {}

  /**
   * Adopt tokens returned by Desktop's fixed-host Sulla Cloud authentication
   * flow. This deliberately uses the Desktop approval identity rather than
   * the general tools broker identity, and never returns secret material.
   */
  async adoptSullaCloudSession(
    callerId: string, token: string | undefined, input: SullaCloudSessionAdoptRequest,
  ): Promise<SullaCloudSessionResponse> {
    this.host.requireDesktopIdentity(callerId, token);
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const identifier = /^[A-Za-z0-9._:@-]{1,200}$/;
    if (!input || !identifier.test(input.userId) || !identifier.test(input.activeContractorId) ||
        typeof input.accessToken !== 'string' || !input.accessToken || Buffer.byteLength(input.accessToken) > MAX_CREDENTIAL_BYTES ||
        typeof input.refreshToken !== 'string' || !input.refreshToken || Buffer.byteLength(input.refreshToken) > MAX_CREDENTIAL_BYTES ||
        !Array.isArray(input.contractors) || input.contractors.length > 100) {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud session is invalid');
    }
    // The token is received only from the hard-coded Sulla Cloud HTTPS origin.
    // Bind the handoff to that authenticated identity and reject opaque,
    // expired, unsigned, or differently-subjected JWTs.
    let claims: Record<string, unknown>;
    try {
      const parts = input.accessToken.split('.');
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error('malformed');
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      if (header.alg === 'none' || typeof header.alg !== 'string') throw new Error('unsigned');
    } catch {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud access token is invalid');
    }
    const subjects = [claims.sub, claims.userId, claims.user_id, claims.contractorId, claims.contractor_id]
      .filter((value): value is string => typeof value === 'string');
    if (!subjects.includes(input.userId) && !subjects.includes(input.activeContractorId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud token subject does not match the session');
    }
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud access token is expired');
    }
    const contractorIds = input.contractors.map(contractor => contractor?.id);
    if (contractorIds.some(id => typeof id !== 'string' || !identifier.test(id)) ||
        (contractorIds.length > 0 && !contractorIds.includes(input.activeContractorId))) {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud contractor identity is invalid');
    }
    const policy = {
      mode: 'only_me' as const, level: 'metadata' as const, agents: [], sites: [], expiresAt: null,
      askFirst: false, allowServerAgents: false,
    };
    const itemId = randomUUID();
    const plaintext: VaultItemPlaintext = {
      type: 'apiKey', name: 'Sulla Cloud', agentPolicy: policy,
      integration: {
        integrationId: SULLA_CLOUD_INTEGRATION_ID,
        accountId: input.userId,
        properties: {
          access_token: input.accessToken, refresh_token: input.refreshToken,
          user_id: input.userId, active_contractor_id: input.activeContractorId,
          contractors_json: JSON.stringify(input.contractors), connection_status: 'connected',
        },
      },
    };
    const encrypted = await this.host.sealItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
    await this.host.runSecurityOperation(() => this.host.runTransaction(async client => {
      this.host.requireGeneration(generation);
      await this.host.itemRepository.softDeleteIntegrationAccounts([keys.userId, SULLA_CLOUD_INTEGRATION_ID], client);
      await this.host.itemRepository.insertSullaCloudAccount([itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, policy,
          `${ SULLA_CLOUD_INTEGRATION_ID }/${ input.userId }`], client);
      await this.host.integrationStateRepository.upsertCloud(keys.userId, SULLA_CLOUD_INTEGRATION_ID, input.userId, client);
      await this.host.auditHumanAction(client, keys.userId, 'sulla_cloud_session_adopted', itemId);
      this.host.requireGeneration(generation);
    }));
    this.sullaCloudSessions().sessionAdopted();
    this.retryPendingSullaCloudRevocations();
    return { userId: input.userId, activeContractorId: input.activeContractorId };
  }

  /**
   * Sign out: revoke the refresh token on Sulla Cloud with the copy the vault holds (queued durably when offline),
   * then destroy the stored token ciphertext. The token never crosses into Electron.
   */
  async clearSullaCloudSession(callerId: string, token: string | undefined): Promise<{ cleared: number; remoteRevoked: boolean; queued: boolean }> {
    this.host.requireDesktopIdentity(callerId, token);
    this.host.requireKeys();
    const result = await this.sullaCloudSessions().signOut();
    return { cleared: 1, remoteRevoked: result.remoteRevoked, queued: result.queued };
  }

  async executeDesktopSullaCloudRequest(
    callerId: string, token: string | undefined, input: SullaCloudDesktopRequest,
  ): Promise<BrokerExecuteResponse> {
    this.host.requireDesktopIdentity(callerId, token);
    const keys = this.host.requireKeys();
    const method = String(input?.method ?? '').toUpperCase();
    let target: URL;
    try { target = new URL(input.path, `https://${ SULLA_CLOUD_HOST }`); } catch {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud request path is invalid');
    }
    if (target.origin !== `https://${ SULLA_CLOUD_HOST }` || input.path !== `${ target.pathname }${ target.search }`) {
      throw new LocalVaultError('destination_denied', 403, 'Sulla Cloud request must use an allowlisted relative path');
    }
    if (!SullaCloudDesktopRoutePolicy.allowsSullaCloudDesktopRequest(method, target.pathname)) {
      throw new LocalVaultError('policy_denied', 403, 'Sulla Cloud request path or method is not allowlisted');
    }
    const state = await this.host.integrationStateRepository.findActive<{ active_account_id: string }>(keys.userId, SULLA_CLOUD_INTEGRATION_ID);
    const accountId = state.rows[0]?.active_account_id;
    if (!accountId) throw new LocalVaultError('credential_field_missing', 404, 'Sulla Cloud session is unavailable; sign in again');
    const request: BrokerExecuteRequest = {
      claims: {
        sub: keys.userId, agent_id: 'sulla-desktop-main', pod_id: 'desktop-main',
        credential_scope: { integration_id: SULLA_CLOUD_INTEGRATION_ID, account_id: accountId },
      },
      operation: 'sulla-cloud.desktop', ref: { integrationId: SULLA_CLOUD_INTEGRATION_ID, accountId },
      url: target.toString(), method, headers: {}, body: input.body, bodyEncoding: input.bodyEncoding,
      injections: [], responseType: input.responseType ?? 'json',
    };
    const { credential, item } = await this.freshSullaCloudAccessToken(request, true);
    const allowedHeaders = new Set(['accept', 'content-type', 'x-sulla-timestamp', 'x-sulla-device-signature', 'x-sulla-support-token']);
    const headers = Object.fromEntries(Object.entries(input.headers ?? {})
      .filter(([name, value]) => allowedHeaders.has(name.toLowerCase()) && typeof value === 'string'));
    headers.authorization = `Bearer ${ credential }`;
    const body = input.bodyEncoding === 'base64' && typeof input.body === 'string' ? Buffer.from(input.body, 'base64') : input.body;
    const pinned = await this.host.parts.upstream.validateTarget(target.toString());
    const result = await this.host.parts.upstream.send(
      pinned, method, headers, body, input.responseType ?? 'json', [credential], this.host.generation, true,
      target.pathname.endsWith('/bundle') ? MAX_STREAM_BYTES : /^\/files-sync\/v1\/uploads\//.test(target.pathname) ? MAX_FILES_SYNC_UPLOAD_BYTES : MAX_RESPONSE_BYTES,
    );
    await this.host.parts.brokerAudit.audit(request, item, false, null);
    return result;
  }

  /** Agent mail on the owner's Cloud session: path-pinned, vault-refreshed, Bearer injected here only. */
  agentMailboxes(): AgentMailboxCloudLane {
    this.host.agentMailboxCloudLane ??= new AgentMailboxCloudLane(SULLA_CLOUD_HOST, {
      activeAccountId: async() => {
        const keys = this.host.requireKeys();
        const state = await this.host.integrationStateRepository.findActive<{ active_account_id: string }>(keys.userId, SULLA_CLOUD_INTEGRATION_ID);
        return state.rows[0]?.active_account_id ?? null;
      },
      accessToken: request => this.freshSullaCloudAccessToken(request, true),
    }, {
      send: async(request, target, headers, secrets) => this.host.parts.upstream.send(
        await this.host.parts.upstream.validateTarget(target.toString()), request.method, headers, request.body, 'json', secrets, this.host.generation, true,
        MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, request.operation, SULLA_CLOUD_INTEGRATION_ID,
      ),
      audit: (request, item) => this.host.parts.brokerAudit.audit(request, item as ItemRow, false, null),
    }, (code, status, message) => new LocalVaultError(code, status, message));
    return this.host.agentMailboxCloudLane;
  }

  private sullaCloudSessions(): SullaCloudSessionManager {
    this.host.sullaCloudSessionManager ??= new SullaCloudSessionManagerFactory({
      userKey: () => { const keys = this.host.requireKeys(); return { userId: keys.userId, userKey: keys.userKey }; },
      generation: () => this.host.generation,
      requireGeneration: generation => this.host.requireGeneration(generation),
      transaction: work => this.host.runSecurityOperation(() => this.host.runTransaction(work)),
      auditHumanAction: (client, userId, action, itemId) => this.host.auditHumanAction(client, userId, action, itemId ?? null),
    }, {
      items: this.host.itemRepository, state: this.host.integrationStateRepository, revocations: this.host.revocationRepository,
      serialize: (name, work) => this.host.parts.brokerExecution.withCredentialQueue({ integrationId: SULLA_CLOUD_INTEGRATION_ID, accountId: name }, work),
      postJson: async(url, body) => {
        const result = await this.host.parts.upstream.send(await this.host.parts.upstream.validateTarget(url), 'POST', { 'content-type': 'application/json' }, body, 'json', [body.refreshToken], this.host.generation, false);
        return { status: result.status, body: result.body };
      },
    }).create();
    return this.host.sullaCloudSessionManager;
  }

  /** Offline sign-outs queue their revoke; it is retried after unlock and after the next sign-in. Never blocks or throws. */
  retryPendingSullaCloudRevocations(): void {
    this.sullaCloudSessions().retryPendingRevocations().catch(() => undefined);
  }

  async createSullaCloudRelay(input: BrokerRelayCreateRequest): Promise<BrokerRelayCreateResponse> {
    let params: ReturnType<typeof validateSullaCloudRelayParams>;
    try {
      params = validateSullaCloudRelayParams(input.params);
    } catch {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud relay parameters are invalid');
    }
    if (input.ref?.integrationId !== SULLA_CLOUD_INTEGRATION_ID) {
      throw new LocalVaultError('policy_denied', 403, 'Relay operation is not registered for this integration');
    }
    const request: BrokerExecuteRequest = {
      claims: input.claims,
      operation: input.operation,
      ref: input.ref,
      url: `https://${ SULLA_CLOUD_HOST }/vault-relay`,
      method: 'GET',
      headers: {},
      body: null,
      injections: [],
      approvalId: input.approvalId,
      responseType: 'json',
    };
    const generation = this.host.generation;
    const trustedDesktopRelay = input.claims.agent_id === 'sulla' && input.claims.pod_id === 'desktop-relay';
    const { credential, item } = await this.freshSullaCloudAccessToken(request, trustedDesktopRelay);
    let targetUrl: string;
    try {
      targetUrl = sullaCloudRelayUrl(params, credential).toString();
    } catch {
      throw new LocalVaultError('policy_denied', 403, 'Relay room does not match the signed-in Sulla Cloud account');
    }
    const relayId = createRelayId();
    const controller = new AbortController();
    this.host.relaySessions.set(relayId, { generation, controller });
    try {
      const handle = await this.host.relayManager.open({
        relayId, operation: input.operation, credential, targetUrl, abortSignal: controller.signal,
      });
      this.host.requireGeneration(generation);
      await this.host.parts.brokerAudit.audit(request, item, false, null);
      return handle;
    } catch (error) {
      controller.abort(error);
      this.host.relaySessions.delete(relayId);
      this.host.relayManager.close(relayId, 'open_failed');
      if (error instanceof LocalVaultError) throw error;
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'relay_unauthorized') {
        throw new LocalVaultError('upstream_failed', 401, 'Sulla Cloud rejected the relay session; sign in again');
      }
      throw new LocalVaultError('upstream_failed', 502, 'Sulla Cloud relay is unreachable');
    }
  }

  /** Returns a usable access token, refreshing (and persisting the rotation) inside the vault. */
  private async freshSullaCloudAccessToken(request: BrokerExecuteRequest, trustedDesktopPath = false): Promise<{ credential: string; item: ItemRow }> {
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    if (request.claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const item = await this.host.parts.brokerRequests.loadBrokerItem(request, SULLA_CLOUD_HOST, trustedDesktopPath);
    const plaintext = JSON.parse(await this.host.openItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
      keys.userKey,
      { itemId: item.id, ownerId: item.owner_user_id ?? keys.userId },
    )) as VaultItemPlaintext;
    const policy = item.agent_policy ?? plaintext.agentPolicy;
    if (policy.askFirst) {
      const digest = LocalAuthorityCrypto.operationDigest(request);
      const approval = request.approvalId ? this.host.approvals.get(request.approvalId) : undefined;
      if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
        if (request.approvalId) this.host.approvals.delete(request.approvalId);
        this.host.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
        throw new LocalVaultError('approval_required', 428, digest);
      }
      this.host.approvals.delete(request.approvalId!);
    }
    // Refresh-ahead, single-flight and compare-and-set live in ClientSessionService over the vault item.
    let credential: string | null;
    try {
      credential = await this.sullaCloudSessions().accessToken();
    } catch (error) {
      if (error instanceof LocalVaultError) throw error;
      if (error instanceof IdentityError && error.identityCode === 'refresh_transient') {
        throw new LocalVaultError('upstream_failed', 502, 'Sulla Cloud token refresh failed');
      }
      throw new LocalVaultError('invalid_upstream_response', 502, 'Sulla Cloud token refresh response is invalid');
    }
    this.host.requireGeneration(generation);
    if (!credential) throw new LocalVaultError('upstream_failed', 401, 'Sulla Cloud session expired; sign in again');
    return { credential, item };
  }
}
