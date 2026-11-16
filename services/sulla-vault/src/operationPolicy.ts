// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentPolicy } from '@sulla/vault-crypto';

import type { BrokerExecuteRequest, BrokerInjection } from './contracts.js';
import { CALLER_OPERATION_POLICIES } from './callerPolicies.js';
import type { BrokerOperationPolicy } from './operationPolicies/BrokerOperationPolicy.js';
import { OAUTH_OPERATION_POLICIES } from './operationPolicies/oauthOperationPolicies.js';
import { PLATFORM_OPERATION_POLICIES } from './operationPolicies/platformOperationPolicies.js';
import { PROVIDER_OPERATION_POLICIES } from './operationPolicies/providerOperationPolicies.js';
import { TrustedIntegrationOrigins } from './operationPolicies/TrustedIntegrationOrigins.js';

export type { BrokerOperationPolicy } from './operationPolicies/BrokerOperationPolicy.js';
export { TRUSTED_INTEGRATION_ORIGINS, TrustedIntegrationOrigins } from './operationPolicies/TrustedIntegrationOrigins.js';

const DEFAULT_TRANSFER_BYTES = 1_048_576;
const TRANSCRIPTION_REQUEST_BYTES = 17 * 1024 * 1024;
const FILES_SYNC_TRANSFER_BYTES = 6 * 1024 * 1024;
// Fits a full-screen Retina capture; base64 in the 36 MB desktop JSON body limit.
const SHARE_CONTENT_REQUEST_BYTES = 25 * 1024 * 1024;

/** The only operation that may use responseType 'base64' and the 6 MiB Files sync limits. */
export const FILES_SYNC_OPERATION = 'sulla-cloud.files-sync';

export const BROKER_OPERATION_POLICIES: Readonly<Record<string, BrokerOperationPolicy>> = {
  ...CALLER_OPERATION_POLICIES,
  ...PLATFORM_OPERATION_POLICIES,
  ...PROVIDER_OPERATION_POLICIES,
  ...OAUTH_OPERATION_POLICIES,
};

/** Decides whether one broker request matches its typed operation policy before a credential is injected. */
export class OperationPolicy {
  constructor(private readonly policies: Readonly<Record<string, BrokerOperationPolicy>> = BROKER_OPERATION_POLICIES) {}

  /** Request and response byte caps for the generic (non-streaming) broker execute path. */
  transferLimits(operation: string): { request: number; response: number } {
    if (operation === FILES_SYNC_OPERATION || operation === 'sulla-cloud.cloud-files.content') return { request: FILES_SYNC_TRANSFER_BYTES, response: FILES_SYNC_TRANSFER_BYTES };
    if (operation === 'provider.transcription') return { request: TRANSCRIPTION_REQUEST_BYTES, response: DEFAULT_TRANSFER_BYTES };
    if (operation === 'sulla-cloud.shares.content') return { request: SHARE_CONTENT_REQUEST_BYTES, response: DEFAULT_TRANSFER_BYTES };
    return { request: DEFAULT_TRANSFER_BYTES, response: DEFAULT_TRANSFER_BYTES };
  }

  /** Files' own Cloud calls (shares, encrypted backup, catalog) on the owner's Sulla Cloud login. */
  isTrustedFilesCloudCall(input: BrokerExecuteRequest): boolean {
    return (input.operation === 'sulla-cloud.shares' || input.operation === 'sulla-cloud.shares.content' || input.operation === FILES_SYNC_OPERATION || input.operation.startsWith('sulla-cloud.cloud-files.')) &&
      input.ref.integrationId === 'sulla-cloud' && input.claims.agent_id === 'sulla-files' && input.claims.pod_id === 'sulla-files';
  }

