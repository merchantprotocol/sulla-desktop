// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 app.ts characterization: the vault HTTP app must keep the exact route table, middleware
// order and per-route HTTP behaviour (status, headers, body, error codes, authority calls) of the
// frozen pre-refactor copy. Every case runs the legacy app and the current app side by side.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../../../../services/sulla-vault/src/app';
import { LocalVaultError } from '../../../../../../services/sulla-vault/src/localAuthority';
import { createApp as createLegacyApp } from '../../Support/E9Legacy/app.legacy';
import {
  AuthorityDouble, DatabaseDouble, VaultAppConfigFactory, VaultAppProbe, VaultRouteTable,
  type HttpOutcome, type HttpRequestSpec, type RecordedCall, type VaultAppFactory,
} from '../../Support/Vault/E9VaultAppHarness';

const HUMAN_ORIGIN = VaultAppConfigFactory.humanUiOrigin;
const APPROVAL = { 'x-sulla-service-id': VaultAppConfigFactory.approvalServiceId, authorization: `Bearer ${ VaultAppConfigFactory.approvalServiceToken }` };
const SERVICE = { 'x-sulla-service-id': 'sulla-tools', authorization: 'bearer broker-token' };
const FILES = { 'x-sulla-service-id': 'sulla-files', authorization: `Bearer files_${ 'e'.repeat(64) }` };
const HUMAN = { origin: HUMAN_ORIGIN, cookie: 'other=1; sulla_vault_human=sess-1', 'x-csrf-token': 'csrf-1' };
const EXPIRES_AT = Date.now() + 600_000;
const SESSION = { sessionId: 'sess-2', csrf: 'csrf-2', expiresAt: EXPIRES_AT, phase: 'unlocked', state: 'unlocked', cacheMode: 'memory', extra: 'hidden' };
const ITEM_ID = '40000000-0000-4000-8000-000000000001';

interface RouteCase {
  name: string;
  request: HttpRequestSpec;
  status: number;
  setup?: (authority: AuthorityDouble, database: DatabaseDouble) => void;
}

const vaultError = (code: string, status: number, message: string, reason?: string) => () => { throw new LocalVaultError(code, status, message, reason) };
const denyApproval = (authority: AuthorityDouble) => authority.on('requireApprovalIdentity', vaultError('invalid_service_identity', 401, 'Desktop service identity is invalid'));
const throwing = (error: unknown) => async() => { throw error };

/** Runs one request against the legacy app and the current app with identical doubles. */
class AppEquivalence {
  private readonly probe = new VaultAppProbe();
  private readonly config = new VaultAppConfigFactory();

  async run(factory: VaultAppFactory, routeCase: RouteCase): Promise<{ outcome: HttpOutcome; calls: RecordedCall[]; queries: unknown[] }> {
    const authority = new AuthorityDouble();
    const database = new DatabaseDouble();
    routeCase.setup?.(authority, database);
    const app = factory(database.db, this.config.create(), { localAuthority: authority.authority });
    const outcome = await this.probe.send(app, routeCase.request);
    return { outcome, calls: authority.calls, queries: database.queries };
  }

  async compare(routeCase: RouteCase): Promise<void> {
    const legacy = await this.run(createLegacyApp as VaultAppFactory, routeCase);
    const current = await this.run(createApp as VaultAppFactory, routeCase);
    expect(legacy.outcome.status, `${ routeCase.name }: legacy status`).toBe(routeCase.status);
    if (legacy.outcome.maxAge !== undefined || current.outcome.maxAge !== undefined) {
      expect(Math.abs((legacy.outcome.maxAge ?? -10) - (current.outcome.maxAge ?? 10)), `${ routeCase.name }: cookie Max-Age`).toBeLessThanOrEqual(1);
    }
    expect({ ...current.outcome, maxAge: undefined }, routeCase.name).toEqual({ ...legacy.outcome, maxAge: undefined });
    expect(current.calls, `${ routeCase.name }: authority calls`).toEqual(legacy.calls);
    expect(current.queries, `${ routeCase.name }: database queries`).toEqual(legacy.queries);
  }
}

