// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes } from 'node:crypto';

import { validateVaultItemProxy, type VaultItemPlaintext } from '@sulla/vault-crypto';

import { brokerTransferLimits, FILES_SYNC_OPERATION } from '../operationPolicy.js';
import { AgentPolicyGate } from './AgentPolicyGate.js';
import { ClerkAuthority } from './ClerkAuthority.js';
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';
import { APPROVAL_TTL_MS, BROKER_IDENTIFIER_PATTERN, UUID_PATTERN } from './LocalAuthorityLimits.js';
import { LocalVaultError } from './LocalVaultError.js';
import { AgentMailboxCloudLane } from '../sullaCloudSession/AgentMailboxCloudLane.js';

import type { BrokerCredentialRef, BrokerExecuteRequest, BrokerExecuteResponse, BrokerItemListResponse } from '../contracts.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import type { BrokerStreamSink, ItemRow } from './LocalAuthorityTypes.js';

/**
 * The broker's HTTP entry points: one-shot and streamed execution, OAuth token mutations
 * serialized per account, agent-usable item listing and ask-first approvals.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class BrokerExecutionService {
  private readonly staleRefreshWarnings = new Set<string>();
  constructor(private readonly host: LocalAuthorityHost, private readonly now: () => number = Date.now) {}

  approve(callerId: string, token: string | undefined, operationId: string): { approvalId: string; expiresAt: number } {
    if (callerId !== this.host.config.approvalServiceId || !LocalAuthorityCrypto.constantEqual(token, this.host.config.approvalServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Approval service identity is invalid');
    }
    const clerkPending = this.host.pendingClerkApprovals.get(operationId);
    if (clerkPending) {
      this.host.pendingClerkApprovals.delete(operationId);
      if (clerkPending.expiresAt <= this.now()) throw new LocalVaultError('approval_not_pending', 404, 'Approval request is not pending');
      const approvalId = randomBytes(32).toString('base64url');
      // The grant inherits the pending attempt's expiry: approving never extends the original window.
      const expiresAt = clerkPending.expiresAt;
      this.host.approvals.set(approvalId, { digest: clerkPending.digest, clerkOperationId: operationId, expiresAt });
      return { approvalId, expiresAt };
    }
    const pendingExpiry = this.host.pendingApprovals.get(operationId);
    this.host.pendingApprovals.delete(operationId);
    if (!pendingExpiry || pendingExpiry <= this.now()) throw new LocalVaultError('approval_not_pending', 404, 'Approval request is not pending');
    const approvalId = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + APPROVAL_TTL_MS;
    this.host.approvals.set(approvalId, { digest: operationId, expiresAt });
    return { approvalId, expiresAt };
  }

  async execute(input: BrokerExecuteRequest, serviceId: string, token: string | undefined, signal?: AbortSignal): Promise<BrokerExecuteResponse> {
    this.host.parts.brokerRequests.validateBrokerRequestIdentity(input, serviceId, token);
    try {
      if (input.operation === 'clerk.backend') return await new ClerkAuthority(this.host).execute(input, signal);
      if (input.responseType === 'stream' || input.responseType === 'binary-stream') {
        throw new LocalVaultError('invalid_operation', 400, 'Use execute-stream for streaming operations');
      }
      if (input.responseType === 'base64' && input.operation !== FILES_SYNC_OPERATION && input.operation !== 'provider.audio') {
        throw new LocalVaultError('invalid_operation', 400, 'Binary responses are limited to Files sync');
      }
      if (['oauth.exchange', 'oauth.adopt', 'oauth.refresh', 'oauth.revoke', 'oauth.register'].includes(input.operation)) {
        return await this.executeOAuthMutation(input, serviceId, token);
      }
      if (AgentMailboxCloudLane.handles(input.operation)) return await this.host.parts.sullaCloud.agentMailboxes().execute(input);
      const prepared = await this.host.parts.brokerRequests.prepareBrokerRequest(input, serviceId, token);
      const result = await this.host.parts.upstream.send(
        prepared.target, input.method, prepared.headers, prepared.body,
        input.responseType ?? 'json', prepared.secrets, prepared.generation, true, prepared.maxRequestBytes,
        brokerTransferLimits(input.operation).response, input.operation, input.ref.integrationId,
      );
      if (prepared.item) await this.host.parts.brokerAudit.audit(input, prepared.item, false, null);
      return result;
    } catch (error) {
      if (error instanceof LocalVaultError) await this.host.parts.brokerAudit.auditBrokerDenial(input, error.code === 'invalid_upstream_response' ? `${ error.code }: ${ error.message }` : error.code);
      throw error;
    }
  }

  async listBrokerItems(
    claims: BrokerExecuteRequest['claims'], serviceId: string, token: string | undefined,
  ): Promise<BrokerItemListResponse> {
    this.host.requireBrokerIdentity(serviceId, token);
    const validIdentifier = (value: unknown) => typeof value === 'string' && BROKER_IDENTIFIER_PATTERN.test(value);
    if (!claims || !UUID_PATTERN.test(claims.sub) || !validIdentifier(claims.agent_id) || !validIdentifier(claims.pod_id)) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller identity is invalid');
    }
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    if (claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const result = await this.host.itemRepository.listAgentAccessiblePersonal<ItemRow>([keys.userId]);
    const items: BrokerItemListResponse['items'] = [];
    for (const row of result.rows) {
      const plaintext = JSON.parse(await this.host.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
        { itemId: row.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      const checked = validateVaultItemProxy(plaintext);
      if (!checked.ok) continue;
      const policy = row.agent_policy ?? plaintext.agentPolicy;
      if (!Array.isArray(policy?.sites)) continue;
      const usable = AgentPolicyGate.shared().allows({ ...policy, sites: [] }, {
        agentId: claims.agent_id, level: 'autofill', onServer: false,
      }).allowed;
      if (!usable) continue;
      items.push({
        id: row.id, name: plaintext.name, type: plaintext.type, hosts: checked.proxy.hosts,
        rules: checked.proxy.rules.map(({ target, name, scheme }) => ({ target, name, scheme })),
      });
    }
    this.host.requireGeneration(generation);
    return { items };
  }

  async executeStream(
    input: BrokerExecuteRequest,
    serviceId: string,
    token: string | undefined,
    sink: BrokerStreamSink,
  ): Promise<void> {
    this.host.parts.brokerRequests.validateBrokerRequestIdentity(input, serviceId, token);
    const streamInput = {
      ...input,
      responseType: input.responseType === 'binary-stream' ? 'binary-stream' as const : 'stream' as const,
    };
    try {
      const prepared = await this.host.parts.brokerRequests.prepareBrokerRequest(streamInput, serviceId, token);
      await this.host.parts.streams.sendStream(prepared, streamInput, sink);
      if (prepared.item) await this.host.parts.brokerAudit.audit(streamInput, prepared.item, false, null);
    } catch (error) {
      if (error instanceof LocalVaultError) {
        // invalid_upstream_response covers two distinct sendStream checks (compressed
        // encoding, non-textual content-type); fold in the observed header values so
        // audit_log says which one actually fired instead of just the shared code.
        const reason = error.code === 'invalid_upstream_response' ? `${ error.code }: ${ error.message }` : error.code;
        await this.host.parts.brokerAudit.auditBrokerDenial(streamInput, reason);
      }
      throw error;
    }
  }

  private async executeOAuthMutation(input: BrokerExecuteRequest, serviceId: string, token: string | undefined): Promise<BrokerExecuteResponse> {
    return this.withCredentialQueue(input.ref, async() => {
      const prepared = await this.host.parts.brokerRequests.prepareBrokerRequest(input, serviceId, token);
      const result = await this.host.parts.upstream.send(
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
      return await this.host.runSecurityOperation(() => this.host.runTransaction(async(client) => {
        this.host.requireGeneration(prepared.generation);
        if (input.operation === 'oauth.revoke') {
          await this.host.parts.oauthTokens.clearOAuthTokens(prepared, client);
          await this.host.parts.brokerAudit.audit(input, prepared.item!, false, null, client);
          this.host.requireGeneration(prepared.generation);
          return { ...result, body: { revoked: true } };
        }
        if (input.operation === 'oauth.register') {
          const clientId = await this.host.parts.oauthTokens.storeOAuthRegistration(prepared, result.body, client);
          await this.host.parts.brokerAudit.audit(input, prepared.item!, false, null, client);
          this.host.requireGeneration(prepared.generation);
          return { ...result, body: { updated: true, operation: 'oauth.register', client_id: clientId } };
        }
        await this.host.parts.oauthTokens.storeOAuthTokens(prepared, result.body, client);
        await this.host.parts.brokerAudit.audit(input, prepared.item!, false, null, client);
        this.host.requireGeneration(prepared.generation);
        return { ...result, body: this.host.parts.oauthTokens.sanitizeOAuthResult(input.operation, result.body) };
      }));
    });
  }

  /** Serialize token mutations per integration account (refresh tokens rotate). */
  async withCredentialQueue<T>(ref: BrokerCredentialRef, operation: () => Promise<T>): Promise<T> {
    const profile = this.host.profileContext;
    const authorityGeneration = this.host.generation;
    const queueKey = `${ profile.profileId }/${ ref.integrationId ?? '' }/${ ref.accountId ?? '' }`;
    const previous = this.host.oauthRefreshQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.host.oauthRefreshQueues.set(queueKey, queued);
    await previous;
    try {
      try {
        this.host.assertProfileCurrent(profile.profileId, profile.generation);
        this.host.requireGeneration(authorityGeneration);
      } catch (error) {
        const warningKey = `${ profile.profileId }/${ profile.generation.value }`;
        if (!this.staleRefreshWarnings.has(warningKey)) {
          this.staleRefreshWarnings.add(warningKey);
          console.warn('Dropped stale vault OAuth refresh work');
        }
        throw error;
      }
      return await operation();
    } finally {
      release();
      if (this.host.oauthRefreshQueues.get(queueKey) === queued) this.host.oauthRefreshQueues.delete(queueKey);
    }
  }
}
