// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { IntegrationService } from '@pkg/agent/services/IntegrationService';

import type { runOAuthFlow } from '../../sullaOAuthService';
import type { CloudAccountCredentialService } from '../CloudAccountCredentialService';
import type { AuthResult, CloudAuthStatusService } from '../session/CloudAuthStatusService';
import type { CloudAccountWrapService } from './CloudAccountWrapService';
import type { CloudPasswordSignIn } from './CloudPasswordSignIn';
import { CloudSignInCompletion } from './CloudSignInCompletion';
import {
  CloudAccountHttpError, ElectronCloudAccountTransport, type CloudContractor, type CloudSignInResponse,
} from './ElectronCloudAccountTransport';

export interface CloudSignInPorts {
  usesContainerVault(): boolean;
  credentials(): Promise<CloudAccountCredentialService>;
  appleOAuth(): ReturnType<typeof runOAuthFlow>;
  integrations(): IntegrationService;
  timezone(): string;
  trace(message: string, details?: Record<string, unknown>): void;
  logger: { warn(message: string, detail?: unknown): void };
}

const UNREACHABLE = 'Could not reach Sulla Cloud. Check your connection and try again.';
const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';
const RESET_UNAVAILABLE = 'Password reset is not available right now.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every Sulla Cloud sign-in method behind the `sulla-cloud:*` IPC channels: phone OTP, email code, email + password, Apple. */
export class CloudSignInService {
  constructor(
    private readonly transport: ElectronCloudAccountTransport,
    private readonly passwords: CloudPasswordSignIn,
    private readonly completion: CloudSignInCompletion,
    private readonly status: CloudAuthStatusService,
    private readonly wrap: CloudAccountWrapService,
    private readonly ports: CloudSignInPorts,
  ) {}

  private static userIdOf(data: CloudSignInResponse): string {
    return data.userId ?? data.contractor.id;
  }

  async passwordResetAvailable(): Promise<{ available: boolean }> {
    try {
      return { available: await this.transport.passwordResetAvailable() };
    } catch { return { available: false } }
  }

