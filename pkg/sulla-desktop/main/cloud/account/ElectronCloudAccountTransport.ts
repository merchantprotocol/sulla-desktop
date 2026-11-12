// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  AccountKdf, CloudAccountTransport, CloudAppleSignInRequestDto, CloudChangePasswordRequestDto, CloudChangePasswordResponseDto,
  CloudEmailCodeStartRequestDto, CloudEmailCodeStartResponseDto, CloudEmailCodeVerifyRequestDto, CloudEmailLoginRequestDto,
  CloudHandoffRedeemRequestDto, CloudHandoffRedeemResponseDto, CloudPhoneOtpSendRequestDto, CloudPhoneOtpSendResponseDto,
  CloudPhoneOtpVerifyRequestDto, CloudPreloginRequestDto, CloudPreloginResponseDto, CloudRecoveryAvailabilityRequestDto,
  CloudRecoveryAvailabilityResponseDto, CloudRefreshRequestDto, CloudRegisterRequestDto, CloudSessionResponseDto,
  CloudSetPasswordRequestDto, CloudSetPasswordResponseDto, CloudTokenPairDto, CloudUpgradeRequestDto,
} from '@sulla/domain';

import { type CloudLogoutHttp, type CloudRefreshHttp, FetchCloudLogoutHttp, FetchCloudRefreshHttp } from './CloudTokenHttp';
import { SullaCloudHttpClient } from './SullaCloudHttpClient';

/** One business on the signed-in account, as Sulla Cloud returns it. */
export interface CloudContractor {
  id:           string;
  phone:        string;
  businessName: string | null;
  name:         string | null;
  email:        string | null;
}

/**
 * The body every Desktop sign-in returns (register, email/login, upgrade, email-code/verify, otp/verify, apple): the
 * domain `CloudSessionResponseDto` as Desktop reads it. `userId`/`contractors` are reserved for multi-contractor accounts.
 */
export interface CloudSignInResponse {
  contractor:    CloudContractor;
  accessToken:   string;
  refreshToken:  string;
  userId?:       string;
  contractors?:  CloudContractor[];
  isNewUser?:    boolean;
}

/** Sulla Cloud answered with a non-2xx status. Carries the status (read by the domain RefreshOutcomeClassifier) and never a token. */
export class CloudAccountHttpError extends Error {
  constructor(
    readonly status: number,
    /** The server's `error` field (the Workers `CloudErrorBodyDto`), when the body had one. */
    readonly serverError?: string,
    /** Retry-After seconds on a 429. */
    readonly retryAfter?: number,
    /** The server's machine `code` (e.g. reauth_required), when the body had one. */
    readonly code?: string,
  ) {
    super(`${ status }: ${ serverError || 'Sulla Cloud request failed' }`);
    this.name = 'CloudAccountHttpError';
  }

  /** What the sign-in screens have always shown for a failed call: the server's message, else `HTTP <status>`. */
  get userMessage(): string {
    return this.serverError || `HTTP ${ this.status }`;
  }

  /** A non-2xx becomes `{ok: false, error: userMessage}`; a network failure still throws, as the IPC handlers always did. */
  static async settle<T>(call: Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    try {
      return { ok: true, data: await call };
    } catch (error) {
      if (error instanceof CloudAccountHttpError) return { ok: false, error: error.userMessage };
      throw error;
    }
  }
}

/** A Sulla Cloud call got no HTTP answer (DNS, TLS, timeout). No status, so the domain classifies it as transient. */
export class CloudAccountNetworkError extends Error {
  constructor(path: string) {
    super(`Sulla Cloud ${ path } is unreachable`);
    this.name = 'CloudAccountNetworkError';
  }
}

export interface PasswordResetCompleteRequest { email: string; code: string; authHash: string; kdf: AccountKdf }

export interface ElectronCloudAccountTransportOptions {
  http?:        SullaCloudHttpClient;
  /** Defaults to POST /auth/refresh over `http` with one network retry. */
  refreshHttp?: CloudRefreshHttp;
  /** Defaults to POST /auth/logout over `http`, sent once. */
  logoutHttp?:  CloudLogoutHttp;
  /** Bearer token for the signed-in calls (setPassword, changePassword, recoveryAvailability). Empty = not signed in. */
  accessToken?: () => Promise<string>;
}

