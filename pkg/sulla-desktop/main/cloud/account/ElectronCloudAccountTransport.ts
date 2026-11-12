// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  AccountKdf, CloudAccountTransport, CloudEmailCodeStartRequestDto, CloudEmailCodeStartResponseDto, CloudEmailCodeVerifyRequestDto,
  CloudEmailLoginRequestDto, CloudPreloginRequestDto, CloudPreloginResponseDto, CloudRefreshRequestDto,
  CloudRegisterRequestDto, CloudSessionResponseDto, CloudTokenPairDto, CloudUpgradeRequestDto,
} from '@sulla/domain';

import { type CloudRefreshHttp, ElectronCloudRefreshTransport, FetchCloudRefreshHttp } from '../session/ElectronCloudRefreshTransport';

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
 * The body every Desktop sign-in returns (register, email/login, upgrade, email-code/verify, otp/verify, apple).
 * Passed through as the server sent it; `userId`/`contractors` are reserved for multi-contractor accounts.
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
    /** The server's `error` field, when the body had one. */
    readonly serverError?: string,
    /** Retry-After seconds on a 429. */
    readonly retryAfter?: number,
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

/** /auth/logout could not be reached (DNS, TLS, timeout). No status, so it is classified as transient. */
export class CloudAccountNetworkError extends Error {
  constructor(path: string) {
    super(`Sulla Cloud ${ path } is unreachable`);
    this.name = 'CloudAccountNetworkError';
  }
}

/** The /auth/logout port shape the domain sign-out uses (same as the D-ID-4 CloudLogoutHttp): status only, rejects only on a network failure. */
export interface CloudAccountLogoutHttp {
  post(refreshToken: string): Promise<{ status: number }>;
}

export interface PhoneOtpVerifyRequest { phone: string; code: string }
export interface AppleSignInRequest { identityToken: string; fullName?: string; email?: string }
export interface PasswordResetCompleteRequest { email: string; code: string; authHash: string; kdf: AccountKdf }

/**
 * Every Sulla Cloud /auth/ call Desktop makes, in one place. Implements the shared domain `CloudAccountTransport`;
 * the Desktop-only endpoints the domain contract does not have yet are the "Desktop extension" methods below.
 *
 * Wire format is unchanged from the old procedural sullaCloudAuth.ts: same paths, same JSON bodies with the same key
 * order, the same `Content-Type: application/json` header, the same 20 s timeout, and the same single retry on
 * prelogin and refresh. A non-2xx answer throws `CloudAccountHttpError` (status + the server's `error` + Retry-After);
 * a request that never got an answer throws whatever fetch threw.
 */
export class ElectronCloudAccountTransport implements CloudAccountTransport {
  /** POST /auth/refresh with one network retry: the legacy session refresh and the startup adoption. */
  readonly refreshHttp: CloudRefreshHttp;
  /** POST /auth/refresh with no retry: the first-run pending session (pendingCredentials.ts). */
  readonly singleAttemptRefreshHttp: CloudRefreshHttp;
  /** POST /auth/logout, sent once: the D-ID-4 server-mode sign-out. */
  readonly logoutHttp: CloudAccountLogoutHttp;
  private readonly refresher: ElectronCloudRefreshTransport;

  constructor(private readonly http: SullaCloudHttpClient = new SullaCloudHttpClient()) {
    this.refreshHttp = new FetchCloudRefreshHttp(refreshToken => this.post('/auth/refresh', { refreshToken }, true));
    this.singleAttemptRefreshHttp = new FetchCloudRefreshHttp(refreshToken => this.post('/auth/refresh', { refreshToken }));
    this.logoutHttp = {
      post: async(refreshToken: string) => {
        const response = await this.post('/auth/logout', { refreshToken });
        // A successful logout may have no body; read and discard it so the connection is released.
        await response.text().catch(() => '');
        return { status: response.status };
      },
    };
    this.refresher = new ElectronCloudRefreshTransport(this.refreshHttp);
  }

  // ── Domain CloudAccountTransport ────────────────────────────

  /** POST /auth/prelogin {email}. Throws on an auth version other than 1 or 2. The KDF is returned unparsed; the credential service vets it. */
  async prelogin(request: CloudPreloginRequestDto): Promise<CloudPreloginResponseDto> {
    const data = await this.json<{ kdf?: unknown; authVersion?: unknown }>(await this.post('/auth/prelogin', { email: request.email }, true));
    if (data.authVersion !== 1 && data.authVersion !== 2) throw new Error('Sulla Cloud returned an unsupported authentication version.');
    return { kdf: data.kdf as CloudPreloginResponseDto['kdf'], authVersion: data.authVersion };
  }

