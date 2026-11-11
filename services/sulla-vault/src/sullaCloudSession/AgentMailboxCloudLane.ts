// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentPolicy } from '@sulla/vault-crypto';

import { AGENT_MAILBOX_OPERATIONS } from '../callerPolicies.js';
import { validateOperation } from '../operationPolicy.js';

import type { BrokerExecuteRequest, BrokerExecuteResponse } from '../contracts.js';

const SULLA_CLOUD_INTEGRATION = 'sulla-cloud';

/** The signed-in owner's Cloud session as the vault holds it. */
export interface AgentMailboxCloudSession {
  /** Account id of the active Sulla Cloud session, or null when signed out. */
  activeAccountId(): Promise<string | null>;
  /** A fresh access token for `request`, bound to its signed credential scope. */
  accessToken(request: BrokerExecuteRequest): Promise<{ credential: string; item: unknown }>;
}

/** Outbound HTTP and audit, provided by the local authority. */
export interface AgentMailboxCloudEgress {
  send(request: BrokerExecuteRequest, target: URL, headers: Record<string, string>, secrets: string[]): Promise<BrokerExecuteResponse>;
  audit(request: BrokerExecuteRequest, item: unknown): Promise<void>;
}

export type AgentMailboxLaneFailure = (code: string, status: number, message: string) => Error;

/**
 * Agent mail on the owner's own Sulla Cloud session. A verified agent may
 * reach only the /agent-mailboxes routes its caller policy allows; the vault
 * refreshes the session and injects the Bearer here, so the token never
 * leaves the vault. This is the one place agents may use the owner-only
 * Cloud session item, and only because the path, method, host and injection
 * are pinned by `sulla-cloud.agent-mailboxes.*`.
 */
export class AgentMailboxCloudLane {
  private static readonly FORWARDED_HEADERS = new Set(['accept', 'content-type']);
  private static readonly NO_SITES = { sites: [] } as unknown as AgentPolicy;

  constructor(
    private readonly host: string,
    private readonly session: AgentMailboxCloudSession,
    private readonly egress: AgentMailboxCloudEgress,
    private readonly fail: AgentMailboxLaneFailure,
  ) {}

  static handles(operation: string): boolean {
    return AGENT_MAILBOX_OPERATIONS.includes(operation);
  }

  async execute(input: BrokerExecuteRequest): Promise<BrokerExecuteResponse> {
    const target = this.target(input.url);
    if ((input.responseType ?? 'json') !== 'json' || input.bodyEncoding !== undefined) {
      throw this.fail('invalid_operation', 400, 'Agent mailbox requests are JSON only');
    }
    try {
      validateOperation(input, target.hostname, AgentMailboxCloudLane.NO_SITES);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'policy_denied';
      throw this.fail(['method_denied', 'destination_denied', 'path_denied', 'injection_denied', 'integration_denied'].includes(reason) ? reason : 'policy_denied',
        403, 'Agent mailbox operation policy denied the request');
    }
    const scope = input.claims?.credential_scope;
    if (input.ref.integrationId !== SULLA_CLOUD_INTEGRATION || scope?.integration_id !== SULLA_CLOUD_INTEGRATION ||
        !input.ref.accountId || scope.account_id !== input.ref.accountId) {
      throw this.fail('policy_denied', 403, 'Credential reference is outside the signed caller scope');
    }
    const active = await this.session.activeAccountId();
    if (!active || active !== input.ref.accountId) {
      throw this.fail('credential_field_missing', 404, 'Sulla Cloud session is unavailable; sign in again');
    }
    const { credential, item } = await this.session.accessToken(input);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (AgentMailboxCloudLane.FORWARDED_HEADERS.has(name.toLowerCase()) && typeof value === 'string') headers[name.toLowerCase()] = value;
    }
    headers.authorization = `Bearer ${ credential }`;
    const result = await this.egress.send(input, target, headers, [credential, headers.authorization]);
    await this.egress.audit(input, item);
    return result;
  }

  private target(raw: string): URL {
    let target: URL;
    try { target = new URL(raw) } catch {
      throw this.fail('invalid_operation', 400, 'Agent mailbox request URL is invalid');
    }
    if (target.protocol !== 'https:' || target.hostname !== this.host || target.port || target.username || target.password || target.hash) {
      throw this.fail('destination_denied', 403, 'Agent mailbox requests must go to Sulla Cloud');
    }
    return target;
  }
}