/**
 * Every Sulla Cloud /auth/ call Desktop makes, in one place: the one Desktop implementation of the shared domain
 * `CloudAccountTransport` (0.3.3, including its optional methods). Session holders (ClientSessionService, SignOutService,
 * the first-run pending session, startup adoption) and every sign-in screen use this class; nothing else in the main
 * process may build an /auth/ request (enforced by the CloudAuthCallSites test).
 *
 * Wire format is unchanged from the old procedural sullaCloudAuth.ts: same paths, same JSON bodies, the same
 * `Content-Type: application/json` header, the same 20 s timeout, and the same single network retry on prelogin and
 * refresh. A non-2xx throws `CloudAccountHttpError` (status + the server's `error` and `code` + Retry-After); refresh and
 * logout throw `CloudAccountNetworkError` (no status) when Cloud is unreachable; other calls rethrow what fetch threw.
 */
export class ElectronCloudAccountTransport implements CloudAccountTransport {
  private readonly http: SullaCloudHttpClient;
  private readonly refreshHttp: CloudRefreshHttp;
  private readonly logoutHttp: CloudLogoutHttp;
  private readonly accessToken: () => Promise<string>;

  constructor(options: ElectronCloudAccountTransportOptions = {}) {
    this.http = options.http ?? new SullaCloudHttpClient();
    this.refreshHttp = options.refreshHttp ?? new FetchCloudRefreshHttp(refreshToken => this.post('/auth/refresh', { refreshToken }, true));
    // Logout is POSTed once (no retry): the refresh token is revoked server-side whatever the response body holds.
    this.logoutHttp = options.logoutHttp ?? new FetchCloudLogoutHttp(refreshToken => this.post('/auth/logout', { refreshToken }));
    this.accessToken = options.accessToken ?? (async() => '');
  }

  /** The same transport, but /auth/refresh is tried once (the first-run pending session retries on its own schedule). */
  withSingleAttemptRefresh(): ElectronCloudAccountTransport {
    return new ElectronCloudAccountTransport({
      http:        this.http,
      refreshHttp: new FetchCloudRefreshHttp(refreshToken => this.post('/auth/refresh', { refreshToken })),
      logoutHttp:  this.logoutHttp,
      accessToken: this.accessToken,
    });
  }

  /** Desktop reads a session response with its contractor fields; the domain DTO keeps them as passthrough. */
  static signIn(response: CloudSessionResponseDto): CloudSignInResponse {
    return response as unknown as CloudSignInResponse;
  }

  // ── Domain CloudAccountTransport ────────────────────────────

  /** POST /auth/prelogin {email}. Throws on an auth version other than 1 or 2. The KDF is returned unparsed; the credential service vets it. */
  async prelogin(request: CloudPreloginRequestDto): Promise<CloudPreloginResponseDto> {
    const data = await this.json<{ kdf?: unknown; authVersion?: unknown }>(await this.post('/auth/prelogin', { email: request.email }, true));
    if (data.authVersion !== 1 && data.authVersion !== 2) throw new Error('Sulla Cloud returned an unsupported authentication version.');
    return { kdf: data.kdf as CloudPreloginResponseDto['kdf'], authVersion: data.authVersion };
  }

  /** POST /auth/email/register. v2 body: {email, authHash, kdf, name, timezone, phone}. */
  async register(request: CloudRegisterRequestDto): Promise<CloudSessionResponseDto> {
    const body = 'authHash' in request
      ? { email: request.email, authHash: request.authHash, kdf: request.kdf, name: request.name, timezone: request.timezone, phone: request.phone }
      : { email: request.email, password: request.password, name: request.name, timezone: request.timezone, phone: request.phone };
    return this.json(await this.post('/auth/email/register', body));
  }

