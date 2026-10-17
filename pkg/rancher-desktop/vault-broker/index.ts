import crypto from 'node:crypto';

import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';

import type {
  BrokerApprovalResponse,
  BrokerClaims,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerIntegrationMetadataResponse,
  BrokerRelayCreateRequest,
  BrokerRelayCreateResponse,
  BrokerRelaySendRequest,
  LocalVaultErrorResponse,
} from '../../../services/sulla-vault/src/contracts';

export type {
  BrokerApprovalResponse,
  BrokerClaims,
  BrokerCredentialRef,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerIntegrationMetadataResponse,
  BrokerInjection,
  BrokerRelayCreateRequest,
  BrokerRelayCreateResponse,
  BrokerRelaySendRequest,
  LocalVaultErrorResponse,
} from '../../../services/sulla-vault/src/contracts';
export type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
export {
  createProviderCliBridge,
  type ProviderCliBridgeIdentity,
  type ProviderCliBridgeLease,
  type ProviderCliBridgeOptions,
  type ProviderCliName,
  type ProviderCliOpaqueConfig,
} from './providerCliBridge';

const TOOLS_VAULT_ENDPOINT = 'https://sulla_vault:8787';
const DESKTOP_VAULT_ENDPOINT = 'https://127.0.0.1:30135';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RELAY_EVENT_LINE_BYTES = 512 * 1024;

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

export function usesContainerVaultAuthority(): boolean {
  return process.env.SULLA_VAULT_MODE !== 'server';
}

export class VaultBrokerError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'VaultBrokerError';
  }
}

