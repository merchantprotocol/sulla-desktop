// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { CLERK_ACCOUNT, CLERK_APPROVAL_MS, CLERK_DEADLINE_MS, CLERK_OPERATION, clerkEndpoints, type ClerkEnvironment } from './ClerkEndpoints';
import { ClerkApprovalCoordinator, type ClerkApprovalBinding } from './ClerkApprovalCoordinator';
import { ClerkRawRequestEnvelope } from './ClerkRawRequestEnvelope';
import { configuredVaultBrokerProvider, VaultApprovalRequiredError, VaultBrokerError } from '../../../vault-broker';
import { toolDecisionPort, type ToolDecisionPort } from '../../tools/toolDecisionPort';

import type { BrokerExecuteResponse, BrokerIntegrationMetadataResponse } from '../../../../../services/sulla-vault/src/contracts';
import type { LocalVaultBrokerClient } from '../../../vault-broker';
import type { ToolExecutionContext } from '../../tools/executionContext';

const CLERK_BASE = 'https://api.clerk.com';
const PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;
const SAFE_PARAMETER = /^[A-Za-z0-9._~-]{1,250}$/;

export class ClerkError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfter?: string) {
    super(message);
    this.name = 'ClerkError';
  }
}

export interface ClerkCaller {
  execution?:      ToolExecutionContext;
  conversationId?: string;
  channel?:        string;
  toolName?:       string;
  deadlineAt?:     number;
  revalidate?:     () => Promise<ToolExecutionContext>;
  signal?:         AbortSignal;
  showApproval?:   (id: string, title: string) => Promise<unknown>;
}

interface ClerkClientPorts {
  broker:    Pick<LocalVaultBrokerClient, 'requestFor' | 'execute' | 'integrationMetadata'>;
  authorize: (operationId: string) => Promise<string>;
  decisions: Pick<ToolDecisionPort, 'request' | 'findApprovalForPayload'>;
  context:   (caller: ClerkCaller) => Promise<ToolExecutionContext>;
}

export interface ClerkSectionSettings {
  connected:       boolean;
  publishableKey?: string;
  instanceId?:     string;
  warning?:        string;
}

export type ClerkSettings = Record<ClerkEnvironment, ClerkSectionSettings>;

export function clerkSettings(data: BrokerIntegrationMetadataResponse): ClerkSettings {
  const account = data.accounts.find(account => account.accountId === CLERK_ACCOUNT);
  const section = (env: ClerkEnvironment): ClerkSectionSettings => {
    const props = account?.properties;
    const publishableKey = props?.[`${ env }_publishable_key`];
    const instanceId = props?.[`${ env }_instance_id`];
    return {
      connected: !!(account?.connected && instanceId && publishableKey),
      publishableKey,
      instanceId,
      warning:   props?.[`${ env }_warning`],
    };
  };
  return { staging: section('staging'), production: section('production') };
}