  /** POST /auth/email/login {email, authHash} (a v2 account). */
  async emailLogin(request: CloudEmailLoginRequestDto): Promise<CloudSessionResponseDto> {
    const body = 'authHash' in request ? { email: request.email, authHash: request.authHash } : { email: request.email, password: request.password };
    return this.json(await this.post('/auth/email/login', body));
  }

  /** POST /auth/upgrade {email, password, authHash, kdf}: a legacy (v1) account signs in and becomes v2. */
  async upgrade(request: CloudUpgradeRequestDto): Promise<CloudSessionResponseDto> {
    return this.json(await this.post('/auth/upgrade', { email: request.email, password: request.password, authHash: request.authHash, kdf: request.kdf }));
  }

  /** POST /auth/email-code/start {email}. The body of a 2xx is not read. */
  async startEmailCode(request: CloudEmailCodeStartRequestDto): Promise<CloudEmailCodeStartResponseDto> {
    await this.ok(await this.post('/auth/email-code/start', { email: request.email }));
    return { ok: true };
  }

  /** POST /auth/email-code/verify {email, code, name, timezone}. */
  async verifyEmailCode(request: CloudEmailCodeVerifyRequestDto): Promise<CloudSessionResponseDto> {
    return this.json(await this.post('/auth/email-code/verify', { email: request.email, code: request.code, name: request.name, timezone: request.timezone }));
  }

  /** POST /auth/refresh {refreshToken}. A reply without a new refresh token keeps the current one; a 2xx without an access token is a 502. */
  async refresh(request: CloudRefreshRequestDto): Promise<CloudTokenPairDto> {
    let response: { status: number; body: unknown };
    try {
      response = await this.refreshHttp.post(request.refreshToken);
    } catch {
      // Whatever the client threw is not the server's verdict, and may carry a status of its own.
      throw new CloudAccountNetworkError('/auth/refresh');
    }
    if (response.status < 200 || response.status >= 300) throw new CloudAccountHttpError(response.status);
    const body = (response.body ?? {}) as { accessToken?: unknown; refreshToken?: unknown };
    // A 2xx with an unreadable body is the server's fault, not a revocation.
    if (typeof body.accessToken !== 'string' || !body.accessToken) throw new CloudAccountHttpError(502);
    const next = typeof body.refreshToken === 'string' && body.refreshToken ? body.refreshToken : request.refreshToken;
    return { accessToken: body.accessToken, refreshToken: next };
  }

  /** POST /auth/logout {refreshToken}. Resolves on any 2xx (body or not); rejects with the status, or with no status when offline. */
  async logout(request: CloudRefreshRequestDto): Promise<void> {
    // A blank token is a silent no-op on the server, so it would report a revoke that never happened.
    if (!request.refreshToken) throw new Error('Refusing to log out without a refresh token');
    let response: { status: number };
    try {
      response = await this.logoutHttp.post(request.refreshToken);
    } catch {
      throw new CloudAccountNetworkError('/auth/logout');
    }
    if (response.status < 200 || response.status >= 300) throw new CloudAccountHttpError(response.status);
  }

  /** POST /auth/otp/send {phone}. */
  async phoneOtpSend(request: CloudPhoneOtpSendRequestDto): Promise<CloudPhoneOtpSendResponseDto> {
    await this.ok(await this.post('/auth/otp/send', { phone: request.phone }));
    return { success: true };
  }

  /** POST /auth/otp/verify {phone, code} (+ timezone / apple_identity_token when given). */
  async phoneOtpVerify(request: CloudPhoneOtpVerifyRequestDto): Promise<CloudSessionResponseDto> {
    return this.json(await this.post('/auth/otp/verify', {
      phone: request.phone, code: request.code, timezone: request.timezone, apple_identity_token: request.apple_identity_token,
    }));
  }

  /** POST /auth/apple {identityToken, fullName, email} from native Sign in with Apple (or authorizationCode + redirectUri). */
  async apple(request: CloudAppleSignInRequestDto): Promise<CloudSessionResponseDto> {
    return this.json(await this.post('/auth/apple', {
      identityToken: request.identityToken, authorizationCode: request.authorizationCode, redirectUri: request.redirectUri,
      fullName: request.fullName, email: request.email,
    }));
  }

