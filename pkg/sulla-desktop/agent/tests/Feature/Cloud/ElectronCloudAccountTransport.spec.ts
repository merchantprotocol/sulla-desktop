// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {
  AccountKdfPolicy, CloudErrorBodyDtoSchema, CloudSessionResponseDtoSchema, IDENTITY_HTTP_STATUS, IdentityError,
  InProcessRefreshLock, type AccountKdf,
} from '@sulla/domain';
import { describe, expect, it } from 'vitest';

import { CloudPasswordSignIn } from '@pkg/main/cloud/account/CloudPasswordSignIn';
import { CloudAccountHttpError, CloudAccountNetworkError, ElectronCloudAccountTransport } from '@pkg/main/cloud/account/ElectronCloudAccountTransport';
import { SullaCloudHttpClient } from '@pkg/main/cloud/account/SullaCloudHttpClient';
import { CloudAccountCredentialService } from '@pkg/main/cloud/CloudAccountCredentialService';
import { LegacyCloudSessionRefresher } from '@pkg/main/cloud/session/DesktopCloudSessionRefreshers';
import { LegacyCloudSessionAdopter } from '@pkg/main/cloud/session/LegacyCloudSessionAdopter';
import type { CloudSessionStorage, StoredCloudSession } from '@pkg/main/cloud/session/DesktopTokenStores';

interface SeenRequest { method: string; path: string; body: Record<string, unknown> | null; authorization: string | null }
type Reply = Response | 'network';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
/** The Workers error body (`CloudErrorBodyDto`), checked against the shared schema so the fake cannot drift from Cloud. */
const cloudError = (status: number, error: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) => json(status, CloudErrorBodyDtoSchema.parse({ error, ...extra }), headers);

/**
 * A synthetic Sulla Cloud behind the real SullaCloudHttpClient: v2 email accounts (register, prelogin, email/login),
 * token refresh and logout, and scripted replies for anything else. Only the account's authHash is kept, as Cloud does.
 */
class FakeSullaCloud {
  readonly requests: SeenRequest[] = [];
  readonly scripted = new Map<string, Reply[]>();
  private readonly accounts = new Map<string, { kdf: AccountKdf; authHash: string; id: string }>();
  private readonly disabled = new Set<string>();
  private issued = 0;

  readonly http = new SullaCloudHttpClient(async(url, init) => this.handle(url, init), 'https://cloud.test', 20_000, 0);

  transport(accessToken?: () => Promise<string>): ElectronCloudAccountTransport {
    return new ElectronCloudAccountTransport({ http: this.http, accessToken });
  }

  script(route: string, ...replies: Reply[]): void {
    this.scripted.set(route, replies);
  }

  /** An admin disabled the account: the password still verifies, but Cloud's issueTokens refuses to mint a session. */
  disable(email: string): void {
    this.disabled.add(email);
  }

  paths(): string[] {
    return this.requests.map(r => `${ r.method } ${ r.path }`);
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const path = url.replace('https://cloud.test', '');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    const authorization = (init.headers as Record<string, string> | undefined)?.Authorization ?? null;
    this.requests.push({ method, path, body, authorization });
    const queue = this.scripted.get(`${ method } ${ path.split('?')[0] }`);
    if (queue?.length) {
      const reply = queue.shift()!;
      if (reply === 'network') throw new TypeError('fetch failed');
      return reply;
    }
    return this.route(method, path, body ?? {});
  }

  private route(method: string, path: string, body: Record<string, unknown>): Response {
    const email = String(body.email ?? '');
    const account = this.accounts.get(email);
    if (method === 'POST' && path === '/auth/prelogin') {
      // Unknown emails get a decoy KDF so prelogin never reveals whether an account exists.
      return json(200, { kdf: account?.kdf ?? new AccountKdfPolicy().issue(new Uint8Array(16).fill(9)), authVersion: 2 });
    }
    if (method === 'POST' && path === '/auth/email/register') {
      if (account) return cloudError(409, 'An account with this email already exists.');
      const id = `contractor-${ this.accounts.size + 1 }`;
      this.accounts.set(email, { kdf: body.kdf as AccountKdf, authHash: String(body.authHash), id });
      return this.session(id, email, true);
    }
    if (method === 'POST' && path === '/auth/email/login') {
      // Workers AuthFailureClassifier: one generic message, the code says whether the email had an account.
      if (!account || account.authHash !== body.authHash) {
        return cloudError(401, 'Invalid email or credential.', { code: account ? 'wrong_password' : 'unknown_account' });
      }
      if (this.disabled.has(email)) return cloudError(401, 'Account disabled', { code: 'account_disabled' });
      return this.session(account.id, email, false);
    }
    return cloudError(404, 'Not found');
  }

