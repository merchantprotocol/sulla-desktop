// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
import { VaultBrokerError } from './VaultBrokerError';
export { VaultBrokerError } from './VaultBrokerError';

import type {
  BrokerApprovalResponse,
  BrokerAgentIntegrationMetadataRequest,
  BrokerClaims,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerItemListResponse,
  BrokerIntegrationMetadataResponse,
  BrokerVaultItemWriteRequest,
  BrokerVaultItemUpdateRequest,
  BrokerVaultItemWriteResponse,
  BrokerIntegrationCredentialWriteRequest,
  BrokerIntegrationAccountImportRequest,
  BrokerRelayCreateRequest,
  BrokerRelayCreateResponse,
  BrokerRelaySendRequest,
  LocalVaultErrorResponse,
  SullaCloudSessionAdoptRequest,
  SullaCloudSessionResponse,
  SullaCloudDesktopRequest,
  AccountPasswordRewrapRequest,
  AccountPasswordRewrapResponse,
  VaultDeviceApprovalWrapRequest, VaultEnrollmentWrapRequest, VaultEnrollmentAdoptRequest,
  RecoveryKeyRotateResponse,
} from '../../../services/sulla-vault/src/contracts';

export type {
  BrokerApprovalResponse,
  BrokerClaims,
  BrokerCredentialRef,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerItemListResponse,
  BrokerIntegrationMetadataResponse,
  BrokerVaultItemWriteRequest,
  BrokerVaultItemUpdateRequest,
  BrokerVaultItemWriteResponse,
  BrokerIntegrationCredentialWriteRequest,
  BrokerInjection,
  BrokerRelayCreateRequest,
  BrokerRelayCreateResponse,
  BrokerRelaySendRequest,
  LocalVaultErrorResponse,
  SullaCloudSessionAdoptRequest,
  SullaCloudSessionResponse,
  SullaCloudDesktopRequest,
} from '../../../services/sulla-vault/src/contracts';
export type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
export {
  ProviderCliBridgeService,
  ProviderBridgeAuthorizeUnavailableError,
  ProviderBridgeRevokedError,
  type ProviderCliAuthMode,
  type ProviderCliBridgeIdentity,
  type ProviderCliBridgeLease,
  type ProviderCliBridgeOptions,
  type ProviderCliIntegration,
  type ProviderCliName,
  type ProviderCliOpaqueConfig,
} from './providerCliBridge';

// Sulla Cloud relay events carry a <=1 MiB frame as an escaped JSON string.
const MAX_RELAY_EVENT_LINE_BYTES = 4 * 1024 * 1024;

export interface VaultRelayEvent {
  sequence: number;
  type:     string;
  payload:  unknown;
}

export interface VaultBrokerServiceIdentity {
  serviceId:    string;
  serviceToken: string;
}

export type VaultBrokerIdentityProvider = () => Promise<VaultBrokerServiceIdentity>;
export type VaultBrokerFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Desktop always uses its local container vault; hosted vault mode moved to merchantprotocol/sulla-server. */
export function usesContainerVaultAuthority(): boolean {
  return true;
}
/** Accept only short token-like reason codes from the vault; never echo arbitrary text. */
function safeReason(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

function safeRetryAfter(value: string | null): string | undefined {
  if (!value || !/^\d{1,15}$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? String(seconds) : undefined;
}

function brokerError(body: LocalVaultErrorResponse, status: number, retryAfter: string | null = null): VaultBrokerError {
  return new VaultBrokerError(body.error, body.message, status, safeReason(body.reason), body.retryable === true, safeRetryAfter(retryAfter));
}

export class VaultApprovalRequiredError extends VaultBrokerError {
  constructor(
    public readonly operationId: string,
    public readonly request: Readonly<BrokerExecuteRequest>,
    message = 'Vault approval is required for this operation',
    public readonly approvalContext?: LocalVaultErrorResponse['approvalContext'],
  ) {
    super('approval_required', message, 428);
    this.name = 'VaultApprovalRequiredError';
  }
}

function claimsFromContext(ctx: ToolExecutionContext): BrokerClaims {
  if (!ctx?.sub || !ctx.agent_id || !ctx.pod_id) {
    throw new VaultBrokerError('invalid_caller_identity', 'Vault broker calls require verified subject, agent_id, and pod_id claims', 401);
  }
  return {
    sub:                    ctx.sub,
    agent_id:               ctx.agent_id,
    pod_id:                 ctx.pod_id,
    org_id:                 ctx.org_id,
    thread_id:              ctx.thread_id,
    job_id:                 ctx.job_id,
    workflow_execution_id: ctx.workflow_execution_id,
    credential_scope:       ctx.credential_scope,
  };
}

function assertEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !['127.0.0.1', 'sulla_vault'].includes(url.hostname)) {
    throw new Error('Vault broker endpoint must use HTTPS at the configured Desktop or tools service address');
  }
  return url.toString().replace(/\/$/, '');
}