const cases: RouteCase[] = [
  // CORS preflight and headers
  { name: 'preflight from a chrome extension', status: 204, request: { method: 'OPTIONS', path: '/v1/broker/status', headers: { origin: 'chrome-extension://abc' } } },
  { name: 'preflight from a configured extension origin', status: 204, request: { method: 'OPTIONS', path: '/v1/human/items', headers: { origin: 'https://ext.example.test' } } },
  { name: 'preflight from an unknown origin', status: 403, request: { method: 'OPTIONS', path: '/v1/broker/status', headers: { origin: 'https://evil.example.test' } } },
  { name: 'preflight without origin', status: 403, request: { method: 'OPTIONS', path: '/healthz' } },
  { name: 'CORS headers on a normal extension request', status: 200, request: { method: 'GET', path: '/healthz', headers: { origin: 'chrome-extension://abc' } } },
  // health
  { name: 'healthz with Postgres up', status: 200, request: { method: 'GET', path: '/healthz' } },
  { name: 'healthz with Postgres down', status: 503, request: { method: 'GET', path: '/healthz' }, setup: (_a, db) => { db.failure = Object.assign(new Error('down'), { code: '57P01' }) } },
  { name: 'healthz with a non-transient database error', status: 500, request: { method: 'GET', path: '/healthz' }, setup: (_a, db) => { db.failure = Object.assign(new Error('boom'), { code: '42P01' }) } },
  // desktop control
  { name: 'backup credentials with the wrong identity', status: 401, request: { method: 'POST', path: '/v1/desktop/backup-credentials', headers: SERVICE, body: { itemId: ITEM_ID, target: 'nas-1' } } },
  { name: 'backup credentials with no identity', status: 401, request: { method: 'POST', path: '/v1/desktop/backup-credentials', body: {} } },
  { name: 'backup credentials', status: 200, request: { method: 'POST', path: '/v1/desktop/backup-credentials', headers: APPROVAL, body: { itemId: ITEM_ID, target: 'nas-1' } }, setup: a => { a.on('backupCredentials', async(...args) => ({ args })) } },
  { name: 'backup credentials without itemId', status: 400, request: { method: 'POST', path: '/v1/desktop/backup-credentials', headers: APPROVAL, body: { target: 'nas-1' } } },
  { name: 'bootstrap challenge', status: 200, request: { method: 'POST', path: '/v1/desktop/bootstrap/challenge', body: { callerId: 'c', clientNonce: 'n', clientProof: 'p' } } },
  { name: 'bootstrap challenge with an empty proof', status: 400, request: { method: 'POST', path: '/v1/desktop/bootstrap/challenge', body: { callerId: 'c', clientNonce: 'n', clientProof: '' } } },
  { name: 'bootstrap challenge with no body', status: 500, request: { method: 'POST', path: '/v1/desktop/bootstrap/challenge' } },
  { name: 'bootstrap challenge with malformed JSON', status: 500, request: { method: 'POST', path: '/v1/desktop/bootstrap/challenge', rawBody: '{nope' } },
  { name: 'bootstrap unlock', status: 200, request: { method: 'POST', path: '/v1/desktop/bootstrap/unlock', body: { callerId: 'c', challengeId: 'h', clientProof: 'p', sealedUnlock: 's', ignored: 1 } } },
  { name: 'bootstrap unlock rejected by the authority', status: 403, request: { method: 'POST', path: '/v1/desktop/bootstrap/unlock', body: { callerId: 'c', challengeId: 'h', clientProof: 'p', sealedUnlock: 's' } }, setup: a => { a.on('unlock', vaultError('invalid_proof', 403, 'Proof is invalid', 'proof')) } },
  { name: 'cache challenge', status: 200, request: { method: 'POST', path: '/v1/desktop/cache/challenge', body: { callerId: 'c', clientNonce: 'n', clientProof: 'p' } } },
  { name: 'cache fetch with a sealed legacy key', status: 200, request: { method: 'POST', path: '/v1/desktop/cache/fetch', body: { callerId: 'c', challengeId: 'h', clientProof: 'p', sealedLegacyVmk: 'vmk' } } },
  { name: 'cache fetch with a non-string legacy key', status: 200, request: { method: 'POST', path: '/v1/desktop/cache/fetch', body: { callerId: 'c', challengeId: 'h', clientProof: 'p', sealedLegacyVmk: 7 } } },
  { name: 'status with a bad control identity', status: 401, request: { method: 'GET', path: '/v1/desktop/status', headers: SERVICE }, setup: a => { a.on('requireControlIdentity', vaultError('invalid_service_identity', 401, 'Desktop service identity is invalid')) } },
  { name: 'status unlocked', status: 200, request: { method: 'GET', path: '/v1/desktop/status', headers: SERVICE }, setup: a => { a.on('status', () => ({ unlocked: true, state: 'unlocked', principalId: 'p' })) } },
  { name: 'status locked needing setup after a failed migration', status: 200, request: { method: 'GET', path: '/v1/desktop/status' }, setup: a => { a.on('status', () => ({ unlocked: false, state: 'migration_failed' })).on('isSetupRequired', async() => true) } },
  { name: 'status locked needing migration', status: 200, request: { method: 'GET', path: '/v1/desktop/status' }, setup: a => { a.on('status', () => ({ unlocked: false, state: 'migration_required' })).on('isSetupRequired', async() => false) } },
  { name: 'lock', status: 200, request: { method: 'POST', path: '/v1/desktop/lock', headers: SERVICE } },
  { name: 'migrate', status: 200, request: { method: 'POST', path: '/v1/desktop/migrate', headers: SERVICE } },
  // human session
  { name: 'human session without a browser target', status: 200, request: { method: 'POST', path: '/v1/human/session', headers: SERVICE, body: {} }, setup: a => { a.on('createHumanSession', () => ({ sessionId: 'g 1&x', csrf: 'c/1', expiresAt: EXPIRES_AT, phase: 'pre-unlock' })) } },
  { name: 'human session with a browser target', status: 200, request: { method: 'POST', path: '/v1/human/session', headers: SERVICE, body: { browserTarget: { tabId: 't1', origin: 'https://site.test', extra: true } } }, setup: a => { a.on('createHumanSession', () => ({ sessionId: 'g', csrf: 'c', expiresAt: EXPIRES_AT, phase: 'unlocked' })) } },
  { name: 'human session with an incomplete browser target', status: 400, request: { method: 'POST', path: '/v1/human/session', body: { browserTarget: { tabId: 't1' } } } },
  { name: 'human session with no body', status: 500, request: { method: 'POST', path: '/v1/human/session' }, setup: a => { a.on('createHumanSession', () => { throw new TypeError('no session') }) } },
  { name: 'human exchange without origin', status: 403, request: { method: 'POST', path: '/v1/human/session/exchange', body: { grant: 'g', csrf: 'c' } } },
  { name: 'human exchange from the wrong origin', status: 403, request: { method: 'POST', path: '/v1/human/session/exchange', headers: { origin: 'https://evil.example.test' }, body: { grant: 'g', csrf: 'c' } } },
  { name: 'human exchange cross-site', status: 403, request: { method: 'POST', path: '/v1/human/session/exchange', headers: { origin: HUMAN_ORIGIN, 'sec-fetch-site': 'cross-site' }, body: { grant: 'g', csrf: 'c' } } },
  { name: 'human exchange pre-unlock', status: 200, request: { method: 'POST', path: '/v1/human/session/exchange', headers: { origin: HUMAN_ORIGIN, 'sec-fetch-site': 'same-origin' }, body: { grant: 'g', csrf: 'c' } }, setup: a => { a.on('exchangeHumanGrant', () => ({ ...SESSION, phase: 'pre-unlock', browserTarget: { origin: 'https://site.test' } })).on('isSetupRequired', async() => true) } },
  { name: 'human exchange unlocked', status: 200, request: { method: 'POST', path: '/v1/human/session/exchange', headers: { origin: HUMAN_ORIGIN }, body: { grant: 'g', csrf: 'c' } }, setup: a => { a.on('exchangeHumanGrant', () => SESSION) } },
  { name: 'human exchange without csrf', status: 400, request: { method: 'POST', path: '/v1/human/session/exchange', headers: { origin: HUMAN_ORIGIN }, body: { grant: 'g' } } },
  { name: 'human session status without origin', status: 200, request: { method: 'GET', path: '/v1/human/session', headers: { cookie: 'sulla_vault_human=abc', 'x-csrf-token': 't' } }, setup: a => { a.on('humanSessionStatus', () => ({ phase: 'pre-unlock', csrf: 't' })).on('isSetupRequired', async() => false) } },
  { name: 'human session status from the wrong origin', status: 403, request: { method: 'GET', path: '/v1/human/session', headers: { origin: 'https://evil.example.test' } } },
  { name: 'human session status with no cookie', status: 423, request: { method: 'GET', path: '/v1/human/session', headers: HUMAN }, setup: a => { a.on('humanSessionStatus', vaultError('human_session_required', 423, 'Human session required')) } },
  { name: 'human unlock', status: 200, request: { method: 'POST', path: '/v1/human/unlock', headers: HUMAN, body: { password: 'pw' } }, setup: a => { a.on('unlockHumanSession', async() => SESSION) } },
  { name: 'human unlock without password', status: 400, request: { method: 'POST', path: '/v1/human/unlock', headers: HUMAN, body: { password: 5 } } },
  { name: 'human password change', status: 200, request: { method: 'POST', path: '/v1/human/password', headers: HUMAN, body: { currentPassword: 'a', nextPassword: 'b' } } },
  { name: 'human password change without next password', status: 400, request: { method: 'POST', path: '/v1/human/password', headers: HUMAN, body: { currentPassword: 'a' } } },
  { name: 'human recovery configure', status: 204, request: { method: 'POST', path: '/v1/human/recovery/configure', headers: HUMAN, body: { recoveryCode: 'r' } } },
  { name: 'human recovery unlock', status: 200, request: { method: 'POST', path: '/v1/human/recovery/unlock', headers: HUMAN, body: { recoveryCode: 'r', nextPassword: 'n' } }, setup: a => { a.on('recoverHumanSession', async() => SESSION) } },
  { name: 'human backup export', status: 200, request: { method: 'POST', path: '/v1/human/backup/export', headers: HUMAN, body: { backupPassword: 'b' } } },
  { name: 'human backup import', status: 204, request: { method: 'POST', path: '/v1/human/backup/import', headers: HUMAN, body: { backupPassword: 'b', backup: { version: 1 } } } },
  { name: 'human backup import with an array backup', status: 400, request: { method: 'POST', path: '/v1/human/backup/import', headers: HUMAN, body: { backupPassword: 'b', backup: [] } } },
  { name: 'human lock', status: 200, request: { method: 'POST', path: '/v1/human/lock', headers: HUMAN }, setup: a => { a.on('lockHumanSession', async() => ({ ...SESSION, phase: 'pre-unlock' })) } },
  { name: 'human items list', status: 200, request: { method: 'GET', path: '/v1/human/items', headers: HUMAN }, setup: a => { a.on('listHumanItems', async() => [{ id: ITEM_ID }]) } },
  { name: 'human bitwarden preview', status: 200, request: { method: 'POST', path: '/v1/human/import/bitwarden/preview', headers: HUMAN, body: { file: 'x' } } },
  { name: 'human bitwarden import', status: 200, request: { method: 'POST', path: '/v1/human/import/bitwarden', headers: HUMAN, body: { file: 'x' } } },
  { name: 'human item create', status: 201, request: { method: 'POST', path: '/v1/human/items', headers: HUMAN, body: { name: 'n' } } },
  { name: 'human item reveal', status: 200, request: { method: 'POST', path: `/v1/human/items/${ ITEM_ID }/reveal`, headers: HUMAN } },
  { name: 'human item update', status: 200, request: { method: 'PATCH', path: `/v1/human/items/${ ITEM_ID }`, headers: HUMAN, body: { id: 'ignored', name: 'n' } } },
  { name: 'human item delete', status: 204, request: { method: 'DELETE', path: `/v1/human/items/${ ITEM_ID }?revision=3`, headers: HUMAN } },
  { name: 'human item delete without revision', status: 204, request: { method: 'DELETE', path: `/v1/human/items/${ ITEM_ID }`, headers: HUMAN } },
  { name: 'human item locked on a human path', status: 423, request: { method: 'POST', path: `/v1/human/items/${ ITEM_ID }/reveal`, headers: HUMAN }, setup: a => { a.on('revealHumanItem', vaultError('upstream_failed', 423, 'locked', 'r')) } },
  // broker
  { name: 'broker approve', status: 200, request: { method: 'POST', path: '/v1/broker/approve', headers: SERVICE, body: { operationId: 'op' } } },
  { name: 'broker approve without operation', status: 400, request: { method: 'POST', path: '/v1/broker/approve', headers: SERVICE, body: {} } },
  { name: 'broker status', status: 200, request: { method: 'GET', path: '/v1/broker/status', headers: SERVICE } },
  { name: 'broker items', status: 200, request: { method: 'POST', path: '/v1/broker/items', headers: SERVICE, body: { claims: { agentId: 'a' } } } },
  { name: 'broker item create', status: 201, request: { method: 'POST', path: '/v1/broker/items/create', headers: SERVICE, body: { name: 'n' } } },
  { name: 'broker item update', status: 200, request: { method: 'PATCH', path: `/v1/broker/items/${ ITEM_ID }`, headers: SERVICE, body: { itemId: 'ignored', name: 'n' } } },
  { name: 'broker integration credential', status: 200, request: { method: 'PUT', path: '/v1/broker/integrations/github/credential', headers: SERVICE, body: { integrationId: 'x', value: 'v' } } },
  { name: 'broker integration metadata', status: 200, request: { method: 'GET', path: '/v1/broker/integrations/github/metadata?accountId=acct', headers: SERVICE } },
  { name: 'broker integration metadata with repeated accountId', status: 200, request: { method: 'GET', path: '/v1/broker/integrations/github/metadata?accountId=a&accountId=b', headers: SERVICE } },
  { name: 'broker active account', status: 200, request: { method: 'PUT', path: '/v1/broker/integrations/github/active-account', headers: SERVICE, body: { accountId: 'acct' } } },
  { name: 'broker active account without accountId', status: 400, request: { method: 'PUT', path: '/v1/broker/integrations/github/active-account', headers: SERVICE, body: {} } },
  { name: 'broker oauth account', status: 200, request: { method: 'PUT', path: '/v1/broker/integrations/github/oauth-account', headers: SERVICE, body: { a: 1 } } },
  { name: 'broker desktop account', status: 200, request: { method: 'PUT', path: '/v1/broker/integrations/github/desktop-account', headers: SERVICE, body: { a: 1 } } },
  // Sulla Cloud
  { name: 'cloud session adopt', status: 200, request: { method: 'PUT', path: '/v1/broker/sulla-cloud/session', headers: SERVICE, body: { token: 't' } } },
  { name: 'cloud session clear', status: 200, request: { method: 'DELETE', path: '/v1/broker/sulla-cloud/session', headers: SERVICE } },
  { name: 'cloud session clear refused', status: 401, request: { method: 'DELETE', path: '/v1/broker/sulla-cloud/session', headers: SERVICE }, setup: a => { a.on('clearSullaCloudSession', vaultError('invalid_service_identity', 401, 'nope')) } },
  { name: 'cloud account wrap', status: 200, request: { method: 'POST', path: '/v1/broker/sulla-cloud/account-wrap', headers: SERVICE, body: { a: 1 } } },
  { name: 'cloud device approval wrap', status: 200, request: { method: 'POST', path: '/v1/broker/sulla-cloud/device-approval-wrap', headers: SERVICE, body: { a: 1 } } },
  { name: 'cloud enrollment wrap', status: 200, request: { method: 'POST', path: '/v1/broker/sulla-cloud/enrollment-wrap', headers: SERVICE, body: { a: 1 } } },
  { name: 'cloud enrollment adopt', status: 200, request: { method: 'POST', path: '/v1/broker/sulla-cloud/enrollment-adopt', headers: SERVICE, body: { a: 1 } } },
  { name: 'cloud enrollment commit', status: 200, request: { method: 'POST', path: '/v1/broker/sulla-cloud/enrollment-commit', headers: APPROVAL, body: { requestId: 'r' } } },
  { name: 'cloud enrollment commit without requestId', status: 400, request: { method: 'POST', path: '/v1/broker/sulla-cloud/enrollment-commit', headers: APPROVAL, body: {} } },
  { name: 'cloud enrollment commit with no body', status: 400, request: { method: 'POST', path: '/v1/broker/sulla-cloud/enrollment-commit', headers: APPROVAL } },
  { name: 'cloud enrollment commit from a non-approval caller', status: 401, request: { method: 'POST', path: '/v1/broker/sulla-cloud/enrollment-commit', headers: SERVICE, body: { requestId: 'r' } }, setup: denyApproval },
  { name: 'cloud recovery key rotate', status: 200, request: { method: 'POST', path: '/v1/broker/sulla-cloud/recovery-key/rotate', headers: SERVICE } },
  { name: 'cloud request', status: 200, request: { method: 'POST', path: '/v1/broker/sulla-cloud/request', headers: SERVICE, body: { path: '/x' } } },
  // routes registered by other modules with app.ts callbacks
  { name: 'memory key wrap from a non-approval caller', status: 401, request: { method: 'POST', path: '/v1/memory-sync/wrap-key', headers: SERVICE, body: { memoryKey: 'k' } }, setup: denyApproval },
  { name: 'files cloud escrow from a non-approval caller', status: 401, request: { method: 'POST', path: '/v1/files/cloud-escrow/key', headers: SERVICE, body: {} }, setup: denyApproval },
  { name: 'cloud sync status from a non-approval caller', status: 401, request: { method: 'POST', path: '/v1/desktop/cloud-sync/status', headers: SERVICE, body: {} }, setup: denyApproval },
  { name: 'files key bundle without identity', status: 401, request: { method: 'GET', path: '/v1/desktop/files/key-bundles' } },
  { name: 'files backup credentials through the s3 callback', status: 200, request: { method: 'POST', path: '/v1/desktop/files/backup-credentials', headers: FILES, body: { itemId: ITEM_ID, target: 's3://bucket/prefix' } }, setup: a => { a.on('backupCredentials', async(...args) => ({ target: String(args[2]) })) } },
  // execution and relays
  { name: 'broker execute', status: 200, request: { method: 'POST', path: '/v1/broker/execute', headers: SERVICE, body: { op: 'x' } } },
  { name: 'broker execute stream', status: 206, request: { method: 'POST', path: '/v1/broker/execute-stream', headers: SERVICE, body: { op: 'x' } }, setup: a => { a.on('executeStream', async(_body, _id, _token, sink) => { sink.onAbort(() => undefined); sink.start(206, { 'content-type': 'text/plain', 'x-upstream': 'yes' }); sink.write('part-1;'); sink.write('part-2'); sink.end() }) } },
  { name: 'broker execute stream refused', status: 403, request: { method: 'POST', path: '/v1/broker/execute-stream', headers: SERVICE, body: { op: 'x' } }, setup: a => { a.on('executeStream', vaultError('policy_denied', 403, 'Denied', 'policy')) } },
  { name: 'broker relay session', status: 201, request: { method: 'POST', path: '/v1/broker/relay/session', headers: SERVICE, body: { r: 1 } } },
  { name: 'broker relay events', status: 200, request: { method: 'GET', path: '/v1/broker/relay/relay-1/events', headers: SERVICE }, setup: a => { a.on('relayEvents', async function *() { yield { type: 'open' }; yield { type: 'data', data: 'x' } }) } },
  { name: 'broker relay send', status: 204, request: { method: 'POST', path: '/v1/broker/relay/relay-1/send', headers: SERVICE, body: { data: 'x' } } },
  { name: 'broker relay close', status: 204, request: { method: 'DELETE', path: '/v1/broker/relay/relay-1', headers: SERVICE } },
  { name: 'broker relay close refused', status: 404, request: { method: 'DELETE', path: '/v1/broker/relay/relay-1', headers: SERVICE }, setup: a => { a.on('closeRelay', vaultError('relay_not_found', 404, 'Relay not found')) } },
  // error handler mapping on broker paths
  { name: 'upstream failure with reason', status: 502, request: { method: 'POST', path: '/v1/broker/execute', headers: SERVICE, body: {} }, setup: a => { a.on('execute', vaultError('upstream_failed', 502, 'Upstream failed', 'dns_ENOTFOUND')) } },
  { name: 'upstream timeout cancelled by the client', status: 499, request: { method: 'POST', path: '/v1/broker/execute', headers: SERVICE, body: {} }, setup: a => { a.on('execute', vaultError('upstream_timeout', 499, 'Cancelled')) } },
  { name: 'upstream timeout', status: 504, request: { method: 'POST', path: '/v1/broker/execute', headers: SERVICE, body: {} }, setup: a => { a.on('execute', vaultError('upstream_timeout', 504, 'Timed out')) } },
  { name: 'approval required', status: 428, request: { method: 'POST', path: '/v1/broker/execute', headers: SERVICE, body: {} }, setup: a => { a.on('execute', vaultError('approval_required', 428, 'op-123')) } },
  { name: 'unique violation', status: 409, request: { method: 'POST', path: '/v1/broker/items/create', headers: SERVICE, body: {} }, setup: a => { a.on('createAgentVaultItem', throwing(Object.assign(new Error('dup'), { code: '23505' }))) } },
  { name: 'transient database error', status: 503, request: { method: 'POST', path: '/v1/broker/items', headers: SERVICE, body: {} }, setup: a => { a.on('listBrokerItems', throwing(Object.assign(new Error('gone'), { code: '57P01' }))) } },
  { name: 'upstream network error', status: 502, request: { method: 'POST', path: '/v1/broker/execute', headers: SERVICE, body: {} }, setup: a => { a.on('execute', throwing(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'EAI_FAIL' }) }))) } },
  { name: 'unexpected error', status: 500, request: { method: 'POST', path: '/v1/broker/execute', headers: SERVICE, body: {} }, setup: a => { a.on('execute', throwing(new Error('secret detail'))) } },
  { name: 'vault error outside the broker path', status: 502, request: { method: 'POST', path: '/v1/desktop/migrate', headers: SERVICE }, setup: a => { a.on('migrateLegacy', vaultError('upstream_failed', 502, 'Upstream failed', 'dns')) } },
  // console and fallbacks
  { name: 'vault console redirect', status: 308, request: { method: 'GET', path: '/vault' } },
  { name: 'vault console index', status: 200, request: { method: 'GET', path: '/vault/' } },
  { name: 'vault console asset', status: 200, request: { method: 'GET', path: '/vault/local.css' } },
  { name: 'vault console missing asset', status: 404, request: { method: 'GET', path: '/vault/missing.js' } },
  { name: 'unknown v1 path', status: 404, request: { method: 'POST', path: '/v1/accounts', body: {} } },
  { name: 'unknown v1 human path', status: 404, request: { method: 'GET', path: '/v1/human/unknown', headers: { origin: HUMAN_ORIGIN } } },
  { name: 'unknown non-v1 path', status: 404, request: { method: 'GET', path: '/console' } },
];

describe('E9 app.ts characterization: route table', () => {
  it('registers the same layers, paths, methods and middleware order as the legacy app', () => { // risk: auth/origin middleware reordered behind handlers
    const config = new VaultAppConfigFactory();
    const table = new VaultRouteTable();
    const legacy = table.describe(createLegacyApp(new DatabaseDouble().db, config.create(), { localAuthority: new AuthorityDouble().authority }));
    const current = table.describe((createApp as VaultAppFactory)(new DatabaseDouble().db, config.create(), { localAuthority: new AuthorityDouble().authority }));
    expect(legacy.length).toBeGreaterThan(60);
    expect(current).toEqual(legacy);
  });
});

describe('E9 app.ts characterization: HTTP behaviour', () => {
  const equivalence = new AppEquivalence();

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks() });

  it.each(cases.map(routeCase => [routeCase.name, routeCase] as const))('%s', async(_name, routeCase) => { // risk: auth, error codes and vault data responses drift
    await equivalence.compare(routeCase);
  });
});