  private session(id: string, email: string, isNewUser: boolean): Response {
    this.issued += 1;
    return json(201, CloudSessionResponseDtoSchema.parse({
      accessToken: `at-${ this.issued }`, refreshToken: `rt-${ this.issued }`, isNewUser,
      contractor: { id, email, phone: '', businessName: null, name: null },
    }));
  }
}

const credentials = () => CloudAccountCredentialService.forDesktop();
const signInOver = (cloud: FakeSullaCloud) => new CloudPasswordSignIn(cloud.transport(), credentials, () => {}, () => 'America/Los_Angeles');

describe('Desktop email + password sign-in through ElectronCloudAccountTransport', () => {
  it('risk: sign-in (BL-003). a wrong password shows exactly "That password is not correct." and keeps no key', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    const created = await signIn.register('owner@example.test', 'right horse battery');
    created.masterKey!.fill(0);
    cloud.requests.length = 0;

    const result = await signIn.login('owner@example.test', 'wrong horse battery');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('That password is not correct.');
    expect(result.httpStatus).toBe(401);
    expect(result.masterKey).toBeUndefined();
    expect(result.data).toBeUndefined();
    expect(cloud.paths()).toEqual(['POST /auth/prelogin', 'POST /auth/email/login']);
  });

  it('risk: sign-in. the right password signs in with the session Cloud returned, and only the authHash is sent', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    (await signIn.register('owner@example.test', 'right horse battery')).masterKey!.fill(0);

    const result = await signIn.login('owner@example.test', 'right horse battery');

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2', contractor: { id: 'contractor-1' } });
    expect(result.masterKey).toBeInstanceOf(Uint8Array);
    expect(result.masterKey!.some(byte => byte !== 0)).toBe(true);
    const login = cloud.requests.find(r => r.path === '/auth/email/login')!;
    expect(Object.keys(login.body!).sort()).toEqual(['authHash', 'email']);
    expect(JSON.stringify(cloud.requests)).not.toContain('right horse battery');
    result.masterKey!.fill(0);
  });

  it('risk: lost sign-in. first-run register that gets 409 signs in to the existing account with the same credentials', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    (await signIn.register('owner@example.test', 'right horse battery')).masterKey!.fill(0);
    cloud.requests.length = 0;

    const result = await signIn.continueFirstRun('owner@example.test', 'right horse battery', 'Owner');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isNewUser).toBe(false);
    expect(result.data.contractor.id).toBe('contractor-1');
    expect(cloud.paths()).toEqual(['POST /auth/email/register', 'POST /auth/prelogin', 'POST /auth/email/login']);
    result.masterKey.fill(0);
  });

  it('risk: sign-in (BL-003). first-run 409 then a wrong password says the password is wrong, not an account error', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    (await signIn.register('owner@example.test', 'right horse battery')).masterKey!.fill(0);

    const result = await signIn.continueFirstRun('owner@example.test', 'wrong horse battery');

    expect(result).toEqual({ ok: false, accountExists: true, error: 'That password is not correct.' });
  });

  it('risk: duplicate account. a brand-new first-run email registers once and never tries to log in', async() => {
    const cloud = new FakeSullaCloud();
    const result = await signInOver(cloud).continueFirstRun('new@example.test', 'fresh horse battery', 'New');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isNewUser).toBe(true);
    expect(cloud.paths()).toEqual(['POST /auth/email/register']);
    expect(cloud.requests[0].body).toMatchObject({ email: 'new@example.test', name: 'New', timezone: 'America/Los_Angeles' });
    result.masterKey.fill(0);
  });

  it('risk: lockout. a throttled sign-in reports the Retry-After wait instead of a wrong password', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    (await signIn.register('owner@example.test', 'right horse battery')).masterKey!.fill(0);
    cloud.script('POST /auth/email/login', cloudError(429, 'Too many attempts', {}, { 'Retry-After': '42' }));

    const result = await signIn.continueFirstRun('owner@example.test', 'right horse battery');

    expect(result).toEqual({ ok: false, accountExists: true, retryAfter: 42, error: 'Too many tries. Wait 42 seconds and try again.' });
  });

  it('risk: sign-in (BL-003). an unknown email gets the same wrong-password message, so it reveals nothing', async() => {
    const result = await signInOver(new FakeSullaCloud()).login('nobody@example.test', 'any horse battery');

    expect(result).toMatchObject({ ok: false, httpStatus: 401, code: 'unknown_account', error: 'That password is not correct.' });
  });

  it('risk: sign-in (BL-003). a legacy v1 account whose old password Cloud refuses says the password is wrong', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/prelogin', json(200, { kdf: new AccountKdfPolicy().issue(new Uint8Array(16).fill(7)), authVersion: 1 }));
    cloud.script('POST /auth/upgrade', cloudError(401, 'Invalid legacy credential.'));

    const result = await signInOver(cloud).login('legacy@example.test', 'old horse battery');

    expect(result).toMatchObject({ ok: false, httpStatus: 401, error: 'That password is not correct.' });
    expect(cloud.paths()).toEqual(['POST /auth/prelogin', 'POST /auth/upgrade']);
  });

  it('risk: sign-in. a disabled legacy v1 account upgrading is told it is disabled, not that its password is wrong', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/prelogin', json(200, { kdf: new AccountKdfPolicy().issue(new Uint8Array(16).fill(7)), authVersion: 1 }));
    cloud.script('POST /auth/upgrade', cloudError(401, 'Account disabled', { code: 'account_disabled' }));

    const result = await signInOver(cloud).login('legacy@example.test', 'cafe\u0301 horse battery');

    expect(result).toMatchObject({ ok: false, httpStatus: 401, code: 'account_disabled', error: 'This Sulla Cloud account is disabled.' });
    expect(cloud.paths()).toEqual(['POST /auth/prelogin', 'POST /auth/upgrade']);
  });

  it('risk: sign-in. a disabled account is told it is disabled, not that its password is wrong, and is not retried', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    // Decomposed "é": NFC differs from the typed bytes, so a credential rejection would trigger the legacy retry.
    const typed = 'cafe\u0301 horse battery';
    (await signIn.register('owner@example.test', typed)).masterKey!.fill(0);
    cloud.disable('owner@example.test');
    cloud.requests.length = 0;

    const result = await signIn.login('owner@example.test', typed);

    expect(result).toMatchObject({ ok: false, httpStatus: 401, code: 'account_disabled', error: 'This Sulla Cloud account is disabled.' });
    expect(result.masterKey).toBeUndefined();
    expect(cloud.paths()).toEqual(['POST /auth/prelogin', 'POST /auth/email/login']);
  });

  it('risk: sign-in. a decomposed password from an older Desktop still signs in once through the legacy byte retry', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    // An account created before NFC: Cloud holds the authHash of the decomposed bytes.
    const typed = 'cafe\u0301 horse battery';
    const credential = await (await credentials()).derive(typed);
    credential.masterKey.fill(0);
    await cloud.transport().register({ email: 'old@example.test', authHash: credential.authHash, kdf: credential.kdf, timezone: 'UTC' });
    cloud.requests.length = 0;

    const result = await signIn.login('old@example.test', typed);

    expect(result.ok).toBe(true);
    expect(cloud.paths()).toEqual(['POST /auth/prelogin', 'POST /auth/email/login', 'POST /auth/prelogin', 'POST /auth/email/login']);
    result.masterKey!.fill(0);
  });

  it('risk: misleading error. a 401/403 with a non-credential code keeps Cloud\'s own message', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/email/login', cloudError(403, 'Recent authentication required.', { code: 'reauth_required' }));

    const result = await signInOver(cloud).login('owner@example.test', 'right horse battery');

    expect(result).toMatchObject({ ok: false, httpStatus: 403, error: 'Recent authentication required.' });
  });

  it('risk: sign-in. first-run 409 then a disabled account says the account is disabled, not the password', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    (await signIn.register('owner@example.test', 'right horse battery')).masterKey!.fill(0);
    cloud.disable('owner@example.test');

    const result = await signIn.continueFirstRun('owner@example.test', 'right horse battery');

    expect(result).toEqual({ ok: false, accountExists: true, error: 'This Sulla Cloud account is disabled.' });
  });

  it('risk: misleading error. a Cloud outage during first run is a Cloud problem, not a wrong password', async() => {
    const cloud = new FakeSullaCloud();
    const signIn = signInOver(cloud);
    (await signIn.register('owner@example.test', 'right horse battery')).masterKey!.fill(0);
    cloud.script('POST /auth/email/login', cloudError(503, 'Service unavailable'));

    const result = await signIn.continueFirstRun('owner@example.test', 'right horse battery');

    expect(result).toEqual({ ok: false, accountExists: true, error: 'Sulla Cloud had a problem, try again.' });
  });
});

