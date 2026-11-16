// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultItemPlaintext } from '@sulla/vault-crypto';

import type { BrokerExecuteRequest, BrokerRelayCreateRequest, BrokerRelayCreateResponse, BrokerRelaySendRequest } from '../contracts.js';
import { enterpriseGatewayOrigin } from '../gatewayPolicy.js';
import { createRelayId, type VaultRelayEvent } from '../relays.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { APPROVAL_TTL_MS } from './LocalAuthorityLimits.js';
import { LocalVaultError } from './LocalVaultError.js';
import { BrokerCredentialFields } from './BrokerCredentialFields.js';
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';
import { AgentPolicyGate } from './AgentPolicyGate.js';

/**
 * Long-lived broker relays (Slack socket mode, Discord gateway, enterprise gateway, Sulla Cloud
 * relay): open with the stored credential, then send/receive/close bound to the vault generation.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class BrokerRelayService {
  constructor(private readonly host: LocalAuthorityHost) {}

  async createRelay(
    input: BrokerRelayCreateRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<BrokerRelayCreateResponse> {
    this.host.requireBrokerIdentity(serviceId, token);
    if (input.operation === 'sulla-cloud.relay') return this.host.parts.sullaCloud.createSullaCloudRelay(input);
    const expected = input.operation === 'slack.socket-mode'
      ? { integrationId: 'slack', host: 'slack.com', fields: ['app_token', 'app_level_token'], gatewayField: undefined }
      : input.operation === 'discord.gateway'
        ? { integrationId: 'discord', host: 'discord.com', fields: ['bot_token', 'token'], gatewayField: undefined }
        : input.operation === 'enterprise.gateway'
          ? { integrationId: 'enterprise_gateway', host: null, fields: ['api_key'], gatewayField: 'gateway_url' }
          : null;
    if (!expected || input.ref.integrationId !== expected.integrationId) {
      throw new LocalVaultError('policy_denied', 403, 'Relay operation is not registered for this integration');
    }
    const request: BrokerExecuteRequest = {
      claims: input.claims,
      operation: input.operation,
      ref: input.ref,
      url: expected.host ? `https://${ expected.host }/vault-relay` : 'https://enterprise.invalid/vault-relay',
      method: 'POST',
      headers: {},
      body: null,
      injections: [],
      approvalId: input.approvalId,
      responseType: 'json',
    };
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const item = await this.host.parts.brokerRequests.loadBrokerItem(request, expected.host);
    const plaintext = JSON.parse(await this.host.openItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
      keys.userKey,
      { itemId: item.id, ownerId: item.owner_user_id ?? keys.userId },
    )) as VaultItemPlaintext;
    let gatewayUrl: string | undefined;
    let gatewayAddress: { address: string; family: 4 | 6 } | undefined;
    if (input.operation === 'enterprise.gateway') {
      const rawGatewayUrl = expected.gatewayField ? BrokerCredentialFields.credentialField(plaintext, expected.gatewayField) : undefined;
      if (!rawGatewayUrl) throw new LocalVaultError('credential_field_missing', 404, 'Enterprise gateway URL is unavailable');
      try {
        const gateway = enterpriseGatewayOrigin(rawGatewayUrl);
        gatewayUrl = gateway.origin;
        const pinned = await this.host.parts.upstream.validateTarget(gateway.origin);
        gatewayAddress = { address: pinned.pinnedAddress, family: pinned.pinnedFamily };
        request.url = `${ gateway.origin }/vault-relay`;
        const siteDecision = AgentPolicyGate.shared().allows(item.agent_policy ?? plaintext.agentPolicy, {
          agentId: input.claims.agent_id, level: 'autofill', host: gateway.hostname, onServer: false,
        });
        if (!siteDecision.allowed) throw new Error('policy_denied');
      } catch {
        throw new LocalVaultError('destination_denied', 403, 'Enterprise gateway relay destination is denied');
      }
    }
    const digest = LocalAuthorityCrypto.operationDigest(request);
    if ((item.agent_policy ?? plaintext.agentPolicy).askFirst) {
      const approval = input.approvalId ? this.host.approvals.get(input.approvalId) : undefined;
      if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
        if (input.approvalId) this.host.approvals.delete(input.approvalId);
        this.host.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
        throw new LocalVaultError('approval_required', 428, digest);
      }
      this.host.approvals.delete(input.approvalId!);
    }
    const credential = expected.fields.map(field => BrokerCredentialFields.credentialField(plaintext, field)).find(Boolean);
    if (!credential) throw new LocalVaultError('credential_field_missing', 404, 'Relay credential is unavailable');
    const relayId = createRelayId();
    const controller = new AbortController();
    this.host.relaySessions.set(relayId, { generation, controller });
    try {
      const handle = await this.host.relayManager.open({
        relayId, operation: input.operation, credential, gatewayUrl, gatewayAddress, abortSignal: controller.signal,
      });
      this.host.requireGeneration(generation);
      await this.host.parts.brokerAudit.audit(request, item, false, null);
      return handle;
    } catch (error) {
      controller.abort(error);
      this.host.relaySessions.delete(relayId);
      this.host.relayManager.close(relayId, 'open_failed');
      throw error;
    }
  }

  relayEvents(relayId: string, serviceId: string, token: string | undefined, signal: AbortSignal): AsyncIterable<VaultRelayEvent> {
    this.host.requireBrokerIdentity(serviceId, token);
    this.requireRelay(relayId);
    return this.host.relayManager.events(relayId, signal);
  }

  async sendRelay(
    relayId: string,
    command: BrokerRelaySendRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<void> {
    this.host.requireBrokerIdentity(serviceId, token);
    this.requireRelay(relayId);
    await this.host.relayManager.send(relayId, command);
    this.requireRelay(relayId);
  }

  closeRelay(relayId: string, serviceId: string, token: string | undefined): void {
    this.host.requireBrokerIdentity(serviceId, token);
    const relay = this.host.relaySessions.get(relayId);
    if (!relay) return;
    relay.controller.abort(new Error('relay_closed'));
    this.host.relaySessions.delete(relayId);
    this.host.relayManager.close(relayId, 'caller_closed');
  }

  private requireRelay(relayId: string): { generation: number; controller: AbortController } {
    const relay = this.host.relaySessions.get(relayId);
    if (!relay || relay.controller.signal.aborted) {
      throw new LocalVaultError('invalid_operation', 404, 'Relay session is unavailable');
    }
    this.host.requireGeneration(relay.generation);
    return relay;
  }
}
