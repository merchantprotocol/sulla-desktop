// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentPolicyAllows, validateVaultItemProxy, type VaultItemPlaintext } from '@sulla/vault-crypto';

import { validateCatalogRequest } from '../catalogPolicy.js';
import type { BrokerExecuteRequest } from '../contracts.js';
import { validateEnterpriseGatewayHttp } from '../gatewayPolicy.js';
import { validateOAuthDestination } from '../oauthPolicy.js';
import { brokerTransferLimits, isTrustedFilesCloudCall, validateItemHttpOperation, validateOperation } from '../operationPolicy.js';
import { buildTranscriptionProviderRequest } from '../transcriptionPolicy.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { APPROVAL_TTL_MS, BROKER_IDENTIFIER_PATTERN, MAX_CREDENTIAL_BYTES, MAX_RESPONSE_BYTES, UUID_PATTERN } from './LocalAuthorityLimits.js';
import type { ItemRow, PreparedBrokerRequest } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';
import { BrokerCredentialFields } from './BrokerCredentialFields.js';
import { BrokerHttpBody } from './BrokerHttpBody.js';
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';

/**
 * Turns a signed broker request into an upstream call: caller identity and scope checks, item
 * and policy resolution, ask-first approvals, and credential injection with secret tracking.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class BrokerRequestPreparer {
  constructor(private readonly host: LocalAuthorityHost) {}

  validateBrokerRequestIdentity(input: BrokerExecuteRequest, callerId: string, token: string | undefined): void {
    this.host.requireBrokerIdentity(callerId, token);
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

  async prepareBrokerRequest(
    input: BrokerExecuteRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<PreparedBrokerRequest> {
    this.validateBrokerRequestIdentity(input, serviceId, token);
    if (!/^[a-z][a-z0-9_.:-]{1,79}$/i.test(input.operation)) {
      throw new LocalVaultError('invalid_operation', 400, 'Broker operation is invalid');
    }
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    if (input.claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const target = await this.host.parts.upstream.validateTarget(input.url);
    let catalogDecision = null;
    if (['catalog.http', 'mcp.http'].includes(input.operation)) {
      try {
        catalogDecision = await validateCatalogRequest(this.host.db, input, target);
      } catch {
        throw new LocalVaultError('policy_denied', 403, 'Registered catalog policy denied the request');
      }
    }
    if (catalogDecision?.credentialFree) {
      const scope = input.claims.credential_scope;
      if (!scope || scope.integration_id !== input.ref.integrationId || scope.account_id !== input.ref.accountId) {
        throw new LocalVaultError('policy_denied', 403, 'Public request is outside the signed caller scope');
      }
      this.host.requireGeneration(generation);
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
    const plaintext = JSON.parse(await this.host.openItemText(
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
      if (!checked.proxy.hosts.some(host => BrokerCredentialFields.proxyHostMatches(target.hostname.toLowerCase(), host))) {
        throw new LocalVaultError('destination_denied', 403, `Vault item is not allowed on ${ target.hostname }`);
      }
      const decision = agentPolicyAllows(itemPolicy, {
        agentId: input.claims.agent_id, level: 'autofill', host: target.hostname, onServer: false,
      });
      if (!decision.allowed) throw new LocalVaultError('policy_denied', 403, decision.reason ?? 'Credential policy denied the operation');
      const digest = LocalAuthorityCrypto.operationDigest(input);
      if (itemPolicy.askFirst) {
        const approval = input.approvalId ? this.host.approvals.get(input.approvalId) : undefined;
        if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
          if (input.approvalId) this.host.approvals.delete(input.approvalId);
          this.host.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
          throw new LocalVaultError('approval_required', 428, digest);
        }
        this.host.approvals.delete(input.approvalId!);
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
          const source = BrokerCredentialFields.proxySource(plaintext, rule.source);
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
      this.host.requireGeneration(generation);
      return { target, headers, body: input.body, secrets, generation, maxRequestBytes: MAX_RESPONSE_BYTES, item, plaintext };
    }
    let effectivePolicy = itemPolicy;
    if (input.operation.startsWith('oauth.')) {
      try {
        await validateOAuthDestination(this.host.db, input, plaintext);
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

    const digest = LocalAuthorityCrypto.operationDigest(input);
    if ((item.agent_policy ?? plaintext.agentPolicy).askFirst) {
      const approval = input.approvalId ? this.host.approvals.get(input.approvalId) : undefined;
      if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
        if (input.approvalId) this.host.approvals.delete(input.approvalId);
        this.host.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
        throw new LocalVaultError('approval_required', 428, digest);
      }
      this.host.approvals.delete(input.approvalId!);
    }

    BrokerCredentialFields.deriveChatgptAccountRoutingForRequest(input, plaintext);

    const secrets: string[] = [];
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    headers['accept-encoding'] = 'identity';
    let body: unknown = input.bodyEncoding === 'base64' && typeof input.body === 'string'
      ? Buffer.from(input.body, 'base64')
      : input.body;
    for (const injection of input.injections) {
      const value = BrokerCredentialFields.credentialField(plaintext, injection.field) ??
        (input.operation.startsWith('sulla-cloud.') && injection.field === 'api_token'
          ? BrokerCredentialFields.credentialField(plaintext, 'access_token')
          : undefined);
      if (typeof value !== 'string') throw new LocalVaultError('credential_field_missing', 404, 'Requested credential field is unavailable');
      if (Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('policy_denied', 403, 'Credential field exceeds the broker limit');
      secrets.push(value);
      const basicClientId = injection.scheme === 'BasicClient' ? BrokerCredentialFields.credentialField(plaintext, 'client_id') : undefined;
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
          : typeof body === 'string' ? new URLSearchParams(body) : BrokerHttpBody.formFromObject(body);
        form.set(injection.name, injected);
        body = form;
        BrokerHttpBody.setContentType(headers, 'application/x-www-form-urlencoded');
      } else {
        body = BrokerHttpBody.applyJsonPath(body, injection.name, injected);
      }
    }
    // Public OAuth clients (PKCE, no secret) get no form injection, so an object body declared as a
    // form would otherwise go out as JSON; token endpoints like auth.x.ai reject that with a 415.
    const declaredType = BrokerHttpBody.headerValue(headers, 'content-type');
    if (declaredType && /^application\/x-www-form-urlencoded\b/i.test(declaredType) &&
        body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
      body = BrokerHttpBody.formFromObject(body);
      BrokerHttpBody.setContentType(headers, 'application/x-www-form-urlencoded');
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
    if (input.operation === 'oauth.register') BrokerHttpBody.setContentType(headers, 'application/json');
    this.host.requireGeneration(generation);
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
    const result = await this.host.itemRepository.findBrokerCredential<ItemRow>([input.claims.sub, ref.itemId ?? null, integrationRef]);
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
}