describe('ElectronCloudAccountTransport token calls and wire format', () => {
  it('risk: token rotation. refresh retries once after a network failure, keeps the old refresh token when none is returned', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/refresh', 'network', json(200, { accessToken: 'at-new' }));

    const pair = await cloud.transport().refresh({ refreshToken: 'rt-old' });

    expect(pair).toEqual({ accessToken: 'at-new', refreshToken: 'rt-old' });
    expect(cloud.requests.map(r => r.body)).toEqual([{ refreshToken: 'rt-old' }, { refreshToken: 'rt-old' }]);
  });

  it('risk: lost session. a rejected refresh carries the status; a 2xx without an access token is a 502, not a revoke', async() => {
    const cloud = new FakeSullaCloud();
    const transport = cloud.transport();
    cloud.script('POST /auth/refresh', cloudError(401, 'Invalid refresh token'), json(200, {}));

    await expect(transport.refresh({ refreshToken: 'rt-1' })).rejects.toMatchObject({ status: 401 });
    await expect(transport.refresh({ refreshToken: 'rt-1' })).rejects.toMatchObject({ status: 502 });
  });

  it('risk: token rotation. the first-run transport tries refresh once and reports an unreachable Cloud without a status', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/refresh', 'network', json(200, { accessToken: 'at-new' }));

    const error = await cloud.transport().withSingleAttemptRefresh().refresh({ refreshToken: 'rt-1' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CloudAccountNetworkError);
    expect((error as { status?: number }).status).toBeUndefined();
    expect(cloud.requests).toHaveLength(1);
  });

  it('risk: session left alive. server-mode sign-out POSTs /auth/logout once over the real HTTP client after the local clear', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/logout', new Response(null, { status: 204 }));
    let stored: StoredCloudSession | null = { userId: 'u-1', activeContractorId: 'u-1', contractors: [], tokens: { accessToken: 'at-1', refreshToken: 'rt-1' } };
    const storage: CloudSessionStorage<StoredCloudSession> = {
      load: async() => stored, save: async(s) => { stored = s }, clear: async() => { stored = null },
    };
    const sessions = new LegacyCloudSessionRefresher(storage, cloud.transport(), { failed() {}, refreshed() {} }, new InProcessRefreshLock());

    const result = await sessions.signOut();

    expect(result.remoteRevoked).toBe(true);
    expect(stored).toBeNull();
    expect(cloud.requests).toEqual([{ method: 'POST', path: '/auth/logout', body: { refreshToken: 'rt-1' }, authorization: null }]);
  });

  it('risk: session left alive. an unreachable /auth/logout is not retried and rejects without a status', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/logout', 'network', new Response(null, { status: 204 }));

    const error = await cloud.transport().logout({ refreshToken: 'rt-1' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CloudAccountNetworkError);
    expect(cloud.requests).toHaveLength(1);
  });

  it('risk: wrong endpoint. each Desktop sign-in method sends its documented path and body', async() => {
    const cloud = new FakeSullaCloud();
    const transport = cloud.transport();
    const session = () => json(200, { accessToken: 'at', refreshToken: 'rt', isNewUser: false, contractor: { id: 'c-1' } });
    cloud.script('POST /auth/otp/send', json(200, { success: true }));
    cloud.script('POST /auth/otp/verify', session());
    cloud.script('POST /auth/apple', session());
    cloud.script('POST /auth/email-code/start', json(200, { ok: true }));
    cloud.script('POST /auth/email-code/verify', session());
    cloud.script('POST /auth/handoff/redeem', json(200, { accessToken: 'at-h', refreshToken: 'rt-h' }));
    cloud.script('POST /auth/email/reset-password/start', json(200, { ok: true }));
    cloud.script('POST /auth/email/reset-password/complete', json(200, { vaultState: 'needs_recovery' }));

    await transport.phoneOtpSend({ phone: '+15551234567' });
    await transport.phoneOtpVerify({ phone: '+15551234567', code: '123456' });
    await transport.apple({ identityToken: 'apple-jwt', fullName: 'Owner' });
    await transport.startEmailCode({ email: 'o@example.test' });
    await transport.verifyEmailCode({ email: 'o@example.test', code: '654321', name: 'Owner', timezone: 'UTC' });
    expect(await transport.handoffRedeem({ code: 'h'.repeat(43) })).toEqual({ accessToken: 'at-h', refreshToken: 'rt-h' });
    await transport.startPasswordReset({ email: 'o@example.test' });
    const kdf = new AccountKdfPolicy().issue(new Uint8Array(16).fill(3));
    expect(await transport.completePasswordReset({ email: 'o@example.test', code: '111111', authHash: 'hash', kdf })).toEqual({ vaultState: 'needs_recovery' });

    expect(cloud.requests.map(r => [r.method, r.path, r.body])).toEqual([
      ['POST', '/auth/otp/send', { phone: '+15551234567' }],
      ['POST', '/auth/otp/verify', { phone: '+15551234567', code: '123456' }],
      ['POST', '/auth/apple', { identityToken: 'apple-jwt', fullName: 'Owner' }],
      ['POST', '/auth/email-code/start', { email: 'o@example.test' }],
      ['POST', '/auth/email-code/verify', { email: 'o@example.test', code: '654321', name: 'Owner', timezone: 'UTC' }],
      ['POST', '/auth/handoff/redeem', { code: 'h'.repeat(43) }],
      ['POST', '/auth/email/reset-password/start', { email: 'o@example.test' }],
      ['POST', '/auth/email/reset-password/complete', { email: 'o@example.test', code: '111111', authHash: 'hash', kdf }],
    ]);
  });

  it('risk: permissions. signed-in calls send the bearer token, and refuse without a request when signed out', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('GET /auth/password/recovery/availability', json(200, { vaultId: 'v 1', approvingDevicesOnline: { count: 1, displayNames: ['Mac'] }, recoveryWrapPresent: true }));

    const signedIn = await cloud.transport(async() => 'at-live').recoveryAvailability({ vaultId: 'v 1' });
    const signedOut = await cloud.transport(async() => '').setPassword({ authHash: 'h', kdf: new AccountKdfPolicy().issue(new Uint8Array(16).fill(1)) }).catch((e: unknown) => e);

    expect(signedIn.recoveryWrapPresent).toBe(true);
    expect(cloud.requests).toEqual([{ method: 'GET', path: '/auth/password/recovery/availability?vaultId=v%201', body: null, authorization: 'Bearer at-live' }]);
    expect(signedOut).toBeInstanceOf(CloudAccountHttpError);
    expect((signedOut as CloudAccountHttpError).status).toBe(401);
  });

  it('risk: misleading error. a failed call carries the Workers error, machine code and status for the screen', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/otp/verify', cloudError(403, 'Sign in again to continue', { code: 'reauth_required' }));

    const error = await cloud.transport().phoneOtpVerify({ phone: '+15551234567', code: '000000' }).catch((e: unknown) => e) as CloudAccountHttpError;

    expect(error.status).toBe(IDENTITY_HTTP_STATUS.reauth_required);
    expect(error.code).toBe('reauth_required');
    expect(error.userMessage).toBe('Sign in again to continue');
  });
});