  validate(
    input: BrokerExecuteRequest,
    hostname: string,
    itemPolicy: AgentPolicy,
  ): BrokerOperationPolicy {
    const policy = this.policies[input.operation];
    if (!policy) throw new Error('unknown_operation');
    if (!input.ref.integrationId || (policy.integrations && !policy.integrations.includes(input.ref.integrationId))) {
      throw new Error('integration_denied');
    }
    if (!policy.methods.includes(input.method.toUpperCase())) throw new Error('method_denied');
    if (input.operation === 'enterprise.gateway.http') {
      const pathname = new URL(input.url).pathname;
      if ((input.method.toUpperCase() === 'POST' && pathname !== '/api/desktop/sessions') ||
          (input.method.toUpperCase() === 'DELETE' && !/^\/api\/desktop\/sessions\/[A-Za-z0-9._~-]{1,200}$/.test(pathname))) {
        throw new Error('method_denied');
      }
    }
    // An integration may own several bindings (one per credential lane); the
    // destination host selects the lane, so each lane's injections stay bound
    // to its own hosts.
    const candidates = policy.bindings?.filter(candidate => candidate.integration === input.ref.integrationId) ?? [];
    if (policy.bindings && !candidates.length) throw new Error('integration_denied');
    const binding = candidates.find(candidate => candidate.hosts?.some(allowed => this.hostMatches(hostname.toLowerCase(), allowed))) ??
      candidates[0];
    const allowedHosts = binding?.hosts ?? (policy.requireItemSites ? itemPolicy.sites : policy.hosts);
    if (!allowedHosts?.length || !allowedHosts.some(allowed => this.hostMatches(hostname.toLowerCase(), allowed))) {
      throw new Error('destination_denied');
    }
    // A binding is the product allowlist. Item sites are optional for bound
    // providers; when present they can only narrow that allowlist, never widen it.
    if (binding?.hosts && itemPolicy.sites?.length &&
        !itemPolicy.sites.some(allowed => this.hostMatches(hostname.toLowerCase(), allowed))) {
      throw new Error('destination_denied');
    }
    const streaming = input.responseType === 'stream' || input.responseType === 'binary-stream';
    if (streaming && !policy.allowStreaming) throw new Error('streaming_denied');
    if (input.responseType === 'binary-stream' && !policy.binaryResponse) throw new Error('binary_denied');
    if (input.responseType === 'base64' && input.operation !== FILES_SYNC_OPERATION && !policy.binaryResponse) throw new Error('binary_denied');
    if (input.bodyEncoding !== undefined && (!policy.binaryRequest || input.bodyEncoding !== 'base64' || typeof input.body !== 'string')) {
      throw new Error('binary_denied');
    }
    const pathPattern = binding?.pathPattern ?? policy.pathPattern;
    if (pathPattern && !pathPattern.test(new URL(input.url).pathname)) throw new Error('path_denied');
    const allowedInjections = binding?.injections ?? policy.injections;
    for (const injection of input.injections) {
      if (!allowedInjections.some(candidate => this.exactInjection(candidate, injection))) throw new Error('injection_denied');
    }
    if (binding?.requiredInjections?.some(required => !input.injections.some(candidate => this.exactInjection(candidate, required)))) {
      throw new Error('injection_denied');
    }
    if (binding?.injectionSets && !binding.injectionSets.some(set => set.length === input.injections.length &&
      set.every(required => input.injections.some(candidate => this.exactInjection(candidate, required))))) {
      throw new Error('injection_denied');
    }
    if (!input.injections.length && !policy.credentialOptional) throw new Error('credential_injection_required');
    return policy;
  }

  /** item.http is owner-declared and deliberately bypasses the integration injection allowlist. */
  validateItemHttp(input: BrokerExecuteRequest): void {
    const policy = this.policies['item.http'];
    if (!policy.methods.includes(input.method.toUpperCase())) throw new Error('method_denied');
    if (input.responseType === 'stream' || input.responseType === 'binary-stream' || input.responseType === 'base64' || input.bodyEncoding !== undefined) {
      throw new Error('streaming_denied');
    }
    if (input.injections.length) throw new Error('injection_denied');
  }

  private exactInjection(left: BrokerInjection, right: BrokerInjection): boolean {
    return left.field === right.field && left.target === right.target &&
      left.name.toLowerCase() === right.name.toLowerCase() && (left.scheme ?? 'raw') === (right.scheme ?? 'raw');
  }

  private hostMatches(host: string, allowed: string): boolean {
    const normalized = allowed.toLowerCase().replace(/^\*\./, '');
    return host === normalized || (allowed.startsWith('*.') && host.endsWith(`.${ normalized }`));
  }
}

/** @deprecated use OperationPolicy.transferLimits — E9 alias, removed in final cleanup */
export function brokerTransferLimits(operation: string): { request: number; response: number } {
  return new OperationPolicy().transferLimits(operation);
}

/** @deprecated use OperationPolicy.isTrustedFilesCloudCall — E9 alias, removed in final cleanup */
export function isTrustedFilesCloudCall(input: BrokerExecuteRequest): boolean {
  return new OperationPolicy().isTrustedFilesCloudCall(input);
}

/** @deprecated use OperationPolicy.validate — E9 alias, removed in final cleanup */
export function validateOperation(
  input: BrokerExecuteRequest,
  hostname: string,
  itemPolicy: AgentPolicy,
): BrokerOperationPolicy {
  return new OperationPolicy().validate(input, hostname, itemPolicy);
}

/** @deprecated use OperationPolicy.validateItemHttp — E9 alias, removed in final cleanup */
export function validateItemHttpOperation(input: BrokerExecuteRequest): void {
  new OperationPolicy().validateItemHttp(input);
}

/** @deprecated use TrustedIntegrationOrigins.originsFor — E9 alias, removed in final cleanup */
export function trustedOriginsForIntegration(integrationId: string): string[] {
  return new TrustedIntegrationOrigins().originsFor(integrationId);
}
