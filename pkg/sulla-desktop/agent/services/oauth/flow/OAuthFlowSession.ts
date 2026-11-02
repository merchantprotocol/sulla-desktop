// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';

import { BrowserWindow, shell } from 'electron';

import { createContainedAuthWindow } from '@pkg/main/containedAuthWindow';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';

import { OAuthCallbackPortInUseError, startOAuthCallbackServer } from '../../OAuthCallbackServer';
import { CallbackPortInUseError, CallbackPortLease } from './CallbackPortLease';

import type { OAuthProviderConfig } from '../../../integrations/oauth/OAuthProvider';

const LOG_PREFIX = '[OAuthFlowSession]';

export type AuthorizationFailureCode = 'cancelled' | 'port_in_use' | 'provider_error' | 'state_mismatch' | 'timeout';

export interface AuthorizationSuccess {
  ok:           true;
  code:         string;
  codeVerifier?: string;
  redirectUri:  string;
}

export interface AuthorizationFailure {
  ok:      false;
  code:    AuthorizationFailureCode;
  message: string;
  owner?:  string;
  port?:   number;
}

export type AuthorizationResult = AuthorizationSuccess | AuthorizationFailure;

export interface OAuthFlowSessionOptions {
  requesterId: string;
  integrationId: string;
  providerId: string;
  config: OAuthProviderConfig;
  buildAuthorizeUrl: (input: {
    redirectUri: string;
    state: string;
    codeChallenge?: string;
  }) => string | Promise<string>;
}

/** Owns every disposable resource belonging to exactly one browser authorization attempt. */
export class OAuthFlowSession {
  private cancelCurrent: (() => void) | null = null;
  private lease: CallbackPortLease | null = null;

  constructor(private readonly options: OAuthFlowSessionOptions) {}

  cancel(): void {
    this.cancelCurrent?.();
    this.lease?.release();
    this.lease = null;
  }

  async authorize(): Promise<AuthorizationResult> {
    const { config: cfg, integrationId, providerId } = this.options;
    const owner = `${ this.options.requesterId } (${ integrationId }/${ providerId })`;
    let lease: CallbackPortLease | null = null;
    firstRunTrace('oauth', 'authorization started', { integrationId, providerId, accountId: this.options.requesterId, status: 'started' });
    try {
      lease = CallbackPortLease.acquire(cfg.fixedCallbackPort, owner);
      this.lease = lease;
      firstRunTrace('oauth', 'callback port leased', { integrationId, providerId, accountId: this.options.requesterId, status: 'success', port: cfg.fixedCallbackPort ?? 'dynamic' });
    } catch (error) {
      if (error instanceof CallbackPortInUseError) {
        firstRunTrace('oauth', 'callback port lease failed', { integrationId, providerId, accountId: this.options.requesterId, status: error.code, error });
        return { ok: false, code: 'port_in_use', message: error.message, owner: error.owner, port: error.port };
      }
      throw error;
    }

    const state = crypto.randomBytes(24).toString('hex');
    const codeVerifier = cfg.usePKCE ? crypto.randomBytes(64).toString('base64url') : undefined;
    const codeChallenge = codeVerifier
      ? crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      : undefined;
    let authWindow: BrowserWindow | null = null;
    let shutdown: (() => void) | null = null;

    try {
      const callback = await startOAuthCallbackServer({
        expectedState: state,
        fixedPort: cfg.fixedCallbackPort,
        callbackPath: cfg.fixedCallbackPath,
        useLocalhostHostname: cfg.useLocalhostHostname ?? !!cfg.fixedCallbackPort,
      });
      callback.codePromise.catch(() => undefined);
      shutdown = callback.shutdown;
      const redirectUri = callback.redirectUri;
      const authorizeUrl = await this.options.buildAuthorizeUrl({ redirectUri, state, codeChallenge });
      let codeSource: Promise<{ code: string }> = callback.codePromise;
      this.cancelCurrent = () => {
        shutdown?.();
        if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
      };

      if (cfg.openInEmbeddedWindow) {
        firstRunTrace('oauth', 'auth window opened', { integrationId, providerId, embedded: true });
        let deliver!: (result: { code: string }) => void;
        let fail!: (error: Error) => void;
        const intercepted = new Promise<{ code: string }>((resolve, reject) => { deliver = resolve; fail = reject });
        const expected = new URL(redirectUri);
        authWindow = createContainedAuthWindow({
          width: 820,
          height: 720,
          title: `Sign in — ${ cfg.name }`,
          partition: 'persist:integration-oauth',
          logPrefix: LOG_PREFIX,
          onUrl: (target) => {
            let url: URL;
            try { url = new URL(target) } catch { return false }
            const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
            if (!loopback || url.port !== expected.port || url.pathname !== expected.pathname) return false;
            const providerError = url.searchParams.get('error');
            if (providerError) {
              fail(new Error(`OAuth error: ${ url.searchParams.get('error_description') || providerError }`));
              return true;
            }
            const code = url.searchParams.get('code');
            if (!code) return false;
            if (url.searchParams.get('state') !== state) {
              fail(new Error('OAuth state mismatch'));
              return true;
            }
            firstRunTrace('oauth', 'callback intercepted', { integrationId, providerId, source: 'window' });
            deliver({ code });
            return true;
          },
        });
        authWindow.loadURL(authorizeUrl).catch(error => fail(error));
        intercepted.catch(() => undefined);
        callback.codePromise.catch(() => undefined);
        codeSource = Promise.race([callback.codePromise, intercepted]);
      } else {
        firstRunTrace('oauth', 'auth window opened', { integrationId, providerId, embedded: false });
        await shell.openExternal(authorizeUrl);
      }

      const code = await this.awaitCode(codeSource, authWindow);
      firstRunTrace('oauth', 'callback received', { integrationId, providerId, accountId: this.options.requesterId, status: 'success' });
      shutdown();
      shutdown = null;
      return { ok: true, code: code.code, codeVerifier, redirectUri };
    } catch (error) {
      if (error instanceof OAuthCallbackPortInUseError) {
        return { ok: false, code: 'port_in_use', message: error.message, owner: 'another process', port: error.port };
      }
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const code: AuthorizationFailureCode = lower.includes('already in use') || lower.includes('eaddrinuse') ? 'port_in_use'
        : lower.includes('state mismatch') ? 'state_mismatch'
        : lower.includes('timed out') || lower.includes('timeout') ? 'timeout'
          : lower.includes('cancel') || lower.includes('window closed') ? 'cancelled'
            : 'provider_error';
      firstRunTrace('oauth', 'authorization failed', { integrationId, providerId, accountId: this.options.requesterId, status: code, error: message });
      return { ok: false, code, message };
    } finally {
      this.cancelCurrent = null;
      shutdown?.();
      if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
      lease?.release();
      this.lease = null;
    }
  }

  private awaitCode(codePromise: Promise<{ code: string }>, authWindow: BrowserWindow | null): Promise<{ code: string }> {
    if (!authWindow) return codePromise;
    return new Promise((resolve, reject) => {
      let settled = false;
      codePromise.then(result => {
        if (settled) return;
        settled = true;
        resolve(result);
      }, error => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      authWindow.on('closed', () => {
        if (settled) return;
        settled = true;
        reject(new Error('Sign-in window closed before authorization completed'));
      });
    });
  }
}