function object(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${ value.map(canonical).join(',') }]`;
  return `{${ Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${ JSON.stringify(key) }:${ canonical(child) }`).join(',') }}`;
}

function requestHash(input: { method: string; url: URL; body: unknown; environment: ClerkEnvironment; confirm: boolean }): string {
  return createHash('sha256').update(canonical({
    method: input.method, url: input.url.toString(), body: input.body ?? null,
    environment: input.environment, confirm: input.confirm,
  })).digest('base64url');
}

function identityHash(context: ToolExecutionContext): string {
  return createHash('sha256').update(canonical({
    sub: context.sub, agentId: context.agent_id, podId: context.pod_id,
    orgId: context.org_id ?? null, threadId: context.thread_id ?? null, jobId: context.job_id ?? null,
    workflowExecutionId: context.workflow_execution_id ?? null, deviceId: context.device_id ?? null,
    groupIds: [...(context.group_ids ?? [])].sort(), scopes: [...(context.scopes ?? [])].sort(),
    credentialScope: context.credential_scope ?? null,
  })).digest('base64url');
}

function safeRetryAfter(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? String(seconds) : undefined;
}

function environmentOf(input: unknown): ClerkEnvironment {
  if (input === undefined || input === 'staging') return 'staging';
  if (input === 'production') return input;
  throw new ClerkError(400, 'Clerk environment must be staging or production.');
}

function canonicalUrl(pathInput: unknown, query: unknown): URL {
  if (typeof pathInput !== 'string' || pathInput.length > 8192 || pathInput.includes('#') || pathInput.includes('?')) {
    throw new ClerkError(400, 'Provide a relative Clerk Backend API path, for example /users.');
  }
  const path = pathInput;
  if (!PATH.test(path) || path.split('/').some(part => part === '.' || part === '..') ||
      /sk_(?:live|test)_/i.test(path)) throw new ClerkError(400, 'Invalid Clerk Backend API path.');
  const url = new URL(CLERK_BASE + (path.startsWith('/v1/') ? pathInput : `/v1${ pathInput }`));
  if (query !== undefined && !object(query)) throw new ClerkError(400, 'Clerk query must be a JSON object.');
  for (const [key, value] of Object.entries(object(query) ?? {})) {
    if (value === null || value === undefined) continue;
    url.searchParams.delete(key);
    for (const part of Array.isArray(value) ? value : [value]) {
      if (!['string', 'number', 'boolean'].includes(typeof part)) throw new ClerkError(400, 'Clerk query values must be strings, numbers, or booleans.');
      url.searchParams.append(key, String(part));
    }
  }
  return url;
}

function requestBody(input: unknown) {
  if (input === undefined) return undefined;
  if (!object(input)) throw new ClerkError(400, 'Clerk request body must be a JSON object.');
  return input;
}

function validateSpecialBody(path: string, input: unknown): Record<string, unknown> | undefined {
  const body = input === undefined ? undefined : object(input);
  if (input !== undefined && !body) throw new ClerkError(400, 'Clerk request body must be a JSON object.');
  if (/^\/v1\/sessions\/[^/]+\/revoke$/.test(path) && body) {
    if (Object.keys(body).some(key => key !== 'reset_client_trust') ||
        (Object.hasOwn(body, 'reset_client_trust') && typeof body.reset_client_trust !== 'boolean')) {
      throw new ClerkError(400, 'Session revocation only accepts reset_client_trust as a boolean option.');
    }
  }
  if (/^\/v1\/organizations\/[^/]+\/invitations\/[^/]+\/revoke$/.test(path) && body) {
    if (Object.keys(body).some(key => key !== 'requesting_user_id') ||
        (Object.hasOwn(body, 'requesting_user_id') &&
          (typeof body.requesting_user_id !== 'string' || !/^user_[A-Za-z0-9]{1,200}$/.test(body.requesting_user_id)))) {
      throw new ClerkError(400, 'Organization invitation revocation only accepts a valid requesting_user_id option.');
    }
  }
  return body;
}

function rejectsIgnoreExisting(path: string, body: Record<string, unknown> | undefined): boolean {
  return (path === '/v1/invitations' || /^\/v1\/organizations\/[^/]+\/invitations$/.test(path)) &&
    !!body && Object.keys(body).some(key => key.toLowerCase() === 'ignore_existing');
}

function responseError(status: number, body: unknown, retryAfter?: string): ClerkError {
  if (status === 404) return new ClerkError(status, 'Clerk could not find the requested resource.');
  if (status === 429) {
    const safe = safeRetryAfter(retryAfter);
    const seconds = safe ? Number(safe) : undefined;
    return new ClerkError(status, seconds ? `Clerk is rate limiting requests. Retry in ${ seconds } second${ seconds === 1 ? '' : 's' }.` : 'Clerk is rate limiting requests. Retry later.', safe);
  }
  if (status >= 500) return new ClerkError(status, 'Clerk is temporarily unavailable. Check whether a write succeeded before retrying.');
  if (status === 401 || status === 403) return new ClerkError(status, 'Clerk rejected the credential or denied this operation. Check the selected connection in Integrations.');
  const errors = object(body)?.errors;
  const codes = Array.isArray(errors) ? errors.map(error => object(error)?.code) : [];
  if (status === 409 || codes.some(code => typeof code === 'string' && /(?:already_exists|not_unique|duplicate|identifier_exists)/.test(code))) {
    return new ClerkError(status, 'A matching record already exists in Clerk.');
  }
  return new ClerkError(status, `Clerk rejected this request (HTTP ${ status }). Check the IDs and fields against the Clerk Backend API documentation.`);
}

export function clerkFailure(error: unknown): ClerkError {
  if (error instanceof ClerkError) return error;
  if (error instanceof VaultBrokerError) {
    if (error.status === 429) return new ClerkError(429, 'Clerk is rate limiting requests. Retry later.', safeRetryAfter(error.retryAfter));
    if (error.code === 'credential_field_missing') return new ClerkError(404, 'Clerk is not connected for this environment. Configure it in Integrations.');
    if (error.code === 'vault_locked') return new ClerkError(423, 'Unlock the Vault to use Clerk.');
    if (error.code === 'invalid_operation' && error.status === 400) return new ClerkError(400, error.message.replace(/sk_(?:live|test)_[A-Za-z0-9_-]+/g, '[REDACTED]'));
    if (error.code === 'invalid_operation' && error.status === 409) return new ClerkError(409, 'Clerk settings changed. Start a new request.');
    if (error.code === 'policy_denied') return new ClerkError(403, 'Clerk authorization was denied, expired, or the connection changed. Nothing further was sent.');
    if (error.code === 'upstream_unavailable' || error.code === 'upstream_timeout') {
      return new ClerkError(502, 'Clerk did not return a response. Check whether a write succeeded before retrying.');
    }
  }
  return new ClerkError(503, 'The local Clerk connection is unavailable. Check Vault and try again.');
}

export class ClerkClient {
  private readonly approvals: ClerkApprovalCoordinator;

  constructor(private readonly ports: ClerkClientPorts) {
    this.approvals = new ClerkApprovalCoordinator(ports.decisions, ports.authorize, Date.now, CLERK_APPROVAL_MS);
  }

  async config(caller: ClerkCaller, selected: unknown) {
    const environment = environmentOf(selected);
    // Bind this metadata load to the same trusted local principal as tool calls.
    await this.ports.context(caller);
    const settings = clerkSettings(await this.ports.broker.integrationMetadata('clerk', CLERK_ACCOUNT, caller.signal));
    return { environment, ...settings[environment], environments: settings };
  }

  async named(name: string, input: Record<string, unknown>, caller: ClerkCaller): Promise<unknown> {
    if (name === 'get_config') return this.config(caller, input.environment);
    if (name === 'raw_request') {
      const result = await this.raw(input, caller);
      return 'operationId' in result ? result : result.body;
    }
    const endpoint = Object.hasOwn(clerkEndpoints, name) ? clerkEndpoints[name] : undefined;
    if (!endpoint) throw new ClerkError(404, 'Unknown Clerk tool.');
    const path = endpoint.path.replace(/\{([a-z_]+)\}/g, (_match, key: string) => {
      const value = input[key];
      if (typeof value !== 'string' || !SAFE_PARAMETER.test(value) || value === '.' || value === '..') {
        throw new ClerkError(400, `Provide a valid Clerk ${ key }.`);
      }
      return value;
    });
    const filters = object(input.filters);
    if (input.filters !== undefined && !filters) throw new ClerkError(400, 'Clerk filters must be a JSON object.');
    const query: Record<string, unknown> = { ...(endpoint.defaultStatus ? { status: endpoint.defaultStatus } : {}), ...filters };
    if (name === 'list_sessions' && !query.user_id && !query.client_id) throw new ClerkError(400, 'Specify filters.user_id or filters.client_id to list Clerk sessions.');
    let page: { limit: number; offset: number } | undefined;
    if (endpoint.paged) {
      const limit = input.limit === undefined ? 50 : input.limit;
      const offset = input.offset === undefined ? 0 : input.offset;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
          typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        throw new ClerkError(400, 'Clerk pagination requires limit 1–500 and a non-negative integer offset.');
      }
      page = { limit, offset };
      Object.assign(query, page);
      if (['list_invitations', 'list_sessions'].includes(name)) query.paginated = true;
      if (name === 'list_users') {
        delete query.paginated;
        const cursor = input.starting_after ?? query.starting_after;
        if (cursor !== undefined && (typeof cursor !== 'string' || !/^user_[A-Za-z0-9]{1,200}$/.test(cursor) ||
          page.offset !== 0 || !this.cursorOrder(query.order_by))) {
          throw new ClerkError(400, 'Clerk user cursors require a valid starting_after user ID, offset 0, and order_by created_at.');
        }
        if (cursor !== undefined) query.starting_after = cursor;
      }
    }
    if (endpoint.body && !object(input.body)) throw new ClerkError(400, 'Provide a Clerk JSON body for this action.');
    const result = await this.raw({
      method:      endpoint.method,
      path,
      query,
      body:        endpoint.body || endpoint.optionalBody ? validateSpecialBody(path, input.body) : undefined,
      confirm:     input.confirm,
      environment: input.environment,
      operationId: input.operationId,
    }, caller);
    if (result.status === 'approval_pending') return result;
    const body = result.body;
    if (!page) return body;
    const envelope = object(body);
    const items = Array.isArray(envelope?.data) ? envelope.data : Array.isArray(body) ? body : undefined;
    if (!items) throw new ClerkError(502, 'Clerk returned a list in an unsupported format.');
    const total = typeof envelope?.total_count === 'number' ? envelope.total_count : undefined;
    const next = page.offset + items.length;
    const hasNext = items.length > 0 && (total !== undefined ? next < total : items.length === page.limit);
    if (name === 'list_users') {
      const lastId = object(items.at(-1))?.id;
      const nextCursor = hasNext && page.offset === 0 && this.cursorOrder(query.order_by) && typeof lastId === 'string' ? lastId : null;
      return { items, total_count: total, next_offset: hasNext && !query.starting_after ? next : null, next_cursor: nextCursor };
    }
    return { items, total_count: total, next_offset: hasNext ? next : null };
  }

  private cursorOrder(order: unknown): boolean {
    return order === undefined || order === 'created_at' || order === '+created_at' || order === '-created_at';
  }

  async raw(input: Record<string, unknown>, caller: ClerkCaller): Promise<BrokerExecuteResponse | { status: 'approval_pending'; operationId: string }> {
    const requestStartedAt = Date.now();
    const refusal = new ClerkRawRequestEnvelope().refusal(input, 'tool');
    if (refusal) throw new ClerkError(400, refusal);
    if (input.operationId !== undefined && (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.operationId))) {
      throw new ClerkError(400, 'Clerk operationId is invalid. Retry with the operationId returned by the approval request.');
    }
    const environment = environmentOf(input.environment);
    if (input.accountId !== undefined && input.accountId !== CLERK_ACCOUNT) throw new ClerkError(404, 'Clerk uses the default account.');
    if (input.headers !== undefined && (!object(input.headers) || Object.keys(object(input.headers) ?? {}).length)) {
      throw new ClerkError(400, 'Clerk does not accept caller-supplied headers.');
    }
    const method = input.method === undefined ? 'GET' : typeof input.method === 'string' ? input.method.toUpperCase() : '';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ClerkError(400, 'Unsupported Clerk HTTP method.');
    const url = canonicalUrl(input.path, input.query);
    const body = validateSpecialBody(url.pathname, requestBody(input.body));
    if (method === 'POST' && ([...url.searchParams.keys()].some(key => key.toLowerCase() === 'ignore_existing') || rejectsIgnoreExisting(url.pathname, body))) {
      throw new ClerkError(400, 'Clerk invitation creation does not allow ignore_existing; duplicate invitations must be rejected.');
    }
    const context = await this.ports.context(caller);
    const deadlineAt = Math.min(caller.deadlineAt ?? requestStartedAt + CLERK_DEADLINE_MS, requestStartedAt + CLERK_DEADLINE_MS);
    if (deadlineAt <= Date.now()) throw new ClerkError(504, 'Clerk request deadline expired. Nothing further was sent.');
    const request = this.ports.broker.requestFor(context, {
      operation:    CLERK_OPERATION,
      ref:          { integrationId: 'clerk', accountId: CLERK_ACCOUNT },
      url:          url.toString(),
      method,
      body,
      injections:   [],
      responseType: 'json',
      clerk:        { environment, confirm: input.confirm === true, deadlineAt, ...(input.operationId ? { operationId: input.operationId } : {}) },
    });
    if (Date.now() >= deadlineAt) throw new ClerkError(504, 'Clerk request deadline expired. Nothing further was sent.');
    if (caller.signal?.aborted) throw new ClerkError(400, 'Clerk request cancelled. Nothing was sent.');
    const binding: ClerkApprovalBinding = {
      identityHash: identityHash(context),
      requestHash: requestHash({ method, url, body, environment, confirm: input.confirm === true }),
      conversationId: caller.conversationId ?? context.thread_id ?? '',
      channel: caller.channel || 'sulla-desktop',
      title: '',
      showApproval: caller.showApproval,
    };
    if (!binding.conversationId) throw new ClerkError(403, 'This Clerk action requires Desktop Decide approval in an active conversation. Nothing was sent.');
    if (input.operationId) {
      const retry = await this.approvals.retry(input.operationId, binding);
      if (retry.state === 'pending') return { status: 'approval_pending', operationId: input.operationId };
      if (retry.state === 'denied') throw new ClerkError(403, 'Clerk action denied. Nothing was sent.');
      if (retry.state === 'expired') throw new ClerkError(403, 'Clerk approval expired or is no longer available. Nothing was sent.');
      if (retry.state !== 'approved' || !retry.approvalId) throw new ClerkError(403, 'Clerk approval is not available to this caller. Nothing was sent.');
      try { this.assertSameExecution(context, await this.ports.context(caller)) } catch {
        throw new ClerkError(403, 'Clerk authorization expired, was revoked, or changed before dispatch. Nothing was sent.');
      }
      if (Date.now() >= deadlineAt || caller.signal?.aborted) throw new ClerkError(504, 'Clerk request deadline expired before dispatch. Nothing was sent.');
      request.approvalId = retry.approvalId;
    }
    let response: BrokerExecuteResponse;
    try {
      response = await this.ports.broker.execute(request, caller.signal);
    } catch (error) {
      if (!(error instanceof VaultApprovalRequiredError)) throw clerkFailure(error);
      if (caller.signal?.aborted) throw new ClerkError(400, 'Clerk request cancelled. Nothing was sent.');
      const approvalContext = this.safeApprovalContext(error.approvalContext, environment, method, url.pathname);
      const action = this.approvalTitle(approvalContext);
      const state = await this.approvals.request(error.operationId, { ...binding, title: action });
      if (state === 'denied') throw new ClerkError(403, 'Clerk action denied. Nothing was sent.');
      if (state === 'expired') throw new ClerkError(403, 'Clerk approval expired. Nothing was sent.');
      if (state !== 'pending' && state !== 'approved') throw new ClerkError(403, 'Clerk approval could not be created. Nothing was sent.');
      return { status: 'approval_pending', operationId: error.operationId };
    }
    if (response.status < 200 || response.status >= 300) throw responseError(response.status, response.body, response.headers['retry-after']);
    return response;
  }

  private safeApprovalContext(
    input: VaultApprovalRequiredError['approvalContext'],
    selected: ClerkEnvironment,
    method: string,
    path: string,
  ) {
    if (!input || input.selectedEnvironment !== selected ||
        !['staging', 'production'].includes(input.effectiveEnvironment) ||
        !/^ins_[A-Za-z0-9]+$/.test(input.instanceId) || input.method !== method ||
        input.path !== path || !/^\/v1(?:\/[A-Za-z0-9._~-]+)+$/.test(input.path)) {
      throw new ClerkError(403, 'Clerk could not verify the approval target. Nothing was sent.');
    }
    const options: Record<string, string | boolean> = {};
    for (const [key, value] of Object.entries(input.options ?? {})) {
      if (key === 'reset_client_trust' && typeof value === 'boolean') options[key] = value;
      else if (key === 'requesting_user_id' && typeof value === 'string' && /^user_[A-Za-z0-9]{1,200}$/.test(value)) options[key] = value;
      else throw new ClerkError(403, 'Clerk approval options could not be verified. Nothing was sent.');
    }
    return { ...input, options };
  }

  private approvalTitle(context: NonNullable<VaultApprovalRequiredError['approvalContext']>): string {
    const options = Object.entries(context.options).map(([key, value]) => `${ key }=${ value }`).join(', ');
    return `Allow Clerk ${ context.selectedEnvironment } section (effective ${ context.effectiveEnvironment }, instance ${ context.instanceId }): ${ context.method } ${ context.path }${ options ? `; options ${ options }` : ''}?`;
  }

  private assertSameExecution(left: ToolExecutionContext, right: ToolExecutionContext): void {
    if (identityHash(left) !== identityHash(right)) {
      throw new ClerkError(403, 'Clerk authorization changed while approval was pending.');
    }
  }
}

