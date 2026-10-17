import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';

import type {
  BrokerApprovalResponse,
  BrokerClaims,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  LocalVaultErrorResponse,
} from '../../../services/sulla-vault/src/contracts';

export type {
  BrokerApprovalResponse,
  BrokerClaims,
  BrokerCredentialRef,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerInjection,
  LocalVaultErrorResponse,
} from '../../../services/sulla-vault/src/contracts';
export type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';

const DEFAULT_VAULT_ENDPOINT = 'http://sulla_vault:8787';

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
  const isLocal = ['127.0.0.1', 'localhost', '::1', 'sulla_vault'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('Vault broker endpoint must use HTTPS or an approved local service address');
  }
  return url.toString().replace(/\/$/, '');
}

async function errorBody(response: Response): Promise<LocalVaultErrorResponse> {
  return response.json().catch(() => ({
    error:   'vault_unavailable',
    message: `Vault broker request failed (${ response.status })`,
  })) as Promise<LocalVaultErrorResponse>;
}

export class LocalVaultBrokerClient {
  private readonly endpoint: string;

  constructor(endpoint: string, private readonly serviceId: string, private readonly serviceToken: string) {
    this.endpoint = assertEndpoint(endpoint);
    if (!serviceId || !serviceToken) throw new Error('Vault broker service identity is not configured');
  }

  requestFor(ctx: ToolExecutionContext, request: Omit<BrokerExecuteRequest, 'claims'>): BrokerExecuteRequest {
    return { ...request, claims: claimsFromContext(ctx) };
  }

  async execute(request: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse> {
    const response = await this.send('/v1/broker/execute', request, signal);
    if (!response.ok) await this.throwResponse(response, request);
    return response.json() as Promise<BrokerExecuteResponse>;
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

  private async send(path: string, request: BrokerExecuteRequest, signal?: AbortSignal): Promise<Response> {
    if (!request.claims?.sub || !request.claims.agent_id || !request.claims.pod_id) {
      throw new VaultBrokerError('invalid_caller_identity', 'Vault broker request has incomplete caller claims', 401);
    }
    return fetch(`${ this.endpoint }${ path }`, {
      method:  'POST',
      headers: {
        authorization:        `Bearer ${ this.serviceToken }`,
        'content-type':       'application/json',
        'x-sulla-service-id': this.serviceId,
      },
      body: JSON.stringify(request),
      signal,
    });
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

  constructor(endpoint: string, private readonly serviceId: string, private readonly serviceToken: string) {
    this.endpoint = assertEndpoint(endpoint);
    if (!serviceId || !serviceToken) throw new Error('Vault approval service identity is not configured');
  }

  async approve(operationId: string): Promise<BrokerApprovalResponse> {
    const response = await fetch(`${ this.endpoint }/v1/broker/approve`, {
      method:  'POST',
      headers: {
        authorization:        `Bearer ${ this.serviceToken }`,
        'content-type':       'application/json',
        'x-sulla-service-id': this.serviceId,
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

export function getConfiguredCredentialBroker(): LocalVaultBrokerClient | null {
  if (configuredBroker !== undefined) return configuredBroker;
  const token = process.env.SULLA_VAULT_BROKER_TOKEN;
  const serviceId = process.env.SULLA_VAULT_BROKER_SERVICE_ID;
  configuredBroker = token && serviceId
    ? new LocalVaultBrokerClient(process.env.SULLA_VAULT_BROKER_URL ?? DEFAULT_VAULT_ENDPOINT, serviceId, token)
    : null;
  return configuredBroker;
}

export function requireConfiguredCredentialBroker(): LocalVaultBrokerClient {
  const broker = getConfiguredCredentialBroker();
  if (!broker) throw new VaultBrokerError('vault_unavailable', 'Vault broker service identity is not configured', 503);
  return broker;
}
