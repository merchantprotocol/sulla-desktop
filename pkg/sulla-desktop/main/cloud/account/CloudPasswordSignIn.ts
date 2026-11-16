// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AccountKdf, CloudAccountTransport } from '@sulla/domain';

import { CloudAccountCredentialService } from '../CloudAccountCredentialService';

import { CloudAccountHttpError, type CloudSignInResponse, ElectronCloudAccountTransport } from './ElectronCloudAccountTransport';

/** The account's issued KDF and auth version, from /auth/prelogin. */
export interface PreloginAccount {
  kdf:         AccountKdf;
  authVersion: 1 | 2;
}

/** One email+password call. On success the caller owns `masterKey` and must zero it; on failure it is already zeroed. */
export interface PasswordAuthResult {
  ok:          boolean;
  error?:      string;
  httpStatus?: number;
  /** Cloud's machine `code` on a non-2xx (e.g. wrong_password, account_disabled), when the body had one. */
  code?:       string;
  retryAfter?: number;
  data?:       CloudSignInResponse;
  masterKey?:  Uint8Array;
  kdf?:        AccountKdf;
}

/** What the first-run email form shows when it did not sign in. Returned to the renderer as-is (plus `status`). */
export interface FirstRunAccountFailure {
  ok:             false;
  error:          string;
  accountExists?: boolean;
  retryAfter?:    number;
}

export interface FirstRunAccountSuccess {
  ok:        true;
  data:      CloudSignInResponse;
  /** Owned by the caller, who must zero it. */
  masterKey: Uint8Array;
  kdf:       AccountKdf;
  isNewUser: boolean;
}

/** Diagnostics for the first-run trace. Never given a password, key or token. */
export type SignInTraceSink = (area: string, event: string, details?: Record<string, unknown>) => void;

/**
 * Email + password sign-in to Sulla Cloud: prelogin and the issued KDF, the v1 to v2 upgrade, the NFC password retry,
 * register, and the first-run "create or sign in" form. Network calls go through ElectronCloudAccountTransport; the
 * master key derivation through CloudAccountCredentialService. Keys from a failed call are zeroed before returning.
 */
export class CloudPasswordSignIn {
  static readonly WRONG_PASSWORD = 'That password is not correct.';
  static readonly CLOUD_PROBLEM = 'Sulla Cloud had a problem, try again.';
  static readonly NEEDS_UPDATE = 'Sulla needs an update to sign in.';
  static readonly UNREACHABLE = 'Could not reach Sulla Cloud. Check your connection and try again.';
  static readonly ACCOUNT_DISABLED = 'This Sulla Cloud account is disabled.';

  /** Cloud's codes for a credential that did not match (AuthFailureClassifier). Any other code is not about the password. */
  private static readonly CREDENTIAL_CODES: ReadonlySet<string> = new Set(['wrong_password', 'unknown_account', 'invalid_credentials']);