export function createDesktopClerkClient(): ClerkClient {
  const provider = configuredVaultBrokerProvider;
  return new ClerkClient({
    broker:    provider.requireConfiguredCredentialBroker(),
    decisions: toolDecisionPort.resolve(),
    authorize: async operationId => {
      const owner = provider.getConfiguredApprovalClient();
      if (!owner) throw new ClerkError(503, 'Desktop Decide is unavailable.');
      return (await owner.approve(operationId)).approvalId;
    },
    context: async(caller) => {
      const scope = { integration_id: 'clerk', account_id: CLERK_ACCOUNT };
      let execution = caller.execution;
      if (caller.revalidate) {
        const refreshed = await caller.revalidate();
        if (execution && identityHash(execution) !== identityHash(refreshed)) {
          throw new ClerkError(403, 'This Clerk tool session no longer matches its active graph.');
        }
        execution = refreshed;
      }
      if (!execution) throw new ClerkError(403, 'This Clerk call is missing a trusted agent context.');
      const existing = execution.credential_scope;
      if (!execution.sub || !execution.agent_id?.trim() || !execution.pod_id?.trim() ||
          (existing?.integration_id && existing.integration_id !== 'clerk') ||
          (existing?.account_id && existing.account_id !== CLERK_ACCOUNT) || existing?.item_id ||
          execution.exp <= Math.floor(Date.now() / 1_000)) {
        throw new ClerkError(403, 'This tool session is not authorized for Clerk.');
      }
      return { ...execution, credential_scope: scope };
    },
  });
}