export class VaultApprovalRequiredError extends VaultBrokerError {
  constructor(
    public readonly operationId: string,
    public readonly request: Readonly<BrokerExecuteRequest>,
    message = 'Vault approval is required for this operation',
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

async function errorBody(response: Response): Promise<LocalVaultErrorResponse> {
  return response.json().catch(() => ({
    error:   'vault_unavailable',
    message: `Vault broker request failed (${ response.status })`,
  })) as Promise<LocalVaultErrorResponse>;
}

/** Resolve the unlocked local vault owner through the broker-authenticated status endpoint. */
export async function getLocalVaultPrincipalId(signal?: AbortSignal): Promise<string> {
  if (!usesContainerVaultAuthority()) throw new Error('Local vault principal is only available in Desktop authority mode');
  const status = await requireConfiguredCredentialBroker().status(signal);
  if (!status.unlocked) throw new VaultBrokerError('vault_locked', 'Vault is locked', 423);
  if (typeof status.principalId !== 'string' || !UUID_PATTERN.test(status.principalId)) {
    throw new VaultBrokerError('invalid_caller_identity', 'Vault did not return an authenticated local principal', 503);
  }
  return status.principalId;
}

export async function issueLocalBrokerContext(input: {
  agentId:              string;
  podId:                string;
  credentialScope:      NonNullable<ToolExecutionContext['credential_scope']>;
  requestId?:           string;
  threadId?:            string;
  jobId?:               string;
  workflowExecutionId?: string;
  orgId?:               string;
  signal?:              AbortSignal;
}): Promise<ToolExecutionContext> {
  if (!input.agentId.trim() || !input.podId.trim()) {
    throw new VaultBrokerError('invalid_caller_identity', 'Broker context requires trusted agent and pod identities', 401);
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    v:                     1,
    iss:                   'sulla-desktop',
    aud:                   'sulla-tools',
    sub:                   await getLocalVaultPrincipalId(input.signal),
    org_id:                input.orgId,
    agent_id:              input.agentId,
    pod_id:                input.podId,
    thread_id:             input.threadId,
    job_id:                input.jobId,
    workflow_execution_id: input.workflowExecutionId,
    credential_scope:      input.credentialScope,
    scopes:                [],
    iat:                   now,
    exp:                   now + 300,
    jti:                   crypto.randomUUID(),
    request_id:            input.requestId ?? crypto.randomUUID(),
  };
}

export class LocalVaultBrokerClient {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly identity: VaultBrokerServiceIdentity | VaultBrokerIdentityProvider,
    private readonly transport: VaultBrokerFetch = (input, init) => fetch(input, init),
  ) {
    this.endpoint = assertEndpoint(endpoint);
    if (typeof identity !== 'function' && (!identity.serviceId || !identity.serviceToken)) {
      throw new Error('Vault broker service identity is not configured');
    }
  }

  requestFor(ctx: ToolExecutionContext, request: Omit<BrokerExecuteRequest, 'claims'>): BrokerExecuteRequest {
    return { ...request, claims: claimsFromContext(ctx) };
  }

  async execute(request: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse> {
    const response = await this.send('/v1/broker/execute', request, signal);
    if (!response.ok) await this.throwResponse(response, request);
    return response.json() as Promise<BrokerExecuteResponse>;
  }

  async status(signal?: AbortSignal): Promise<{ state: string; unlocked: boolean; principalId?: string }> {
    const response = await this.transport(`${ this.endpoint }/v1/broker/status`, {
      headers: await this.serviceHeaders(false),
      signal,
    });
    if (!response.ok) await this.throwRelayResponse(response);
    return response.json() as Promise<{ state: string; unlocked: boolean; principalId?: string }>;
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
    const response = await this.transport(url.toString(), {
      headers: await this.serviceHeaders(false),
      signal,
    });
    if (!response.ok) await this.throwRelayResponse(response);
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
    const response = await this.transport(
      `${ this.endpoint }/v1/broker/integrations/${ encodeURIComponent(integrationId) }/active-account`,
      {
        method:  'PUT',
        headers: await this.serviceHeaders(true),
        body:    JSON.stringify({ accountId }),
        signal,
      },
    );
    if (!response.ok) await this.throwRelayResponse(response);
    return response.json() as Promise<BrokerIntegrationMetadataResponse>;
  }

  async executeStream(request: BrokerExecuteRequest, signal?: AbortSignal): Promise<Response> {
    const streamRequest = { ...request, responseType: request.responseType ?? 'stream' } as BrokerExecuteRequest;
    const response = await this.send('/v1/broker/execute-stream', streamRequest, signal);
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
  ): Promise<BrokerRelayCreateResponse> {
    const request: BrokerRelayCreateRequest = { claims: claimsFromContext(ctx), operation, ref };
    if (approvalId) (request as BrokerRelayCreateRequest & { approvalId?: string }).approvalId = approvalId;
    const response = await this.transport(`${ this.endpoint }/v1/broker/relay/session`, {
      method:  'POST',
      headers: await this.serviceHeaders(true),
      body:    JSON.stringify(request),
      signal,
    });
    if (!response.ok) await this.throwRelayResponse(response);
    return response.json() as Promise<BrokerRelayCreateResponse>;
  }

  async relayEvents(relayId: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.transport(`${ this.endpoint }/v1/broker/relay/${ encodeURIComponent(relayId) }/events`, {
      headers: await this.serviceHeaders(false),
      signal,
    });
    if (!response.ok) await this.throwRelayResponse(response);
    return response;
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
    const response = await this.transport(`${ this.endpoint }/v1/broker/relay/${ encodeURIComponent(relayId) }/send`, {
      method:  'POST',
      headers: await this.serviceHeaders(true),
      body:    JSON.stringify(payload),
      signal,
    });
    if (!response.ok) await this.throwRelayResponse(response);
    await response.body?.cancel();
  }

  async closeRelay(relayId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.transport(`${ this.endpoint }/v1/broker/relay/${ encodeURIComponent(relayId) }`, {
      method:  'DELETE',
      headers: await this.serviceHeaders(false),
      signal,
    });
    if (!response.ok) await this.throwRelayResponse(response);
    await response.body?.cancel();
  }

  private async send(path: string, request: BrokerExecuteRequest, signal?: AbortSignal): Promise<Response> {
    if (!request.claims?.sub || !request.claims.agent_id || !request.claims.pod_id) {
      throw new VaultBrokerError('invalid_caller_identity', 'Vault broker request has incomplete caller claims', 401);
    }
    return this.transport(`${ this.endpoint }${ path }`, {
      method:  'POST',
      headers: await this.serviceHeaders(true),
      body:    JSON.stringify(request),
      signal,
    });
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
    const body = await errorBody(response);
    throw new VaultBrokerError(body.error, body.message, response.status);
  }

  private async throwResponse(response: Response, request: BrokerExecuteRequest): Promise<never> {
    const body = await errorBody(response);
    if (response.status === 428 && body.error === 'approval_required' && body.operationId) {
      throw new VaultApprovalRequiredError(body.operationId, Object.freeze(structuredClone(request)), body.message);
    }
    throw new VaultBrokerError(body.error, body.message, response.status);
  }
}

/** Construct only in the trusted Desktop approval path, never in tools/providers. */
export class LocalVaultApprovalClient {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly identity: VaultBrokerServiceIdentity | VaultBrokerIdentityProvider,
    private readonly transport: VaultBrokerFetch = (input, init) => fetch(input, init),
  ) {
    this.endpoint = assertEndpoint(endpoint);
    if (typeof identity !== 'function' && (!identity.serviceId || !identity.serviceToken)) {
      throw new Error('Vault approval service identity is not configured');
    }
  }

  async approve(operationId: string): Promise<BrokerApprovalResponse> {
    const identity = typeof this.identity === 'function' ? await this.identity() : this.identity;
    const response = await this.transport(`${ this.endpoint }/v1/broker/approve`, {
      method:  'POST',
      headers: {
        authorization:        `Bearer ${ identity.serviceToken }`,
        'content-type':       'application/json',
        'x-sulla-service-id': identity.serviceId,
      },
      body: JSON.stringify({ operationId }),
    });
    if (!response.ok) {
      const body = await errorBody(response);
      throw new VaultBrokerError(body.error, body.message, response.status);
    }
    return response.json() as Promise<BrokerApprovalResponse>;
  }
}

let configuredBroker: LocalVaultBrokerClient | null | undefined;
let configuredApproval: LocalVaultApprovalClient | null | undefined;

export function configureCredentialBroker(broker: LocalVaultBrokerClient | null): void {
  configuredBroker = broker;
}

function isElectronMainProcess(): boolean {
  return Boolean(process.versions.electron) && (process as NodeJS.Process & { type?: string }).type === 'browser';
}

const toolsVaultFetch: VaultBrokerFetch = async(input, init) => {
  const runtime = await import('./toolsTransport');
  return runtime.toolsVaultFetch(input, init);
};

const desktopVaultFetch: VaultBrokerFetch = async(input, init) => {
  const runtime = await import('./desktopTransport');
  return runtime.desktopVaultFetch(input, init);
};

const desktopBrokerIdentity: VaultBrokerIdentityProvider = async() => {
  const runtime = await import('./desktopTransport');
  return runtime.loadDesktopBrokerIdentity();
};

const desktopApprovalIdentity: VaultBrokerIdentityProvider = async() => {
  const runtime = await import('./desktopTransport');
  return runtime.loadDesktopApprovalIdentity();
};

export function getConfiguredCredentialBroker(): LocalVaultBrokerClient | null {
  if (configuredBroker !== undefined) return configuredBroker;
  const token = process.env.SULLA_VAULT_BROKER_TOKEN;
  const serviceId = process.env.SULLA_VAULT_BROKER_SERVICE_ID;
  if (token && serviceId) {
    if (serviceId !== 'sulla-tools') throw new Error('Vault broker service identity must be sulla-tools');
    configuredBroker = new LocalVaultBrokerClient(
      process.env.SULLA_VAULT_BROKER_URL ?? TOOLS_VAULT_ENDPOINT,
      { serviceId, serviceToken: token },
      toolsVaultFetch,
    );
  } else if (isElectronMainProcess()) {
    configuredBroker = new LocalVaultBrokerClient(
      DESKTOP_VAULT_ENDPOINT,
      desktopBrokerIdentity,
      desktopVaultFetch,
    );
  } else {
    configuredBroker = null;
  }
  return configuredBroker;
}

export function requireConfiguredCredentialBroker(): LocalVaultBrokerClient {
  const broker = getConfiguredCredentialBroker();
  if (!broker) throw new VaultBrokerError('vault_unavailable', 'Vault broker service identity is not configured', 503);
  return broker;
}

/** Available only to the trusted Electron main approval path. */
export function getConfiguredApprovalClient(): LocalVaultApprovalClient | null {
  if (configuredApproval !== undefined) return configuredApproval;
  configuredApproval = isElectronMainProcess()
    ? new LocalVaultApprovalClient(DESKTOP_VAULT_ENDPOINT, desktopApprovalIdentity, desktopVaultFetch)
    : null;
  return configuredApproval;
}