  constructor(
    private readonly transport: CloudAccountTransport,
    private readonly credentials: () => Promise<CloudAccountCredentialService> = () => CloudAccountCredentialService.forDesktop(),
    private readonly trace: SignInTraceSink = () => {},
    private readonly timezone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {}

  /** The account's KDF (vetted: a downgraded or malformed KDF throws) and auth version. Throws `<status>: <error>` on a non-2xx. */
  async prelogin(email: string): Promise<PreloginAccount> {
    const account = await this.transport.prelogin({ email });
    return { kdf: (await this.credentials()).parseIssuedKdf(account.kdf), authVersion: account.authVersion };
  }

  /**
   * New accounts use NFC. Existing decomposed passwords still work once, unchanged (only after a credential rejection).
   * A credential rejection reads "That password is not correct." whatever the server's own wording (BL-003); a
   * disabled account says so; any other failure keeps the server's message.
   */
  async login(email: string, password: string, knownAccount?: PreloginAccount): Promise<PasswordAuthResult> {
    const normalized = password.normalize('NFC');
    const first = await this.loginOnce(email, normalized, knownAccount);
    if (first.ok || normalized === password || !CloudPasswordSignIn.rejected(first)) return CloudPasswordSignIn.explained(first);
    this.trace('account', 'normalized password did not match; trying the legacy byte form');
    return CloudPasswordSignIn.explained(await this.loginOnce(email, password, knownAccount));
  }

  /** Creates a v2 account with a fresh KDF salt. */
  async register(email: string, password: string, name?: string): Promise<PasswordAuthResult> {
    const credential = await (await this.credentials()).derive(password.normalize('NFC'));
    return this.withKey(credential, () => this.transport.register({
      email, authHash: credential.authHash, kdf: credential.kdf, name, timezone: this.timezone(),
    }).then(ElectronCloudAccountTransport.signIn));
  }

  /**
   * First run: one email + password form that either creates the account or signs in to the existing one.
   * /auth/prelogin answers every email with a KDF (real or decoy), so it cannot tell whether an account exists.
   * Register first; only a 409 means the account exists, and then the password signs in.
   */
  async continueFirstRun(email: string, password: string, name?: string): Promise<FirstRunAccountSuccess | FirstRunAccountFailure> {
    try {
      const created = await this.register(email, password, name);
      this.trace('account', 'register answered', { ok: created.ok, httpStatus: created.httpStatus, error: created.error });
      if (created.ok && created.data) {
        return { ok: true, data: created.data, masterKey: created.masterKey!, kdf: created.kdf!, isNewUser: true };
      }
      if (created.httpStatus === 429) return CloudPasswordSignIn.throttled(created, false);
      if (created.httpStatus !== 409) {
        return { ok: false, error: created.httpStatus && created.httpStatus >= 500 ? CloudPasswordSignIn.CLOUD_PROBLEM : created.error || 'Could not create your Sulla Cloud account.' };
      }
      const login = await this.login(email, password);
      this.trace('account', 'existing account; sign-in answered', { ok: login.ok, httpStatus: login.httpStatus, error: login.error });
      if (login.httpStatus === 429) return CloudPasswordSignIn.throttled(login);
      if (!login.ok || !login.data) {
        // login() already explained a 401/403: wrong password, disabled account, or Cloud's own message.
        const error = login.httpStatus === 401 || login.httpStatus === 403
          ? login.error || CloudPasswordSignIn.WRONG_PASSWORD
          : login.httpStatus && login.httpStatus >= 500
            ? CloudPasswordSignIn.CLOUD_PROBLEM
            : login.error || CloudPasswordSignIn.NEEDS_UPDATE;
        return { ok: false, accountExists: true, error };
      }
      return { ok: true, data: login.data, masterKey: login.masterKey!, kdf: login.kdf!, isNewUser: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace('account', 'Cloud account request threw', { error: message });
      const friendly = /unsupported|kdf|version/i.test(message)
        ? CloudPasswordSignIn.NEEDS_UPDATE
        : /\b5\d\d\b/.test(message) ? CloudPasswordSignIn.CLOUD_PROBLEM : CloudPasswordSignIn.UNREACHABLE;
      return { ok: false, error: friendly };
    }
  }

  private async loginOnce(email: string, password: string, knownAccount?: PreloginAccount): Promise<PasswordAuthResult> {
    const account = knownAccount ?? await this.prelogin(email);
    const credential = await (await this.credentials()).derive(password, account.kdf);
    return this.withKey(credential, () => (account.authVersion === 1
      ? this.transport.upgrade({ email, password, authHash: credential.authHash, kdf: credential.kdf })
      : this.transport.emailLogin({ email, authHash: credential.authHash })).then(ElectronCloudAccountTransport.signIn));
  }

  /** Runs the call. A non-2xx becomes a failed result; any failure zeroes the key; a network error is rethrown. */
  private async withKey(credential: { masterKey: Uint8Array; kdf: AccountKdf }, call: () => Promise<CloudSignInResponse>): Promise<PasswordAuthResult> {
    try {
      return { ok: true, data: await call(), masterKey: credential.masterKey, kdf: credential.kdf };
    } catch (error) {
      credential.masterKey.fill(0);
      if (error instanceof CloudAccountHttpError) {
        return { ok: false, error: error.userMessage, httpStatus: error.status, code: error.code, retryAfter: error.retryAfter };
      }
      throw error;
    }
  }

  /** A 401/403 is a credential rejection only without a code (e.g. "Invalid legacy credential.") or with a credential code. */
  private static rejected(result: PasswordAuthResult): boolean {
    if (result.httpStatus !== 401 && result.httpStatus !== 403) return false;
    return !result.code || CloudPasswordSignIn.CREDENTIAL_CODES.has(result.code);
  }

  /** The password was right but Cloud will not issue tokens to this account (issueTokens' account_disabled). */
  private static disabled(result: PasswordAuthResult): boolean {
    return (result.httpStatus === 401 || result.httpStatus === 403) && result.code === 'account_disabled';
  }

  private static explained(result: PasswordAuthResult): PasswordAuthResult {
    if (CloudPasswordSignIn.rejected(result)) return { ...result, error: CloudPasswordSignIn.WRONG_PASSWORD };
    if (CloudPasswordSignIn.disabled(result)) return { ...result, error: CloudPasswordSignIn.ACCOUNT_DISABLED };
    return result;
  }

  private static throttled(result: PasswordAuthResult, accountExists = true): FirstRunAccountFailure {
    const wait = result.retryAfter ?? 60;
    return { ok: false, accountExists, retryAfter: wait, error: `Too many tries. Wait ${ wait } seconds and try again.` };
  }
}