export { configuredVaultBrokerProvider, VaultBrokerServiceProvider } from './VaultBrokerServiceProvider';
export type { VaultBrokerIdentityContextInput } from './VaultBrokerServiceProvider';

async function errorBody(response: Response): Promise<LocalVaultErrorResponse> {
  return response.json().catch(() => ({
    error: 'vault_unavailable', message: `Vault broker request failed (${ response.status })`,
  })) as Promise<LocalVaultErrorResponse>;
}

export class LocalVaultBrokerClient {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly identity: VaultBrokerServiceIdentity | VaultBrokerIdentityProvider,
    private readonly transport: VaultBrokerFetch = (input, init) => fetch(input, init),
    private readonly streamTransport: VaultBrokerFetch = transport,
    private readonly invalidatePrincipal: () => void = () => {},
  ) {
    this.endpoint = assertEndpoint(endpoint);
    if (typeof identity !== 'function' && (!identity.serviceId || !identity.serviceToken)) {
      throw new Error('Vault broker service identity is not configured');
    }
  }

  requestFor(ctx: ToolExecutionContext, request: Omit<BrokerExecuteRequest, 'claims'>): BrokerExecuteRequest {
    try {
      const claims = claimsFromContext(ctx);
      return { ...request, claims };
    }
    catch (error) { this.observeError(error); throw error; }
  }

  async execute(request: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse> {
    const response = await this.send('/v1/broker/execute', request, signal);
    if (!response.ok) await this.throwResponse(response, request);
    return response.json() as Promise<BrokerExecuteResponse>;
  }

  async status(signal?: AbortSignal): Promise<{ state: string; unlocked: boolean; principalId?: string }> {
    const response = await this.request('/v1/broker/status', 'GET', undefined, signal);
    return response.json() as Promise<{ state: string; unlocked: boolean; principalId?: string }>;
  }

  async listItems(ctx: ToolExecutionContext, signal?: AbortSignal): Promise<BrokerItemListResponse> {
    const response = await this.request('/v1/broker/items', 'POST', { claims: claimsFromContext(ctx) }, signal);
    return response.json() as Promise<BrokerItemListResponse>;
  }

  async createItem(ctx: ToolExecutionContext, input: Omit<BrokerVaultItemWriteRequest, 'claims'>, signal?: AbortSignal): Promise<BrokerVaultItemWriteResponse> {
    const response = await this.request('/v1/broker/items/create', 'POST', { ...input, claims: claimsFromContext(ctx) }, signal);
    return response.json() as Promise<BrokerVaultItemWriteResponse>;
  }

  async updateItem(ctx: ToolExecutionContext, input: Omit<BrokerVaultItemUpdateRequest, 'claims'>, signal?: AbortSignal): Promise<BrokerVaultItemWriteResponse> {
    const response = await this.request(`/v1/broker/items/${ encodeURIComponent(input.itemId) }`, 'PATCH', { ...input, claims: claimsFromContext(ctx) }, signal);
    return response.json() as Promise<BrokerVaultItemWriteResponse>;
  }

  async setIntegrationCredential(ctx: ToolExecutionContext, input: Omit<BrokerIntegrationCredentialWriteRequest, 'claims' | 'integrationId'> & { integrationId: string }, signal?: AbortSignal): Promise<BrokerVaultItemWriteResponse> {
    const response = await this.request(`/v1/broker/integrations/${ encodeURIComponent(input.integrationId) }/credential`, 'PUT', { ...input, claims: claimsFromContext(ctx) }, signal);
    return response.json() as Promise<BrokerVaultItemWriteResponse>;
  }

  async integrationMetadata(
    integrationId: string,
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<BrokerIntegrationMetadataResponse> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) ||
        (accountId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(accountId))) {
      throw new VaultBrokerError('invalid_operation', 'Integration metadata reference is invalid', 400);
    }
    const url = new URL(`${ this.endpoint }/v1/broker/integrations/${ encodeURIComponent(integrationId) }/metadata`);
    if (accountId) url.searchParams.set('accountId', accountId);
    const response = await this.request(`${ url.pathname }${ url.search }`, 'GET', undefined, signal);
    return response.json() as Promise<BrokerIntegrationMetadataResponse>;
  }

  async integrationMetadataForAgent(
    ctx: ToolExecutionContext,
    integrationId: string,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<BrokerIntegrationMetadataResponse> {
    if (integrationId !== 'clerk' || accountId !== 'default') {
      throw new VaultBrokerError('invalid_operation', 'Agent metadata reference is invalid', 400);
    }
    const input: BrokerAgentIntegrationMetadataRequest = { claims: claimsFromContext(ctx), accountId };
    const response = await this.request(
      `/v1/broker/integrations/${ encodeURIComponent(integrationId) }/agent-metadata`,
      'POST', input, signal,
    );
    return response.json() as Promise<BrokerIntegrationMetadataResponse>;
  }

  async setActiveIntegrationAccount(
    integrationId: string,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<BrokerIntegrationMetadataResponse> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || !/^[A-Za-z0-9._-]{1,128}$/.test(accountId)) {
      throw new VaultBrokerError('invalid_operation', 'Integration account reference is invalid', 400);
    }
    const response = await this.request(`/v1/broker/integrations/${ encodeURIComponent(integrationId) }/active-account`, 'PUT', { accountId }, signal);
    return response.json() as Promise<BrokerIntegrationMetadataResponse>;
  }

  async executeStream(request: BrokerExecuteRequest, signal?: AbortSignal): Promise<Response> {
    const streamRequest = { ...request, responseType: request.responseType ?? 'stream' } as BrokerExecuteRequest;
    const response = await this.send('/v1/broker/execute-stream', streamRequest, signal, this.streamTransport);
    // Upstream provider errors are legitimate streamed responses. The vault
    // marks its own pre-header denials so callers can distinguish them without
    // consuming or buffering a provider response body.
    if (!response.ok && response.headers.get('x-sulla-vault-error')) {
      await this.throwResponse(response, streamRequest);
    }
    return response;
  }

  async createRelay(
    ctx: ToolExecutionContext,
    operation: BrokerRelayCreateRequest['operation'],
    ref: BrokerRelayCreateRequest['ref'],
    signal?: AbortSignal,
    approvalId?: string,
    params?: BrokerRelayCreateRequest['params'],
  ): Promise<BrokerRelayCreateResponse> {
    const request: BrokerRelayCreateRequest = { claims: claimsFromContext(ctx), operation, ref };
    if (approvalId) (request as BrokerRelayCreateRequest & { approvalId?: string }).approvalId = approvalId;
    if (params) request.params = params;
    const response = await this.request('/v1/broker/relay/session', 'POST', request, signal);
    return response.json() as Promise<BrokerRelayCreateResponse>;
  }

  async relayEvents(relayId: string, signal?: AbortSignal): Promise<Response> {
    return this.request(`/v1/broker/relay/${ encodeURIComponent(relayId) }/events`, 'GET', undefined, signal, this.streamTransport);
  }

  async * relayEventStream(relayId: string, signal?: AbortSignal): AsyncIterable<VaultRelayEvent> {
    const response = await this.relayEvents(relayId, signal);
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/x-ndjson')) {
      await response.body?.cancel();
      throw new VaultBrokerError('invalid_response', 'Vault relay returned an invalid content type', 502);
    }
    if (!response.body) throw new VaultBrokerError('vault_unavailable', 'Vault relay returned no event stream', 502);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        if (Buffer.byteLength(pending) > MAX_RELAY_EVENT_LINE_BYTES && !pending.includes('\n')) {
          throw new VaultBrokerError('response_too_large', 'Vault relay event exceeds the client bound', 502);
        }
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > MAX_RELAY_EVENT_LINE_BYTES) {
            throw new VaultBrokerError('response_too_large', 'Vault relay event exceeds the client bound', 502);
          }
          const event = JSON.parse(line) as Partial<VaultRelayEvent>;
          if (!Number.isSafeInteger(event.sequence) || typeof event.type !== 'string') {
            throw new VaultBrokerError('invalid_response', 'Vault relay returned an invalid event', 502);
          }
          yield event as VaultRelayEvent;
        }
        if (done) break;
      }
      if (pending.trim()) throw new VaultBrokerError('invalid_response', 'Vault relay ended with a partial event', 502);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async relaySend(relayId: string, payload: BrokerRelaySendRequest, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/v1/broker/relay/${ encodeURIComponent(relayId) }/send`, 'POST', payload, signal);
    await response.body?.cancel();
  }

  async closeRelay(relayId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/v1/broker/relay/${ encodeURIComponent(relayId) }`, 'DELETE', undefined, signal);
    await response.body?.cancel();
  }

  protected async request(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
    transport = this.transport,
  ): Promise<Response> {
    try {
      const response = await transport(`${ this.endpoint }${ path }`, {
        method,
        headers: await this.serviceHeaders(body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      this.observeResponse(response);
      if (!response.ok) await this.throwRelayResponse(response);
      return response;
    } catch (error) {
      this.observeError(error);
      throw error;
    }
  }

  private async send(path: string, request: BrokerExecuteRequest, signal?: AbortSignal, transport = this.transport): Promise<Response> {
    if (!request.claims?.sub || !request.claims.agent_id || !request.claims.pod_id) {
      const error = new VaultBrokerError('invalid_caller_identity', 'Vault broker request has incomplete caller claims', 401);
      this.observeError(error);
      throw error;
    }
    try {
      const response = await transport(`${ this.endpoint }${ path }`, {
        method:  'POST',
        headers: await this.serviceHeaders(true),
        body:    JSON.stringify(request),
        signal,
      });
      this.observeResponse(response);
      return response;
    } catch (error) {
      this.observeError(error);
      throw error;
    }
  }

  private observeResponse(response: Response): void {
    if (response.status === 401 || response.status === 423) this.invalidatePrincipal();
  }

  private observeError(error: unknown): void {
    if (error instanceof VaultBrokerError && ['vault_locked', 'invalid_caller_identity'].includes(error.code)) {
      this.invalidatePrincipal();
    }
  }

  private async serviceHeaders(json: boolean): Promise<Record<string, string>> {
    const identity = typeof this.identity === 'function' ? await this.identity() : this.identity;
    if (!identity.serviceId || !identity.serviceToken) {
      throw new VaultBrokerError('vault_unavailable', 'Vault broker service identity is not configured', 503);
    }
    return {
      authorization:        `Bearer ${ identity.serviceToken }`,
      'x-sulla-service-id': identity.serviceId,
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  private async throwRelayResponse(response: Response): Promise<never> {
    const error = brokerError(await errorBody(response), response.status);
    this.observeError(error);
    throw error;
  }

  private async throwResponse(response: Response, request: BrokerExecuteRequest): Promise<never> {
    const body = await errorBody(response);
    if (response.status === 428 && body.error === 'approval_required' && body.operationId) {
      throw new VaultApprovalRequiredError(body.operationId, Object.freeze(structuredClone(request)), body.message, body.approvalContext);
    }
    const error = brokerError(body, response.status, response.headers.get('retry-after'));
    this.observeError(error);
    throw error;
  }
}

export { LocalVaultApprovalClient } from './LocalVaultApprovalClient';
import { LocalVaultApprovalClient } from './LocalVaultApprovalClient';

