// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomBytes } from 'node:crypto';
import { BrokerCredentialFields } from './BrokerCredentialFields.js';
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
  private readonly safeQueryParameterNames = new Set([
    'limit', 'offset', 'order_by', 'starting_after', 'ending_before', 'count',
  ]);

  private readonly safePreviewFieldNames = new Set([
    'email', 'email_address', 'first_name', 'last_name', 'name', 'username', 'role', 'slug', 'identifier', 'status',
    'banned', 'locked', 'suspended', 'reset_client_trust', 'public', 'created_at', 'updated_at', 'deleted_at',
  ]);

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

  private redactCredentialText(value: string, secrets: string[]): string {
    return BrokerCredentialFields.redactClerkKeys(value, secrets)
      .replace(/Bearer\s+\S+/gi, '[REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/[A-Fa-f0-9]{32,}/g, '[REDACTED]')
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[REDACTED]');
  }

  /** Encode untrusted controls and syntax separators while leaving our redaction marker readable. */
  private escapeDisplayText(value: string, secrets: string[], label: boolean): string {
    const redacted = this.redactCredentialText(value, secrets);
    const markers = /(\[REDACTED\]|\[redacted\])/gi;
    return redacted.split(markers).map(part => {
      if (/^\[(?:REDACTED|redacted)\]$/i.test(part)) return part;
      let escaped = '';
      for (const character of part) {
        const code = character.codePointAt(0) ?? 0;
        const format = /\p{Cf}/u.test(character);
        const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
        const separator = label
          ? [0x2e, 0x5b, 0x5d, 0x22, 0x5c, 0x2c, 0x3a, 0x3b, 0x3d, 0x26, 0x3f, 0x7c]
          : [0x22, 0x5c, 0x2c, 0x3a, 0x3b, 0x3d, 0x26, 0x3f, 0x7c];
        escaped += control || format || separator.includes(code) ? `\\u{${ code.toString(16) }}` : character;
      }
      return escaped;
    }).join('');
  }

  private isSensitiveFieldName(name: string): boolean {
    const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
    const compact = normalized.replace(/[^a-z0-9]/g, '');
    return normalized.split(/[^a-z0-9]+/).some(part => [
      'pass', 'password', 'secret', 'token', 'jwt', 'credential', 'credentials', 'digest',
    ].includes(part)) || [
      'privatekey', 'clientsecret', 'apikey', 'verificationcode', 'resetcode', 'signincode', 'actorcode', 'authorizationcode',
    ].some(part => compact.includes(part));
  }

  private fieldPath(path: string, key: string, secrets: string[]): string {
    const safeKey = this.escapeDisplayText(key, secrets, true);
    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) && safeKey === key) return path ? `${ path }.${ safeKey }` : safeKey;
    return `${ path }["${ safeKey }"]`;
  }

  private quoteDisplayText(value: string, secrets: string[]): string {
    return `"${ this.escapeDisplayText(value, secrets, false) }"`;
  }

  private scalarPreview(value: unknown, fieldName: string, metadata: boolean, secrets: string[]): string {
    const normalizedFieldName = fieldName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
    if (value === null) {
      if (metadata || !this.safePreviewFieldNames.has(normalizedFieldName)) return this.quoteDisplayText('[null]', secrets);
      return 'null';
    }
    if (typeof value === 'string') {
      if (this.redactCredentialText(value, secrets) !== value) return this.quoteDisplayText('[redacted]', secrets);
      if (metadata || [...value].length > 80 || !this.safePreviewFieldNames.has(normalizedFieldName)) return '"[set]"';
      return this.quoteDisplayText(value, secrets);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      if (metadata || !this.safePreviewFieldNames.has(normalizedFieldName)) return this.quoteDisplayText(`[${ typeof value }]`, secrets);
      return JSON.stringify(value);
    }
    return JSON.stringify(`[${ typeof value }]`);
  }

  /** Keep the summary complete, path-unique and bounded before asking a person to approve it. */
  private changedFields(body: unknown, secrets: string[]): Record<string, string> {
    const changes: Record<string, string> = Object.create(null) as Record<string, string>;
    const maxPaths = 40;
    const maxDepth = 64;
    const tooLarge = (): never => {
      throw new LocalVaultError('invalid_operation', 400, 'Clerk changes are too large to show on an approval card; split the change. Nothing was sent.');
    };
    const add = (path: string, value: string): void => {
      if (Object.hasOwn(changes, path) || Object.keys(changes).length >= maxPaths) tooLarge();
      changes[path] = value;
    };
    const visit = (value: unknown, path: string, sensitive = false, metadata = false, fieldName = '', depth = 0): void => {
      if (depth > maxDepth) tooLarge();
      const hidden = JSON.stringify('[redacted]');
      if (value === null || typeof value !== 'object') {
        add(path, sensitive ? hidden : this.scalarPreview(value, fieldName, metadata, secrets));
        return;
      }
      if (Array.isArray(value)) {
        if (!value.length) add(path, sensitive ? hidden : JSON.stringify('[empty array]'));
        else value.forEach((child, index) => visit(child, `${ path }[${ index }]`, sensitive, metadata, fieldName, depth + 1));
        return;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (!entries.length) add(path, sensitive ? hidden : JSON.stringify('[empty object]'));
      for (const [key, child] of entries) {
        const childMetadata = metadata || /_metadata$/i.test(key);
        if ((sensitive || childMetadata) && this.redactCredentialText(key, secrets) !== key) {
          throw new LocalVaultError('invalid_operation', 400, 'A sensitive Clerk field path cannot be shown unambiguously on the approval card. Nothing was sent.');
        }
        visit(child, this.fieldPath(path, key, secrets), sensitive || this.isSensitiveFieldName(key), childMetadata, key, depth + 1);
      }
    };

    if (body === undefined) return changes;
    if (Array.isArray(body)) visit(body, '$');
    else if (body !== null && typeof body === 'object') {
      const entries = Object.entries(body as Record<string, unknown>);
      if (!entries.length) {
        add('$', JSON.stringify('[empty object]'));
      } else {
        for (const [key, value] of entries) {
          visit(value, this.fieldPath('', key, secrets), this.isSensitiveFieldName(key), /_metadata$/i.test(key), key, 0);
        }
      }
    } else visit(body, '$');
    return changes;
  }

  /** Show every effective query pair; reveal values only for known pagination parameters. */
  private querySummary(input: BrokerExecuteRequest, secrets: string[]): string {
    const url = new URL(input.url);
    const pairs = [...url.searchParams.entries()].map(([key, value]) => {
      // No named Clerk write endpoint declares query parameters. Raw writes get the same empty allowlist.
      if (input.method !== 'GET' || !(this.safeQueryParameterNames.has(key) || ['user_id', 'client_id', 'status', 'query', 'paginated'].includes(key))) {
        throw new LocalVaultError('invalid_operation', 400, 'These query parameters are not supported on a Clerk approval card. Nothing was sent.');
      }
      const preview = this.isSensitiveFieldName(key) || this.redactCredentialText(value, secrets) !== value
        ? this.quoteDisplayText('[redacted]', secrets)
        : this.safeQueryParameterNames.has(key.toLowerCase()) && [...value].length <= 80
          ? this.quoteDisplayText(value, secrets)
          : this.quoteDisplayText('[set]', secrets);
      return `${ this.escapeDisplayText(key, secrets, true) }=${ preview }`;
    });
    return pairs.length ? `?${ pairs.join('&') }` : '';
  }

  private assertSummaryFits(
    context: { path: string; action: string; instanceId: string; requesterAgentId: string; jobId: string | null; threadId: string | null; method: string },
    query: string,
    options: Record<string, string | boolean>,
    changes: Record<string, string>,
  ): void {
    const changeText = Object.entries(changes).map(([path, value]) => `${ path }: ${ value }`).join(', ');
    const optionText = Object.entries(options).map(([key, value]) => `${ key }: ${ JSON.stringify(value) }`).join(', ');
    const variableText = [context.path, context.action, context.instanceId, context.requesterAgentId, context.jobId ?? '', context.threadId ?? '', context.method, query, optionText, changeText].join(' ');
    if (Object.keys(changes).length > 40 || variableText.length + 256 > 4_000) {
      throw new LocalVaultError('invalid_operation', 400, 'Clerk changes are too large to show on an approval card; split the change. Nothing was sent.');
    }
  }

  requireApproval(
    input: BrokerExecuteRequest,
    item: ItemRow,
    context: {
      selectedEnvironment: 'staging' | 'production';
      effectiveEnvironment: 'staging' | 'production';
      instanceId: string;
      method: string;
      path: string;
      requesterAgentId: string;
      jobId: string | null;
      threadId: string | null;
      action: string;
    },
    askFirst: boolean,
    secrets: string[] = [],
  ): void {
    const options = this.approvalOptions(context.path, input.body);
    const changes = this.changedFields(input.body, secrets);
    const query = this.querySummary(input, secrets);
    this.assertSummaryFits(context, query, options, changes);
    const bindingDigest = createHash('sha256').update(LocalAuthorityCrypto.canonical({
      identity: {
        sub: input.claims.sub,
        agentId: input.claims.agent_id,
        podId: input.claims.pod_id,
        orgId: input.claims.org_id ?? null,
        threadId: input.claims.thread_id ?? null,
        jobId: input.claims.job_id ?? null,
        workflowExecutionId: input.claims.workflow_execution_id ?? null,
        taskIndex: input.clerk?.binding?.taskIndex ?? null,
        sessionGeneration: input.clerk?.binding?.generation ?? null,
        credentialScope: input.claims.credential_scope ?? null,
      },
      request: {
        operation: input.operation,
        ref: input.ref,
        url: input.url,
        method: input.method,
        action: context.action,
        body: input.body ?? null,
        headers: input.headers ?? {},
        bodyEncoding: input.bodyEncoding ?? null,
        injections: input.injections,
        responseType: input.responseType ?? 'json',
      },
      environment: context.selectedEnvironment,
      effectiveEnvironment: context.effectiveEnvironment,
      instanceId: context.instanceId,
      action: context.action,
      changes,
      query,
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
      query,
      options: { ...options },
      changes,
    });
  }
}