  /** POST /auth/email/register. v2 body: {email, authHash, kdf, name, timezone}. */
  async register(request: CloudRegisterRequestDto): Promise<CloudSessionResponseDto> {
    const body = 'authHash' in request
      ? { email: request.email, authHash: request.authHash, kdf: request.kdf, name: request.name, timezone: request.timezone, phone: request.phone }
      : { email: request.email, password: request.password, name: request.name, timezone: request.timezone, phone: request.phone };
    return this.session(await this.post('/auth/email/register', body));
  }

  /** POST /auth/email/login {email, authHash} (a v2 account). */
  async emailLogin(request: CloudEmailLoginRequestDto): Promise<CloudSessionResponseDto> {
    const body = 'authHash' in request ? { email: request.email, authHash: request.authHash } : { email: request.email, password: request.password };
    return this.session(await this.post('/auth/email/login', body));
  }

  /** POST /auth/upgrade {email, password, authHash, kdf}: a legacy (v1) account signs in and becomes v2. */
  async upgrade(request: CloudUpgradeRequestDto): Promise<CloudSessionResponseDto> {
    return this.session(await this.post('/auth/upgrade', { email: request.email, password: request.password, authHash: request.authHash, kdf: request.kdf }));
  }

  /** POST /auth/email-code/start {email}. The body of a 2xx is not read. */
  async startEmailCode(request: CloudEmailCodeStartRequestDto): Promise<CloudEmailCodeStartResponseDto> {
    await this.ok(await this.post('/auth/email-code/start', { email: request.email }));
    return { ok: true };
  }

  /** POST /auth/email-code/verify {email, code, name, timezone}. */
  async verifyEmailCode(request: CloudEmailCodeVerifyRequestDto): Promise<CloudSessionResponseDto> {
    return this.session(await this.post('/auth/email-code/verify', { email: request.email, code: request.code, name: request.name, timezone: request.timezone }));
  }

  /** POST /auth/refresh {refreshToken}, retried once on a network failure. A reply without a new refresh token keeps the current one. */
  refresh(request: CloudRefreshRequestDto): Promise<CloudTokenPairDto> {
    return this.refresher.refresh(request);
  }

  /** POST /auth/logout {refreshToken}. Resolves on any 2xx; rejects with the status, or with no status on a network failure. */
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

  // ── Desktop extensions (not in the domain contract yet; ask for M1) ──

  /** Desktop extension: POST /auth/otp/send {phone}. */
  async sendPhoneOtp(request: { phone: string }): Promise<void> {
    await this.ok(await this.post('/auth/otp/send', { phone: request.phone }));
  }

  /** Desktop extension: POST /auth/otp/verify {phone, code}. */
  async verifyPhoneOtp(request: PhoneOtpVerifyRequest): Promise<CloudSignInResponse> {
    return this.signIn(await this.post('/auth/otp/verify', { phone: request.phone, code: request.code }));
  }

  /** Desktop extension: POST /auth/apple {identityToken, fullName, email} (native Sign in with Apple). */
  async appleSignIn(request: AppleSignInRequest): Promise<CloudSignInResponse> {
    return this.signIn(await this.post('/auth/apple', { identityToken: request.identityToken, fullName: request.fullName, email: request.email }));
  }

  /** Desktop extension: OPTIONS /auth/email/reset-password/start. True when this Cloud has password reset; throws when unreachable. */
  async passwordResetAvailable(): Promise<boolean> {
    return (await this.http.send('/auth/email/reset-password/start', { method: 'OPTIONS' })).ok;
  }

  /** Desktop extension: POST /auth/email/reset-password/start {email}. */
  async startPasswordReset(request: { email: string }): Promise<void> {
    await this.ok(await this.post('/auth/email/reset-password/start', { email: request.email }));
  }

  /** Desktop extension: POST /auth/email/reset-password/complete {email, code, authHash, kdf}. Returns the vault state Cloud reports. */
  async completePasswordReset(request: PasswordResetCompleteRequest): Promise<{ vaultState?: string }> {
    const response = await this.post('/auth/email/reset-password/complete', { email: request.email, code: request.code, authHash: request.authHash, kdf: request.kdf });
    const body = await response.json().catch(() => ({})) as { error?: string; vaultState?: string };
    if (!response.ok) throw new CloudAccountHttpError(response.status, body.error, ElectronCloudAccountTransport.retryAfter(response));
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

  private async session(response: Response): Promise<CloudSessionResponseDto> {
    return await this.json(response) as CloudSessionResponseDto;
  }

  private async signIn(response: Response): Promise<CloudSignInResponse> {
    return this.json<CloudSignInResponse>(response);
  }

  private async json<T>(response: Response): Promise<T> {
    await this.ok(response);
    return await response.json() as T;
  }

  private async ok(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new CloudAccountHttpError(response.status, body.error, ElectronCloudAccountTransport.retryAfter(response));
  }

  /** Cloud throttles repeated sign-in attempts with 429 + Retry-After (seconds). */
  private static retryAfter(response: Response): number | undefined {
    const value = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
    return Number.isFinite(value) ? value : undefined;
  }
}
