// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomBytes } from 'node:crypto';
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';
import { CLERK_APPROVAL_TTL_MS } from './LocalAuthorityLimits.js';
import { LocalVaultError } from './LocalVaultError.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import type { ItemRow } from './LocalAuthorityTypes.js';
import type { BrokerExecuteRequest } from '../contracts.js';

function object(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

/** Bind an approval to the validated write target, presented options, and credential revision. */
export class ClerkOperationApproval {
  constructor(private readonly host: LocalAuthorityHost, private readonly now: () => number) {}

  validateWrite(input: BrokerExecuteRequest, url: URL) {
    const method = input.method;
    const destructive = method === 'DELETE' || (method !== 'GET' && /(?:^|\/)(?:revoke|remove)(?:[_/-]|$)/i.test(url.pathname));
    if (destructive && input.clerk?.confirm !== true) {
      throw new LocalVaultError('invalid_operation', 400, 'This destructive Clerk action requires confirm: true (a boolean). Nothing was sent.');
    }
    // Approval UI shows the exact canonical path. Destructive operations take
    // their targets in the path; refuse alternate target-bearing payloads.
    const bodyKeys = Object.keys(object(input.body));
    const organizationInviteRevoke = /^\/v1\/organizations\/[^/]+\/invitations\/[^/]+\/revoke$/.test(url.pathname);
    const revokeActor = organizationInviteRevoke && bodyKeys.length === 1 && bodyKeys[0] === 'requesting_user_id' &&
      typeof object(input.body).requesting_user_id === 'string' &&
      /^user_[A-Za-z0-9]{1,200}$/.test(object(input.body).requesting_user_id as string);
    const sessionRevoke = /^\/v1\/sessions\/[^/]+\/revoke$/.test(url.pathname);
    const resetClientTrust = sessionRevoke && bodyKeys.length === 1 && bodyKeys[0] === 'reset_client_trust' &&
      typeof object(input.body).reset_client_trust === 'boolean';
    const emptyBody = input.body === undefined ||
      (!!input.body && typeof input.body === 'object' && !Array.isArray(input.body) && bodyKeys.length === 0);
    if (destructive && (url.search || (!emptyBody && !revokeActor && !resetClientTrust))) {
      throw new LocalVaultError('invalid_operation', 400, 'Destructive Clerk requests must identify their target in the path, without query or body parameters.');
    }
    // Clerk declares an optional JSON body on these two revoke endpoints and
    // answers 415 when the request has no JSON content type, so send {}.
    const wireBody = method === 'POST' && input.body === undefined && (organizationInviteRevoke || sessionRevoke) ? {} : input.body;
    return { destructive, wireBody };
  }

  private approvalOptions(path: string, body: unknown): Record<string, string | boolean> {
    const properties = object(body);
    if (/^\/v1\/sessions\/[^/]+\/revoke$/.test(path) &&
        Object.hasOwn(properties, 'reset_client_trust') && typeof properties.reset_client_trust === 'boolean') {
      return { reset_client_trust: properties.reset_client_trust };
    }
    if (/^\/v1\/organizations\/[^/]+\/invitations\/[^/]+\/revoke$/.test(path) &&
        typeof properties.requesting_user_id === 'string' &&
        /^user_[A-Za-z0-9]{1,200}$/.test(properties.requesting_user_id)) {
      return { requesting_user_id: properties.requesting_user_id };
    }
    return {};
  }

  requireApproval(
    input: BrokerExecuteRequest,
    item: ItemRow,
    context: {
      selectedEnvironment: 'staging' | 'production'; effectiveEnvironment: 'staging' | 'production'; instanceId: string;
      method: string; path: string;
    },
    askFirst: boolean,
  ): void {
    const options = this.approvalOptions(context.path, input.body);
    const bindingDigest = createHash('sha256').update(LocalAuthorityCrypto.canonical({
      identity: {
        sub: input.claims.sub,
        agentId: input.claims.agent_id,
        podId: input.claims.pod_id,
        orgId: input.claims.org_id ?? null,
        threadId: input.claims.thread_id ?? null,
        jobId: input.claims.job_id ?? null,
        workflowExecutionId: input.claims.workflow_execution_id ?? null,
        credentialScope: input.claims.credential_scope ?? null,
      },
      request: {
        operation: input.operation,
        ref: input.ref,
        url: input.url,
        method: input.method,
        body: input.body ?? null,
        headers: input.headers ?? {},
        bodyEncoding: input.bodyEncoding ?? null,
        injections: input.injections,
        responseType: input.responseType ?? 'json',
      },
      environment: context.selectedEnvironment,
      effectiveEnvironment: context.effectiveEnvironment,
      instanceId: context.instanceId,
      askFirst,
      confirm: input.clerk?.confirm === true,
      item:        item.id,
      revision:    item.revision,
    })).digest('base64url');
    const operationId = input.clerk?.operationId;
    const approval = input.approvalId ? this.host.approvals.get(input.approvalId) : undefined;
    if (input.approvalId) {
      this.host.approvals.delete(input.approvalId);
      if (approval?.digest === bindingDigest && approval.clerkOperationId === operationId && operationId && approval.expiresAt > this.now()) return;
      throw new LocalVaultError('policy_denied', 403, 'Clerk approval expired, was already used, or the connection changed. Nothing was sent.');
    }
    const now = this.now();
    for (const [id, pending] of this.host.pendingClerkApprovals) {
      if (pending.expiresAt <= now) this.host.pendingClerkApprovals.delete(id);
    }
    let attemptId = operationId;
    if (attemptId) {
      const pending = this.host.pendingClerkApprovals.get(attemptId);
      if (!pending || pending.expiresAt <= now || pending.digest !== bindingDigest) {
        this.host.pendingClerkApprovals.delete(attemptId);
        throw new LocalVaultError('policy_denied', 403, 'Clerk approval expired, was already used, or does not match this request. Nothing was sent.');
      }
    } else {
      attemptId = randomBytes(32).toString('base64url');
      this.host.pendingClerkApprovals.set(attemptId, { digest: bindingDigest, expiresAt: now + CLERK_APPROVAL_TTL_MS });
    }
    throw new LocalVaultError('approval_required', 428, attemptId, undefined, {
      ...context,
      options: { ...options },
    });
  }
}