  /** POST /auth/handoff/redeem {code}: the browser vault origin's 60-second single-use code becomes a token pair. */
  async handoffRedeem(request: CloudHandoffRedeemRequestDto): Promise<CloudHandoffRedeemResponseDto> {
    const body = await this.json<{ accessToken?: unknown; refreshToken?: unknown }>(await this.post('/auth/handoff/redeem', { code: request.code }));
    if (typeof body.accessToken !== 'string' || !body.accessToken || typeof body.refreshToken !== 'string' || !body.refreshToken) {
      throw new CloudAccountHttpError(502);
    }
    return { accessToken: body.accessToken, refreshToken: body.refreshToken };
  }

  /** PUT /auth/email/set-password {authHash, kdf, currentAuthHash?} as the signed-in user. */
  async setPassword(request: CloudSetPasswordRequestDto): Promise<CloudSetPasswordResponseDto> {
    await this.ok(await this.signedIn('/auth/email/set-password', 'PUT', {
      authHash: request.authHash, kdf: request.kdf, currentAuthHash: request.currentAuthHash,
    }));
    return { success: true };
  }

  /** POST /auth/password/change {currentAuthHash, newAuthHash, newKdf, bundles} as the signed-in user. */
  async changePassword(request: CloudChangePasswordRequestDto): Promise<CloudChangePasswordResponseDto> {
    return this.json(await this.signedIn('/auth/password/change', 'POST', request));
  }

  /** GET /auth/password/recovery/availability?vaultId= as the signed-in user. */
  async recoveryAvailability(request: CloudRecoveryAvailabilityRequestDto): Promise<CloudRecoveryAvailabilityResponseDto> {
    return this.json(await this.signedIn(`/auth/password/recovery/availability?vaultId=${ encodeURIComponent(request.vaultId) }`, 'GET'));
  }

  // ── Desktop extensions (no domain contract yet) ─────────────

  /** OPTIONS /auth/email/reset-password/start with a 5 s timeout. True when this Cloud has password reset; throws when unreachable. */
  async passwordResetAvailable(): Promise<boolean> {
    return (await this.http.send('/auth/email/reset-password/start', { method: 'OPTIONS' }, false, 5_000)).ok;
  }

  /** POST /auth/email/reset-password/start {email}. */
  async startPasswordReset(request: { email: string }): Promise<void> {
    await this.ok(await this.post('/auth/email/reset-password/start', { email: request.email }));
  }

  /** POST /auth/email/reset-password/complete {email, code, authHash, kdf}. Returns the vault state Cloud reports. */
  async completePasswordReset(request: PasswordResetCompleteRequest): Promise<{ vaultState?: string }> {
    const body = await this.json<{ vaultState?: string }>(await this.post('/auth/email/reset-password/complete', {
      email: request.email, code: request.code, authHash: request.authHash, kdf: request.kdf,
    }));
    return { vaultState: body.vaultState };
  }

  // ── Wire ────────────────────────────────────────────────────

  private post(path: string, body: unknown, retry = false): Promise<Response> {
    return this.http.send(path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }, retry);
  }

  private async signedIn(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<Response> {
    const token = await this.accessToken();
    if (!token) throw new CloudAccountHttpError(401, 'Sign in to Sulla Cloud first.');
    const headers: Record<string, string> = { Authorization: `Bearer ${ token }` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return this.http.send(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  private async json<T>(response: Response): Promise<T> {
    await this.ok(response);
    return await response.json() as T;
  }

  private async ok(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    throw new CloudAccountHttpError(
      response.status,
      typeof body.error === 'string' ? body.error : undefined,
      ElectronCloudAccountTransport.retryAfter(response),
      typeof body.code === 'string' ? body.code : undefined,
    );
  }

  /** Cloud throttles repeated sign-in attempts with 429 + Retry-After (seconds). */
  private static retryAfter(response: Response): number | undefined {
    const value = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
    return Number.isFinite(value) ? value : undefined;
  }
}