  async sendOtp(phone: string): Promise<AuthResult> {
    const normalized = phone.trim();
    if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
      return {
        ok:     false,
        error:  'Invalid phone format. Use E.164, e.g. +15551234567.',
        status: await this.status.build(),
      };
    }
    const result = await CloudAccountHttpError.settle(this.transport.phoneOtpSend({ phone: normalized }));
    if (!result.ok) {
      return { ok: false, error: result.error, status: await this.status.build(result.error) };
    }
    return { ok: true, status: await this.status.build() };
  }

  async verifyOtp(phone: string, code: string): Promise<AuthResult> {
    const normalizedPhone = phone.trim();
    const normalizedCode = code.trim();
    if (!normalizedPhone || !/^\d{4,8}$/.test(normalizedCode)) {
      return {
        ok:     false,
        error:  'Enter the code from your text message.',
        status: await this.status.build(),
      };
    }

    const result = await CloudAccountHttpError.settle(this.transport.phoneOtpVerify({ phone: normalizedPhone, code: normalizedCode }).then(ElectronCloudAccountTransport.signIn));
    if (!result.ok) {
      return { ok: false, error: result.error, status: await this.status.build(result.error) };
    }
    return this.completion.forCurrentState(result.data, CloudSignInCompletion.NOT_READY);
  }

  async emailLogin(email: string, password: string): Promise<AuthResult> {
    const e = email.trim().toLowerCase();
    if (!e || !password) {
      return { ok: false, error: 'Email and password are required.', status: await this.status.build() };
    }
    return this.passwordSignedIn(await this.passwords.login(e, password));
  }

  async emailRegister(email: string, password: string, name?: string): Promise<AuthResult> {
    const e = email.trim().toLowerCase();
    if (!e || !password) {
      return { ok: false, error: 'Enter your email and a password.', status: await this.status.build() };
    }
    return this.passwordSignedIn(await this.passwords.register(e, password, name?.trim()));
  }

  async emailCodeStart(email: unknown) {
    const e = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return { ok: false, error: 'Enter a valid email address.' };
    try {
      const started = await CloudAccountHttpError.settle(this.transport.startEmailCode({ email: e }));
      return started.ok ? { ok: true } : started;
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  }

  async passwordResetStart(email: unknown) {
    const e = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return { ok: false, error: 'Enter a valid email address.' };
    try {
      await this.transport.startPasswordReset({ email: e });
      return { ok: true };
    } catch (error) {
      if (error instanceof CloudAccountHttpError) return { ok: false, error: error.status === 429 ? TOO_MANY : RESET_UNAVAILABLE };
      return { ok: false, error: UNREACHABLE };
    }
  }

  async passwordResetComplete(email: unknown, code: unknown, password: string) {
    const e = String(email ?? '').trim().toLowerCase();
    const c = String(code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(c)) return { ok: false, error: 'Enter the 6-digit code from the email.' };
    if (!password) return { ok: false, error: 'Enter a password.' };
    const credential = await (await this.ports.credentials()).derive(password.normalize('NFC'));
    try {
      let body: { vaultState?: string };
      try {
        body = await this.transport.completePasswordReset({ email: e, code: c, authHash: credential.authHash, kdf: credential.kdf });
      } catch (error) {
        if (!(error instanceof CloudAccountHttpError)) throw error;
        credential.masterKey.fill(0);
        return { ok: false, error: error.status === 400 ? 'That code is wrong or expired.' : error.status === 429 ? TOO_MANY : RESET_UNAVAILABLE };
      }
      credential.masterKey.fill(0);
      this.ports.trace('Cloud password reset completed; signing in');
      const login = await this.passwords.login(e, password);
      if (!login.ok || !login.data || !login.masterKey || !login.kdf) return { ok: false, error: 'Password changed. Sign in again to continue.' };
      this.wrap.retain(login.masterKey, login.kdf, CloudSignInService.userIdOf(login.data));
      const signedIn = await this.completion.completeFirstRun(login.data);
      return { ...signedIn, vaultNeedsRecovery: body.vaultState === 'needs_recovery' };
    } catch {
      credential.masterKey.fill(0);
      return { ok: false, error: UNREACHABLE };
    }
  }

  async emailCodeVerify(email: unknown, code: unknown, name?: string) {
    const e = String(email ?? '').trim().toLowerCase();
    const c = String(code ?? '').replace(/\s+/g, '');
    if (!e || !/^\d{6}$/.test(c)) {
      return { ok: false, error: 'Enter the 6-digit code from the email.', status: await this.status.build() };
    }
    let result: { ok: true; data: CloudSignInResponse } | { ok: false; error: string };
    try {
      result = await CloudAccountHttpError.settle(this.transport.verifyEmailCode({
        email: e, code: c, name: name?.trim() || undefined, timezone: this.ports.timezone(),
      }).then(ElectronCloudAccountTransport.signIn));
    } catch {
      return { ok: false, error: UNREACHABLE, status: await this.status.build() };
    }
    if (!result.ok) {
      return { ok: false, error: result.error, status: await this.status.build(result.error) };
    }
    // The code is spent and the tokens are in hand. On first run the VM's
    // Postgres may still be booting, so keep trying to persist the session
    // instead of forcing the user to request a new code.
    const firstRun = this.completion.keepInMemory();
    const signedIn = await this.completion.forCurrentState(result.data, 'Your email is verified, but Sulla is still starting up. Wait a minute, then send a new code.');
    return { ...signedIn, isNewUser: !!result.data.isNewUser, needsPassword: firstRun };
  }

  /**
   * First run: one email + password form that either creates the Sulla Cloud
   * account or signs in to the existing one. Register answers 409 when the
   * email already has an account; only then is the password checked against
   * it. No email is sent, so this works before email delivery exists.
   */
  async emailContinue(email: unknown, password: string, name?: string) {
    const e = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      return { ok: false, error: 'Enter a valid email address.', status: await this.status.build().catch(() => ({} as any)) };
    }
    if (!password) {
      return { ok: false, error: 'Enter a password.', status: await this.status.build().catch(() => ({} as any)) };
    }
    this.ports.trace('Cloud account submit', { emailDomain: e.split('@')[1], inMemory: this.completion.keepInMemory() });
    const account = await this.passwords.continueFirstRun(e, password, name?.trim() || undefined);
    if (!account.ok) return { ...account, status: await this.status.build().catch(() => ({} as any)) };
    const { data, masterKey, kdf: accountKdf, isNewUser } = account;
    this.wrap.retain(masterKey, accountKdf, CloudSignInService.userIdOf(data));
    const signedIn = this.completion.keepInMemory()
      ? await this.completion.completeFirstRun(data)
      : await this.completion.completeWhenReady(data, CloudSignInCompletion.NOT_READY);
    if (signedIn.ok && !this.completion.keepInMemory()) await this.wrap.flushAfterSignIn(CloudSignInService.userIdOf(data));
    this.ports.trace('Cloud sign-in finished', { ok: signedIn.ok, isNewUser, heldInMemory: this.completion.keepInMemory(), error: signedIn.error });
    return { ...signedIn, isNewUser };
  }

  async appleSignIn(identityToken: string, fullName?: string, email?: string): Promise<AuthResult> {
    if (!identityToken?.trim()) {
      return { ok: false, error: 'Apple identity token missing.', status: await this.status.build() };
    }
    const result = await CloudAccountHttpError.settle(this.transport.apple({ identityToken: identityToken.trim(), fullName, email }).then(ElectronCloudAccountTransport.signIn));
    if (!result.ok) {
      return { ok: false, error: result.error, status: await this.status.build(result.error) };
    }
    return this.completion.forCurrentState(result.data, CloudSignInCompletion.NOT_READY);
  }

  /**
   * Runs the full web-OAuth Sign-in-with-Apple flow in a BrowserWindow. On
   * success, persists:
   *   - The Sulla Cloud session to integration_id="sulla-cloud" (via completion)
   *   - The Apple identity to integration_id="apple_signin" so the Apple
   *     integration shows as "connected" in the vault UI.
   */
  async appleSignInBrowser(): Promise<AuthResult> {
    try {
      const flow = await this.ports.appleOAuth();

      // Save Apple identity to the apple_signin integration vault record so
      // it appears as "connected" when the user opens the vault.
      if (!this.ports.usesContainerVault()) {
        try {
          const svc = this.ports.integrations();
          const appleAccountId = flow.claims.sub;
          await svc.setMultipleValues([
            { integration_id: 'apple_signin', account_id: appleAccountId, property: 'apple_user_id', value: flow.claims.sub },
            { integration_id: 'apple_signin', account_id: appleAccountId, property: 'email',         value: flow.claims.email ?? '' },
            { integration_id: 'apple_signin', account_id: appleAccountId, property: 'full_name',     value: flow.claims.fullName ?? '' },
            { integration_id: 'apple_signin', account_id: appleAccountId, property: 'id_token',      value: flow.tokens.idToken ?? '' },
          ]);
          await svc.setConnectionStatus('apple_signin', true, appleAccountId);
          await svc.setActiveAccount('apple_signin', appleAccountId);
        } catch (err) {
          this.ports.logger.warn('[SullaCloudAuth] Failed to save apple_signin record:', err);
        }
      }

      const sulla = flow.sullaSession;
      if (!sulla) {
        return {
          ok:     false,
          error:  'Apple sign-in did not return a Sulla Cloud session.',
          status: await this.status.build(),
        };
      }
      // Wrap the worker's sullaSession into the sign-in response shape the completion expects.
      const verifyLike: CloudSignInResponse = {
        accessToken:  sulla.accessToken,
        refreshToken: sulla.refreshToken,
        contractor:   sulla.contractor as CloudContractor,
      };
      return this.completion.forCurrentState(verifyLike, CloudSignInCompletion.NOT_READY);
    } catch (err: any) {
      const msg = err?.message === 'user_cancelled'
        ? 'Sign-in cancelled.'
        : err?.message === 'oauth_flow_timeout'
          ? 'Sign-in timed out. Try again.'
          : err?.message === 'oauth_flow_expired'
            ? 'Sign-in session expired. Try again.'
            : (err?.message || 'Apple sign-in failed.');
      return { ok: false, error: msg, status: await this.status.build(msg) };
    }
  }

  /** email-login and email-register share this tail: hold the key, persist, re-wrap the vault when signed in. */
  private async passwordSignedIn(result: Awaited<ReturnType<CloudPasswordSignIn['login']>>): Promise<AuthResult> {
    if (!result.ok || !result.data || !result.masterKey) {
      return { ok: false, error: result.error, status: await this.status.build(result.error) };
    }
    this.wrap.retain(result.masterKey, result.kdf!, CloudSignInService.userIdOf(result.data));
    const inMemory = this.completion.keepInMemory();
    const signedIn = await this.completion.forCurrentState(result.data, CloudSignInCompletion.NOT_READY);
    if (signedIn.ok && !inMemory) await this.wrap.flushAfterSignIn(CloudSignInService.userIdOf(result.data));
    return signedIn.ok ? { ...signedIn, needsVaultMigration: await this.completion.needsOldVaultPasswordMigration(inMemory) } : signedIn;
  }
}
