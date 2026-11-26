// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { setTimeout as sleep } from 'node:timers/promises';

import { AgentPolicyGate } from './AgentPolicyGate.js';
import { BrokerCredentialFields } from './BrokerCredentialFields.js';
import { ClerkKeyFormat } from './ClerkKeyFormat.js';
import { ClerkRetryPolicy } from './ClerkRetryPolicy.js';
import { ClerkOperationApproval } from './ClerkOperationApproval.js';
import { LocalVaultError } from './LocalVaultError.js';

import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import type { ItemRow } from './LocalAuthorityTypes.js';
import type { BrokerExecuteRequest, BrokerExecuteResponse } from '../contracts.js';
import type { VaultItemPlaintext } from '@sulla/vault-crypto';

const ORIGIN = 'https://api.clerk.com';
const ACCOUNT = 'default';
const ENVIRONMENTS = ['staging', 'production'] as const;
type Environment = typeof ENVIRONMENTS[number];
const SECRET = /^sk_(test|live)_[A-Za-z0-9_-]+$/;
// Allow canonical Clerk Backend API segments only. Encoded slashes, dot segments,
// duplicate separators, fragments, and matrix parameters cannot reach upstream.
const PATH = /^\/v1(?:\/[A-Za-z0-9._~-]+)+$/;
const OVERRIDE = /^(?:_?method|x[-_]http[-_]method(?:[-_]override)?|x[-_]method[-_]override)$/i;
const MAX_RETRY_ATTEMPTS = 3;
const REQUEST_RETRY_BUDGET_MS = 15_000;
const SETTINGS_RETRY_BUDGET_MS = 15_000;
const RETRY_SAFETY_MARGIN_MS = 1_000;
const REQUEST_FIELDS: readonly string[] = Object.freeze(['claims', 'operation', 'ref', 'url', 'method', 'headers', 'body', 'bodyEncoding', 'injections', 'approvalId', 'clerk', 'responseType']);
const CLERK_FIELDS: readonly string[] = Object.freeze(['environment', 'confirm', 'operationId', 'deadlineAt']);

function invalid(message: string): never {
  throw new LocalVaultError('invalid_operation', 400, message);
}

export class ClerkSavedPairRejectedError extends LocalVaultError {
  constructor(public readonly environment: Environment) {
    const label = environment === 'staging' ? 'Staging' : 'Production';
    super('invalid_operation', 400, `${ label }: Clerk rejected the saved key pair. This section was disconnected; enter active keys to reconnect.`);
  }
}

/** A non-200 status from a settings verification call; only the number is ever shown. */
class ClerkVerificationStatus extends Error {
  constructor(public readonly status: number) { super('Clerk verification failed'); }
}

