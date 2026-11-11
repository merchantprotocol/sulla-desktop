// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailError } from './AgentMailError';

import type { ToolExecutionContext } from '../executionContext';
import type { BrokerExecuteRequest, BrokerExecuteResponse } from '../../../vault-broker';

/** Vault account and field that hold the AGENT_MAIL_TOKEN. */
export const AGENT_MAIL_INTEGRATION_ID = 'sulla_agent_mail';
export const AGENT_MAIL_TOKEN_FIELD = 'token';
/** Vault broker operation (services/sulla-vault/src/callerPolicies.ts). */
export const AGENT_MAIL_BROKER_OPERATION = 'sulla-agent-mail.api';

export interface AgentMailHttpRequest {
  method: 'GET' | 'POST';
  /** Path under the Cloud API origin, e.g. /agent-mail/abc/read. */
  path:   string;
  query?: Record<string, string | undefined>;
  body?:  unknown;
}

export interface AgentMailHttpResponse {
  status: number;
  body:   unknown;
}

/** Sends one authenticated request to the agent mail API. The token never reaches the caller. */
export interface AgentMailTransport {
  request(request: AgentMailHttpRequest, ctx: ToolExecutionContext | undefined): Promise<AgentMailHttpResponse>;
}

/** The slice of the vault broker client this transport uses. */
export interface AgentMailBroker {
  requestFor(ctx: ToolExecutionContext, request: Omit<BrokerExecuteRequest, 'claims'>): BrokerExecuteRequest;
  execute(request: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse>;
}

class AgentMailUrl {
  static build(baseUrl: string, request: AgentMailHttpRequest): string {
    const url = new URL(request.path, baseUrl);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

/**
 * Desktop vault mode (the default): the vault broker injects the token
 * outbound, so it never enters this process.
 */
export class BrokerAgentMailTransport implements AgentMailTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly broker: () => Promise<AgentMailBroker>,
    private readonly activeAccountId: () => Promise<string>,
  ) {}

  async request(request: AgentMailHttpRequest, ctx: ToolExecutionContext | undefined): Promise<AgentMailHttpResponse> {
    if (!ctx) throw new AgentMailError('rejected', 'Agent mail tools require a verified caller identity');
    let accountId: string;
    try {
      accountId = await this.activeAccountId();
    } catch {
      throw AgentMailError.tokenMissing();
    }
    if (ctx.credential_scope?.integration_id !== AGENT_MAIL_INTEGRATION_ID || ctx.credential_scope.account_id !== accountId) {
      throw AgentMailError.tokenMissing();
    }
    const broker = await this.broker();
    try {
      const result = await broker.execute(broker.requestFor(ctx, {
        operation:    AGENT_MAIL_BROKER_OPERATION,
        ref:          { integrationId: AGENT_MAIL_INTEGRATION_ID, accountId },
        url:          AgentMailUrl.build(this.baseUrl, request),
        method:       request.method,
        headers:      { accept: 'application/json', ...(request.body === undefined ? {} : { 'content-type': 'application/json' }) },
        body:         request.body,
        injections:   [{ field: AGENT_MAIL_TOKEN_FIELD, target: 'header', name: 'authorization', scheme: 'Bearer' }],
        responseType: 'json',
      }));
      return { status: result.status, body: result.body };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 'credential_field_missing' || code === 'not_found' || code === 'integration_denied') throw AgentMailError.tokenMissing();
      if (code === 'vault_locked') throw new AgentMailError('rejected', 'The Sulla vault is locked. Unlock it and retry.');
      throw new AgentMailError('server_error', `Agent mail request failed${ typeof code === 'string' ? ` (${ code })` : '' }`);
    }
  }
}

export type AgentMailFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Server vault mode (SULLA_VAULT_MODE=server): reads the token in-process and
 * sends it only in the Authorization header. Any echo of it is scrubbed.
 */
export class DirectAgentMailTransport implements AgentMailTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => Promise<string | null>,
    private readonly fetcher: AgentMailFetch = (url, init) => fetch(url, init),
  ) {}

  async request(request: AgentMailHttpRequest): Promise<AgentMailHttpResponse> {
    const token = (await this.token().catch(() => null))?.trim();
    if (!token) throw AgentMailError.tokenMissing();
    let response: Response;
    try {
      response = await this.fetcher(AgentMailUrl.build(this.baseUrl, request), {
        method:  request.method,
        headers: {
          accept:        'application/json',
          authorization: `Bearer ${ token }`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch {
      throw new AgentMailError('server_error', 'Agent mail API is unreachable');
    }
    const text = (await response.text().catch(() => '')).split(token).join('[redacted]');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text.slice(0, 200) };
    }
    return { status: response.status, body };
  }
}