describe('Startup legacy session adoption on the domain ClientSessionService', () => {
  const row = { user_id: 'u-1', active_contractor_id: 'c-1', access_token: 'at-legacy', refresh_token: 'rt-legacy' };

  it('risk: lost session. a live legacy session is rotated once and the new pair is handed back for the vault', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/refresh', json(200, { accessToken: 'at-rotated', refreshToken: 'rt-rotated' }));

    const outcome = await new LegacyCloudSessionAdopter(cloud.transport(), new InProcessRefreshLock()).refresh(row);

    expect(outcome).toEqual({ kind: 'rotated', tokens: { accessToken: 'at-rotated', refreshToken: 'rt-rotated' } });
    expect(cloud.requests.map(r => [r.path, r.body])).toEqual([['/auth/refresh', { refreshToken: 'rt-legacy' }]]);
  });

  it('risk: lost session. Cloud rejecting the legacy token means sign in again; an outage throws so startup retries', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/refresh', cloudError(401, 'Invalid refresh token'), cloudError(503, 'Unavailable'));
    const adopter = new LegacyCloudSessionAdopter(cloud.transport(), new InProcessRefreshLock());

    expect(await adopter.refresh(row)).toEqual({ kind: 'rejected' });
    const outage = await adopter.refresh(row).catch((e: unknown) => e);
    expect(outage).toBeInstanceOf(IdentityError);
    expect((outage as IdentityError).identityCode).toBe('refresh_transient');
  });

  it('risk: token leak. a row without an access token still adopts, and only the refresh token is ever sent', async() => {
    const cloud = new FakeSullaCloud();
    cloud.script('POST /auth/refresh', json(200, { accessToken: 'at-rotated' }));

    const outcome = await new LegacyCloudSessionAdopter(cloud.transport(), new InProcessRefreshLock()).refresh({ user_id: 'u-1', refresh_token: 'rt-legacy' });

    expect(outcome).toEqual({ kind: 'rotated', tokens: { accessToken: 'at-rotated', refreshToken: 'rt-legacy' } });
    expect(cloud.requests).toEqual([{ method: 'POST', path: '/auth/refresh', body: { refreshToken: 'rt-legacy' }, authorization: null }]);
  });
});