function object(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

function redactJson(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return BrokerCredentialFields.redact(value, secrets).replace(/sk_(?:live|test)_[A-Za-z0-9_-]+/g, '[REDACTED]');
  if (Array.isArray(value)) return value.map(child => redactJson(child, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [String(redactJson(key, secrets)), redactJson(child, secrets)]));
}

/** The only vault egress for saved Clerk credentials, shared by named tools and both proxy paths. */
export class ClerkAuthority {
  private readonly approval: ClerkOperationApproval;
  private readonly retryPolicy: ClerkRetryPolicy;
  private readonly keyFormat = new ClerkKeyFormat();

  constructor(
    private readonly host: LocalAuthorityHost,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<unknown> = (ms, signal) => sleep(ms, undefined, { signal }),
    private readonly now: () => number = Date.now,
  ) {
    this.approval = new ClerkOperationApproval(host, now);
    this.retryPolicy = new ClerkRetryPolicy(this.now);
  }

  /** Desktop import sends both sections. Omitted sections retain only previously verified values. */
  async verifySettings(
    supplied: Record<string, string>,
    previous: Record<string, string>,
    generation: number,
    disconnect: boolean,
  ): Promise<Record<string, string>> {
    if (Object.keys(supplied).some(key => !ENVIRONMENTS.some(env => key === `${ env }_publishable_key` || key === `${ env }_secret_key`))) {
      invalid('Clerk settings contained an unexpected field.');
    }
    const settingsDeadlineAt = this.now() + SETTINGS_RETRY_BUDGET_MS;
    const output: Record<string, string> = {};
    for (const environment of ENVIRONMENTS) {
      const pkField = `${ environment }_publishable_key`;
      const skField = `${ environment }_secret_key`;
      const idField = `${ environment }_instance_id`;
      const warningField = `${ environment }_warning`;
      if (!disconnect && !(pkField in supplied) && !(skField in supplied)) {
        if (previous[pkField] && previous[skField] && previous[idField]) {
          for (const field of [pkField, skField, idField, warningField]) if (previous[field]) output[field] = previous[field];
        }
        continue;
      }
      const publishable = disconnect ? '' : (supplied[pkField] ?? '').trim();
      const secret = disconnect ? '' : (supplied[skField] ?? '').trim();
      if (!publishable && !secret) continue;
      const label = environment === 'staging' ? 'Staging' : 'Production';
      const pair = this.keyFormat.check(label, publishable, secret);
      if ('problem' in pair) invalid(pair.problem);
      const expectedHost = pair.frontendHost;
      let instance: BrokerExecuteResponse;
      let domains: BrokerExecuteResponse;
      try {
        instance = await this.sendWithRetry(new URL('/v1/instance', ORIGIN), 'GET', undefined, secret, [secret], generation, settingsDeadlineAt);
        if (instance.status === 429) throw this.retryPolicy.rateLimitError(instance.headers['retry-after']);
        if (instance.status === 401 && this.isSavedPair(environment, publishable, secret, previous)) {
          throw new ClerkSavedPairRejectedError(environment);
        }
        if (instance.status !== 200) throw new ClerkVerificationStatus(instance.status);
        domains = await this.sendWithRetry(new URL('/v1/domains', ORIGIN), 'GET', undefined, secret, [secret], generation, settingsDeadlineAt);
        if (domains.status === 429) throw this.retryPolicy.rateLimitError(domains.headers['retry-after']);
        if (domains.status === 401 && this.isSavedPair(environment, publishable, secret, previous)) {
          throw new ClerkSavedPairRejectedError(environment);
        }
        if (domains.status !== 200) throw new ClerkVerificationStatus(domains.status);
      } catch (error) {
        if (error instanceof ClerkSavedPairRejectedError) throw error;
        if (error instanceof LocalVaultError && error.status === 429) throw error;
        if (error instanceof ClerkVerificationStatus && (error.status === 401 || error.status === 403)) {
          invalid(`${ label }: Clerk rejected the secret key (HTTP ${ error.status }). Check that it is the current, active secret key for this instance.`);
        }
        if (error instanceof ClerkVerificationStatus) {
          invalid(`${ label }: Clerk could not verify the secret key (HTTP ${ error.status }). Try again in a moment.`);
        }
        invalid(`${ label }: Clerk could not be reached to verify the keys. Check the connection and try again.`);
      }
      const instanceData = object(instance.body);
      const instanceId = instanceData.id;
      if (typeof instanceId !== 'string' || !/^ins_[A-Za-z0-9]+$/.test(instanceId) ||
          instanceData.environment_type !== (pair.kind === 'live' ? 'production' : 'development')) {
        invalid(`${ label }: Clerk did not return the expected instance type.`);
      }
      const entries = object(domains.body).data;
      if (!Array.isArray(entries) || !entries.some(domain => {
        const data = object(domain);
        return typeof data.frontend_api_url === 'string' && this.keyFormat.frontendHost(data.frontend_api_url) === expectedHost;
      })) {
        invalid(`${ label }: the publishable key and the secret key are from different Clerk instances. Copy both from the same instance in the Clerk dashboard.`);
      }
      output[pkField] = publishable;
      output[skField] = secret;
      output[idField] = instanceId;
      if (pair.kind !== (environment === 'staging' ? 'test' : 'live')) {
        output[warningField] = `${ label } contains a ${ pair.kind === 'live' ? 'production' : 'development' } Clerk key. Production safeguards still apply.`;
      }
    }
    return output;
  }

  async execute(input: BrokerExecuteRequest, signal?: AbortSignal): Promise<BrokerExecuteResponse> {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !REQUEST_FIELDS.includes(key)) ||
        !input.clerk || typeof input.clerk !== 'object' || Array.isArray(input.clerk) ||
        Object.keys(input.clerk).some(key => !CLERK_FIELDS.includes(key))) {
      invalid('The Clerk request envelope contains unsupported or conflicting fields.');
    }
    if (input.clerk.confirm !== undefined && typeof input.clerk.confirm !== 'boolean') invalid('Clerk confirm must be a JSON boolean.');
    if (input.clerk.operationId !== undefined &&
        (typeof input.clerk.operationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.clerk.operationId))) {
      invalid('Clerk operationId must be the opaque ID returned with approval_pending.');
    }
    const scope = input.claims.credential_scope;
    if (input.ref.integrationId !== 'clerk' || input.ref.accountId !== ACCOUNT || scope?.integration_id !== 'clerk' ||
        scope.account_id !== ACCOUNT || input.injections.length || Object.keys(input.headers ?? {}).length ||
        input.bodyEncoding || (input.responseType !== undefined && input.responseType !== 'json')) {
      invalid('The Clerk request must use its saved integration account and standard JSON transport.');
    }
    const deadlineAt = this.requestDeadlineAt(input);
    const requestSignal = this.deadlineSignal(deadlineAt, signal);
    const environment = input.clerk?.environment === undefined ? 'staging' : input.clerk.environment;
    if (environment !== 'staging' && environment !== 'production') invalid('Clerk environment must be staging or production.');
    const method = input.method;
    const url = this.target(input.url);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) invalid('Unsupported Clerk HTTP method.');
    if ([...url.searchParams.keys(), ...Object.keys(object(input.body))].some(key => OVERRIDE.test(key))) invalid('HTTP method override is not supported.');
    if (method === 'POST' && this.isInvitationCreate(url.pathname) &&
        ([...url.searchParams.keys()].some(key => key.toLowerCase() === 'ignore_existing') ||
          Object.keys(object(input.body)).some(key => key.toLowerCase() === 'ignore_existing'))) {
      invalid('Clerk invitation creation does not allow ignore_existing; duplicate invitations must be rejected.');
    }
    const { destructive, wireBody } = this.approval.validateWrite(input, url);
    const vault = this.host.requireKeys();
    const generation = this.host.generation;
    if (vault.userId !== input.claims.sub) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const credential = await this.credential(input, environment, generation);
    if (requestSignal.aborted) throw this.interruption(signal);
    const production = environment === 'production' || credential.secret.startsWith('sk_live_');
    if ((destructive && production) || credential.askFirst || input.approvalId || input.clerk.operationId) {
      this.approval.requireApproval(input, credential.item, {
        selectedEnvironment: environment,
        effectiveEnvironment: production ? 'production' : 'staging',
        instanceId: credential.instanceId,
        method,
        path: url.pathname,
      }, credential.askFirst);
    }
    if (requestSignal.aborted) throw this.interruption(signal);
    let result: BrokerExecuteResponse;
    for (let attempt = 0; ; attempt++) {
      if (requestSignal.aborted) throw this.interruption(signal);
      this.host.requireGeneration(generation);
      if (attempt > 0) await this.assertCurrentCredential(input, environment, credential, generation, requestSignal);
      try {
        result = await this.send(url, method, wireBody, credential.secret, credential.secrets, generation, requestSignal, () =>
          this.assertCurrentCredential(input, environment, credential, generation, requestSignal));
      } catch (error) {
        if (requestSignal.aborted) throw this.interruption(signal);
        if (error instanceof LocalVaultError && error.code === 'invalid_operation') throw error;
        throw new LocalVaultError('upstream_unavailable', 502, 'Clerk did not return a response. Check whether the action succeeded before retrying a write.');
      }
      if (result.status !== 429 || attempt >= MAX_RETRY_ATTEMPTS - 1) break;
      const delay = this.retryPolicy.retryDelay(result.headers['retry-after'], attempt);
      const remaining = deadlineAt - this.now();
      if (delay.ms + RETRY_SAFETY_MARGIN_MS > remaining) {
        result = this.retryPolicy.withRetryAfter(result, delay.seconds);
        break;
      }
      try {
        await this.wait(delay.ms, requestSignal);
      } catch {
        if (requestSignal.aborted) throw this.interruption(signal);
        throw new LocalVaultError('invalid_operation', 400, 'Clerk request cancelled. Nothing further was sent.');
      }
    }
    // The authority already discarded upstream auth headers. Keep only a
    // bounded rate-limit hint, and redact values after JSON unescaping too.
    const retry = result.headers['retry-after'];
    this.host.parts.brokerAudit.auditClerkUse(input, credential.item);
    return {
      status:  result.status,
      headers: result.status === 429 ? { 'retry-after': this.retryPolicy.safeRetryAfter(retry) } : {},
      body:    redactJson(result.body, credential.secrets),
    };
  }

  private target(input: string): URL {
    if (typeof input !== 'string' || input.length > 8192 || !input.startsWith(`${ ORIGIN }/v1/`)) invalid('Clerk requests must target the Backend API.');
    const path = input.slice(ORIGIN.length).split('?')[0];
    if (!PATH.test(path) || path.split('/').some(part => part === '.' || part === '..') || input.includes('#')) invalid('Clerk path is not canonical.');
    if (/sk_(?:live|test)_/i.test(path)) invalid('Do not put credentials in a Clerk path.');
    return new URL(input);
  }

  private isInvitationCreate(path: string): boolean {
    return path === '/v1/invitations' || /^\/v1\/organizations\/[^/]+\/invitations$/.test(path);
  }

  private isSavedPair(
    environment: Environment,
    publishable: string,
    secret: string,
    previous: Record<string, string>,
  ): boolean {
    const instanceId = previous[`${ environment }_instance_id`];
    return previous[`${ environment }_publishable_key`] === publishable &&
      previous[`${ environment }_secret_key`] === secret &&
      typeof instanceId === 'string' && /^ins_[A-Za-z0-9]+$/.test(instanceId);
  }

  private async credential(input: BrokerExecuteRequest, environment: Environment, generation: number) {
    const keys = this.host.requireKeys();
    const result = await this.host.itemRepository.findOwnedIntegrationAccount<ItemRow>([keys.userId, `clerk/${ ACCOUNT }`]);
    const item = result.rows[0];
    const disconnected = () => new LocalVaultError('credential_field_missing', 404, `Clerk ${ environment } is not connected. Configure it in Integrations.`);
    if (!item) throw disconnected();
    const plaintext = JSON.parse(await this.host.openItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
      keys.userKey, { itemId: item.id, ownerId: keys.userId },
    )) as VaultItemPlaintext;
    const properties = plaintext.integration?.properties ?? {};
    const secret = properties[`${ environment }_secret_key`];
    const instanceId = properties[`${ environment }_instance_id`];
    if (properties.connection_status !== 'connected' || typeof instanceId !== 'string' ||
        !/^ins_[A-Za-z0-9]+$/.test(instanceId) ||
        typeof secret !== 'string' || !SECRET.test(secret)) throw disconnected();
    const agentPolicy = item.agent_policy ?? plaintext.agentPolicy;
    const policy = AgentPolicyGate.shared().allows(agentPolicy, {
      agentId: input.claims.agent_id, level: 'autofill', host: 'api.clerk.com', onServer: false,
    });
    if (!policy.allowed) throw new LocalVaultError('policy_denied', 403, 'Vault policy does not allow this Clerk connection.');
    this.host.requireGeneration(generation);
    return {
      item, secret, instanceId, agentPolicy, askFirst: agentPolicy?.askFirst === true,
      secrets: ENVIRONMENTS.map(env => properties[`${ env }_secret_key`]).filter(Boolean),
    };
  }

  private async assertCurrentCredential(
    input: BrokerExecuteRequest,
    environment: Environment,
    expected: Awaited<ReturnType<ClerkAuthority['credential']>>,
    generation: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new LocalVaultError('invalid_operation', 400, 'Clerk request cancelled. Nothing further was sent.');
    const current = await this.credential(input, environment, generation);
    if (current.item.id !== expected.item.id || current.item.revision !== expected.item.revision ||
        current.secret !== expected.secret || current.instanceId !== expected.instanceId ||
        current.askFirst !== expected.askFirst) {
      throw new LocalVaultError('invalid_operation', 409, 'Clerk settings changed. Start a new request.');
    }
    if (signal?.aborted) throw new LocalVaultError('invalid_operation', 400, 'Clerk request cancelled. Nothing further was sent.');
  }

  private async sendWithRetry(
    url: URL,
    method: string,
    body: unknown,
    secret: string,
    secrets: string[],
    generation: number,
    deadlineAt: number,
    signal?: AbortSignal,
    beforeWire: () => Promise<void> = () => Promise.resolve(),
  ): Promise<BrokerExecuteResponse> {
    const requestSignal = this.deadlineSignal(deadlineAt, signal);
    let result: BrokerExecuteResponse;
    for (let attempt = 0; ; attempt++) {
      if (requestSignal.aborted) throw this.interruption(signal);
      result = await this.send(url, method, body, secret, secrets, generation, requestSignal, beforeWire).catch(error => {
        if (requestSignal.aborted) throw this.interruption(signal);
        throw error;
      });
      if (result.status !== 429 || attempt >= MAX_RETRY_ATTEMPTS - 1) return result.status === 429
        ? this.retryPolicy.withRetryAfter(result, this.retryPolicy.retryDelay(result.headers['retry-after'], attempt).seconds)
        : result;
      const delay = this.retryPolicy.retryDelay(result.headers['retry-after'], attempt);
      const remaining = deadlineAt - this.now();
      if (delay.ms + RETRY_SAFETY_MARGIN_MS > remaining) return this.retryPolicy.withRetryAfter(result, delay.seconds);
      try {
        await this.wait(delay.ms, requestSignal);
      } catch {
        if (requestSignal.aborted) throw this.interruption(signal);
        throw new LocalVaultError('invalid_operation', 400, 'Clerk request cancelled. Nothing further was sent.');
      }
    }
  }

  private async send(
    url: URL,
    method: string,
    body: unknown,
    secret: string,
    secrets: string[],
    generation: number,
    signal?: AbortSignal,
    beforeWire: () => Promise<void> = () => Promise.resolve(),
  ): Promise<BrokerExecuteResponse> {
    const target = await this.host.parts.upstream.validateTarget(url.toString());
    this.host.requireGeneration(generation);
    if (signal?.aborted) throw new LocalVaultError('invalid_operation', 400, 'Clerk request cancelled. Nothing further was sent.');
    await beforeWire();
    if (signal?.aborted) throw new LocalVaultError('invalid_operation', 400, 'Clerk request cancelled. Nothing further was sent.');
    const variants = secrets.flatMap(key => [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]);
    return this.host.parts.upstream.send(
      target, method, { accept: 'application/json', authorization: `Bearer ${ secret }` }, body, 'json', variants,
      generation, true, undefined, undefined, 'broker.request', 'clerk', signal,
    );
  }

  private requestDeadlineAt(input: BrokerExecuteRequest): number {
    const now = this.now();
    const requested = input.clerk?.deadlineAt;
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      invalid('Clerk requires a finite absolute request deadline.');
    }
    const deadlineAt = Math.min(requested, now + REQUEST_RETRY_BUDGET_MS);
    if (deadlineAt <= now) throw new LocalVaultError('upstream_timeout', 504, 'Clerk request deadline expired. Nothing further was sent.');
    return deadlineAt;
  }

  private deadlineSignal(deadlineAt: number, parent?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(1, deadlineAt - this.now()));
    return parent ? AbortSignal.any([parent, timeout]) : timeout;
  }

  private interruption(parent?: AbortSignal): LocalVaultError {
    return parent?.aborted
      ? new LocalVaultError('invalid_operation', 400, 'Clerk request cancelled. Nothing further was sent.')
      : new LocalVaultError('upstream_timeout', 504, 'Clerk request deadline expired. Nothing further was sent.');
  }
}
