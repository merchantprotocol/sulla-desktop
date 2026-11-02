// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// OAuthService — Core orchestrator for OAuth 2.0 flows.
// Handles: authorize URL generation, code exchange, token storage (DB-backed),
// automatic refresh, and revocation.

import crypto from 'crypto';

import { BrowserWindow, shell } from 'electron';

import { getIntegrationService } from './IntegrationService';
import { startOAuthCallbackServer } from './OAuthCallbackServer';
import { REFRESH_RETRY_DELAY_MS, refreshRetryDelayMs } from './oauthRefreshRetry';
import { CustodyResolver } from './oauth/custody/CustodyResolver';
import { isRawTokenCustody, type RawTokenCustody, type ResolvedTokenCustody, type TokenCustody } from './oauth/custody/TokenCustody';
import { RefreshScheduler } from './oauth/RefreshScheduler';
import {
  issueLocalBrokerContext,
  requireConfiguredCredentialBroker,
} from '../../vault-broker';
import { getOAuthProvider, type OAuthTokenSet } from '../integrations/oauth';

import { createContainedAuthWindow } from '@pkg/main/containedAuthWindow';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';

import type { OAuthProviderConfig } from '../integrations/oauth/OAuthProvider';

const LOG_PREFIX = '[OAuthService]';
const DEFAULT_REFRESH_BUFFER_SECONDS = 300;
const UNKNOWN_EXPIRY_REFRESH_AFTER_MS = 55 * 60 * 1000;
const MIN_REFRESH_DELAY_MS = 5000;

// ─── DB row shape ─────────────────────────────────────────────────

interface OAuthTokenRow {
  token_id?:      number;
  integration_id: string;
  account_id:     string;
  provider_id:    string;
  access_token:   string;
  refresh_token:  string | null;
  token_type:     string;
  scope:          string | null;
  expires_at:     number | null;
  raw_response:   Record<string, unknown> | null;
  created_at?:    Date;
  updated_at:     Date;
}

interface VaultRefreshTarget {
  providerId: string;
  clientId:   string;
  expiresAt?: number;
  /** Epoch ms when this account is next due for a refresh. */
  refreshAt:  number;
}

// ─── Active refresh timers ────────────────────────────────────────

function timerKey(integrationId: string, accountId: string): string {
  return `${ integrationId }::${ accountId }`;
}

function decodeAccessTokenExpiry(accessToken: unknown): number | null {
  if (typeof accessToken !== 'string') return null;
  const payload = accessToken.split('.')[1];
  if (!payload) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));

    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Delay before a proactive refresh: `buffer` ahead of expiry, never sooner than 5s. */
export function refreshDelayMs(expiresAt: number | undefined, bufferMs: number, now = Date.now()): number {
  const refreshAt = expiresAt ? expiresAt - bufferMs : now + UNKNOWN_EXPIRY_REFRESH_AFTER_MS;

  return Math.max(refreshAt - now, MIN_REFRESH_DELAY_MS);
}

function metadataExpiry(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeTokenExpiry<T extends OAuthTokenSet>(tokens: T): T {
  if (tokens.expires_in && !tokens.expires_at) {
    tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  }
  if (!tokens.expires_at) {
    const jwtExpiry = decodeAccessTokenExpiry(tokens.access_token);
    if (jwtExpiry) tokens.expires_at = jwtExpiry;
  }

  return tokens;
}

function refreshFailureReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const failure = body as Record<string, unknown>;
  for (const field of ['error_description', 'reason', 'error', 'message']) {
    const value = failure[field];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300);
  }
  return undefined;
}

// ─── Singleton ────────────────────────────────────────────────────

let instance: OAuthService | null = null;

export function getOAuthService(): OAuthService {
  if (!instance) {
    instance = new OAuthService();
  }
  return instance;
}

// ─── Service ──────────────────────────────────────────────────────

export class OAuthService {
  private readonly activeFlows = new Map<string, () => void>();
  private readonly custodyResolver = new CustodyResolver();
  private readonly scheduler = new RefreshScheduler();

  cancelFlow(integrationId: string): boolean {
    const cancel = this.activeFlows.get(integrationId);
    if (!cancel) return false;
    cancel();
    return true;
  }

  // ── Initiate OAuth flow ───────────────────────────────────────

  /**
   * Start the full OAuth 2.0 authorization code flow for an integration.
   *
   * 1. Spins up an ephemeral localhost server to capture the callback.
   * 2. Builds the authorize URL and opens it in the user's default browser.
   * 3. Waits for the callback (or timeout).
   * 4. Exchanges the auth code for tokens.
   * 5. Stores tokens in the DB and marks the integration as connected.
   *
   * @param integrationId  The integration being connected (e.g. 'gmail').
   * @param providerId     The OAuthProvider id (e.g. 'google').
   * @param clientId       The user's OAuth client ID (from integration form). Optional for public-client providers with builtInClientId.
   * @param clientSecret   The user's OAuth client secret. Optional for public-client providers.
   * @param accountId      Multi-account support — defaults to 'default'.
   * @param extraScopes    Additional scopes beyond the provider defaults.
   */
  async startFlow(
    integrationId: string,
    providerId: string,
    clientId: string,
    clientSecret: string,
    accountId = 'default',
    extraScopes: string[] = [],
    persist = true,
  ): Promise<OAuthTokenSet> {
    firstRunTrace('oauth', 'provider flow started', { integrationId, providerId, accountId, persist });
    const custody = this.custodyResolver.resolve({ firstRun: !persist });
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`${ LOG_PREFIX } Unknown OAuth provider: ${ providerId }`);
    }
    const cfg = provider.config;
    // A retry owns this provider's one sign-in slot. Tear down the old window
    // and callback listener before binding its fixed port again.
    this.activeFlows.get(integrationId)?.();
    // Resolve effective client_id (built-in takes precedence for public clients).
    // Providers with registrationEndpoint can fill this after the callback
    // server starts, because DCR needs the actual redirect_uri for this flow.
    let effectiveClientId = cfg.builtInClientId || clientId;
    if (custody.kind === 'vault' && !effectiveClientId) {
      const metadata = await getIntegrationService().getMetadataValues(integrationId, accountId);
      const values = Object.fromEntries(metadata.map(value => [value.property, value.value]));
      effectiveClientId = values.oauth_client_id || values.client_id || '';
    }
    const effectiveClientSecret = custody.kind === 'vault' || cfg.clientAuthMethod === 'none' ? '' : clientSecret;

    // Generate CSRF state
    const state = crypto.randomBytes(24).toString('hex');

    // Generate PKCE verifier/challenge if required
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (cfg.usePKCE) {
      codeVerifier = crypto.randomBytes(64).toString('base64url');
      codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    }

    // Start callback server (with optional fixed port/path)
    const { redirectUri, codePromise, shutdown } = await startOAuthCallbackServer({
      expectedState:        state,
      fixedPort:            cfg.fixedCallbackPort,
      callbackPath:         cfg.fixedCallbackPath,
      useLocalhostHostname: cfg.useLocalhostHostname ?? !!cfg.fixedCallbackPort,
    });
    console.log(`${ LOG_PREFIX } Callback server listening at ${ redirectUri }`);

    let authWindow: BrowserWindow | null = null;
    let codeSource: Promise<{ code: string }> = codePromise;
    const cancel = () => {
      shutdown();
      if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
    };
    this.activeFlows.set(integrationId, cancel);

    try {
      if (!effectiveClientId && cfg.registrationEndpoint) {
        const registration = await this.registerDynamicClient(custody, cfg, redirectUri, integrationId, accountId);
        effectiveClientId = registration.clientId;
        if (custody.kind !== 'vault') {
          const integrationService = getIntegrationService();
          await integrationService.setIntegrationValue({
            integration_id: integrationId,
            account_id:     accountId,
            property:       'oauth_client_id',
            value:          effectiveClientId,
          });
        }
        console.log(`${ LOG_PREFIX } Registered OAuth client for ${ integrationId }/${ accountId }`);
      }

      if (!effectiveClientId) {
        throw new Error(`${ LOG_PREFIX } Missing client_id for OAuth provider ${ providerId }`);
      }

      // Build authorize URL
      const authorizeUrl = this.buildAuthorizeUrl(cfg, effectiveClientId, redirectUri, state, extraScopes, codeChallenge);

      if (cfg.openInEmbeddedWindow) {
        firstRunTrace('oauth', 'auth window opened', { integrationId, providerId, embedded: true });
        // Render the sign-in page inside Sulla Desktop rather than handing off
        // to the host's default browser. Required for providers whose tokens
        // are materialized for an in-VM consumer (e.g. Codex's
        // ~/.codex/auth.json) — an external browser would finish the handshake
        // outside Sulla and the in-VM tool would never see the credentials.
        console.log(`${ LOG_PREFIX } Opening embedded auth window for ${ cfg.name }...`);
        // Read the code straight off the redirect inside our own window. The
        // localhost server stays as the fallback, but the hop through
        // localhost can miss (localhost resolving to ::1 while the server is
        // on 127.0.0.1), and the user then only sees a 5-minute timeout.
        let deliver!: (result: { code: string }) => void;
        let fail!: (err: Error) => void;
        const intercepted = new Promise<{ code: string }>((resolve, reject) => { deliver = resolve; fail = reject });
        const expected = new URL(redirectUri);
        authWindow = this.openEmbeddedAuthWindow(authorizeUrl, cfg.name, (target) => {
          let url: URL;
          try { url = new URL(target) } catch { return false }
          const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
          if (!loopback || url.port !== expected.port || url.pathname !== expected.pathname) return false;
          const error = url.searchParams.get('error');
          if (error) {
            fail(new Error(`OAuth error: ${ url.searchParams.get('error_description') || error }`));
            return true;
          }
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.get('state') !== state) return false;
          console.log(`${ LOG_PREFIX } Intercepted callback in the auth window`);
          firstRunTrace('oauth', 'callback intercepted', { integrationId, providerId, source: 'window' });
          deliver({ code });
          return true;
        });
        intercepted.catch(() => { /* surfaced through the race below */ });
        codePromise.catch(() => { /* superseded once the window delivers */ });
        codeSource = Promise.race([codePromise, intercepted]);
      } else {
        firstRunTrace('oauth', 'auth window opened', { integrationId, providerId, embedded: false });
        console.log(`${ LOG_PREFIX } Opening browser for authorization...`);
        await shell.openExternal(authorizeUrl);
      }

      // Wait for the user to complete authorization. The localhost callback
      // server captures the code regardless of which browser rendered the page;
      // when we own the window, also treat the user closing it as a cancel.
      const { code } = await this.awaitAuthorizationCode(codeSource, authWindow);
      shutdown(); // free the fixed callback port as soon as the code is in hand
      console.log(`${ LOG_PREFIX } Received authorization code`);
      firstRunTrace('oauth', 'callback received', { integrationId, providerId });

      // Exchange code for tokens
      const tokens = normalizeTokenExpiry(
        await this.exchangeCode(
          custody,
          cfg, effectiveClientId, effectiveClientSecret, code, redirectUri, codeVerifier, integrationId, accountId, persist,
        ),
      );
      if (cfg.registrationEndpoint) {
        tokens.oauth_client_id = effectiveClientId;
      }
      console.log(`${ LOG_PREFIX } Token exchange successful`);
      firstRunTrace('oauth', 'token exchange completed', { integrationId, providerId, success: true });

      await custody.store({ integrationId, accountId, providerId }, tokens);
      if (custody.kind === 'memory') {
        // First run may happen before the vault, Postgres, or Redis exists.
        firstRunTrace('oauth', 'provider flow completed', { integrationId, providerId, success: true, custody: 'pending' });
        return tokens;
      }
      if (custody.kind === 'vault') {
        // Metadata is not a token set; provider hooks cannot observe it.
        this.scheduleRefresh(custody, integrationId, accountId, providerId, effectiveClientId, '', tokens);
        return tokens;
      }

      await provider.onTokenReceived(tokens, { integrationId, accountId, providerId, clientId: effectiveClientId });
      firstRunTrace('oauth', 'credentials persisted', { integrationId, providerId });

      // Mark integration as connected
      const integrationService = getIntegrationService();
      await integrationService.setConnectionStatus(integrationId, true, accountId);

      // Schedule proactive refresh
      this.scheduleRefresh(custody, integrationId, accountId, providerId, effectiveClientId, effectiveClientSecret, tokens);

      firstRunTrace('oauth', 'provider flow completed', { integrationId, providerId, success: true, custody: 'persisted' });
      return tokens;
    } catch (err) {
      shutdown();
      firstRunTrace('oauth', 'provider flow completed', { integrationId, providerId, success: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      if (this.activeFlows.get(integrationId) === cancel) this.activeFlows.delete(integrationId);
      // Always tear down the in-app window we opened — on success (after the
      // brief callback "you can close this" page) and on any error/cancel.
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.destroy();
        firstRunTrace('oauth', 'auth window closed', { integrationId, providerId });
      }
    }
  }

  // ── Embedded auth window (in-app browser) ─────────────────────

  /** Open the authorize URL in a Sulla-owned Electron window. */
  private openEmbeddedAuthWindow(url: string, providerName: string, onUrl?: (url: string) => boolean): BrowserWindow {
    // Contained: no hand-offs to other apps, popups stay in Sulla, and the
    // code can only come back through our localhost callback server.
    const win = createContainedAuthWindow({
      width:     820,
      height:    720,
      title:     `Sign in — ${ providerName }`,
      partition: 'persist:integration-oauth',
      logPrefix: LOG_PREFIX,
      onUrl,
    });
    win.loadURL(url).catch((err) => {
      console.warn(`${ LOG_PREFIX } Failed to load embedded auth window:`, err);
    });
    return win;
  }

  /**
   * Resolve with the captured auth code. When an embedded window is in use,
   * a manual close of that window rejects as a user cancellation so the flow
   * doesn't hang on a promise that will never resolve.
   */
  private awaitAuthorizationCode(
    codePromise: Promise<{ code: string }>,
    authWindow: BrowserWindow | null,
  ): Promise<{ code: string }> {
    if (!authWindow) {
      return codePromise;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      codePromise.then(
        (res) => {
          if (settled) return;
          settled = true;
          resolve(res);
        },
        (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
      );
      authWindow.on('closed', () => {
        if (settled) return;
        settled = true;
        reject(new Error(`${ LOG_PREFIX } Sign-in window closed before authorization completed`));
      });
    });
  }

  // ── Build authorize URL ───────────────────────────────────────

  private buildAuthorizeUrl(
    cfg: OAuthProviderConfig,
    clientId: string,
    redirectUri: string,
    state: string,
    extraScopes: string[],
    codeChallenge?: string,
  ): string {
    const sep = cfg.scopeSeparator ?? ' ';
    const allScopes = [...cfg.scopes, ...extraScopes];

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     clientId,
      redirect_uri:  redirectUri,
      scope:         allScopes.join(sep),
      state,
      ...cfg.extraAuthorizeParams,
    });

    // PKCE code_challenge
    if (codeChallenge) {
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    return `${ cfg.authorizeUrl }?${ params.toString() }`;
  }

  // ── Dynamic Client Registration ───────────────────────────────

  private async registerDynamicClient(
    custody: ResolvedTokenCustody,
    cfg: OAuthProviderConfig,
    redirectUri: string,
    integrationId: string,
    accountId: string,
  ): Promise<{ clientId: string }> {
    if (!cfg.registrationEndpoint) {
      throw new Error(`${ LOG_PREFIX } OAuth provider ${ cfg.id } has no registrationEndpoint`);
    }

    const metadata = {
      client_name:                `Sulla Desktop - ${ cfg.name }`,
      grant_types:                ['authorization_code', 'refresh_token'],
      response_types:             ['code'],
      token_endpoint_auth_method: cfg.clientAuthMethod === 'none' ? 'none' : (cfg.clientAuthMethod ?? 'body'),
      ...cfg.registrationClientMetadata,
      redirect_uris:              [redirectUri],
    };

    if (custody.kind === 'vault') {
      const context = await issueLocalBrokerContext({
        agentId:         'oauth-register',
        podId:           'desktop-main',
        credentialScope: { integration_id: integrationId, account_id: accountId },
      });
      const broker = requireConfiguredCredentialBroker();
      const result = await broker.execute(broker.requestFor(context, {
        operation:  'oauth.register',
        ref:        { integrationId, accountId },
        url:        cfg.registrationEndpoint,
        method:     'POST',
        headers:    {
          'content-type': 'application/json',
          accept:         'application/json',
          'user-agent':   'Sulla-Desktop/1.0',
        },
        body:       metadata,
        injections: [],
      }));
      firstRunTrace('oauth', 'token exchange response', { integrationId, providerId: cfg.id, status: result.status, success: result.status >= 200 && result.status < 300 });
      const body = result.body;
      const clientId = body && typeof body === 'object' && typeof (body as Record<string, unknown>).client_id === 'string'
        ? (body as Record<string, string>).client_id
        : '';
      if (result.status < 200 || result.status >= 300 || !clientId) {
        throw new Error(`${ LOG_PREFIX } Vault-owned dynamic client registration failed`);
      }
      return { clientId };
    }

    const res = await fetch(cfg.registrationEndpoint, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
        'User-Agent':   'Sulla-Desktop/1.0',
      },
      body: JSON.stringify(metadata),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${ LOG_PREFIX } Dynamic client registration failed (${ res.status }): ${ text }`);
    }

    const json = await res.json() as { client_id?: string };
    if (!json.client_id || typeof json.client_id !== 'string') {
      throw new Error(`${ LOG_PREFIX } Dynamic client registration response missing client_id`);
    }

    return { clientId: json.client_id };
  }

  // ── Exchange auth code for tokens ─────────────────────────────

  private async exchangeCode(
    custody: ResolvedTokenCustody,
    cfg: OAuthProviderConfig,
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
    codeVerifier?: string,
    integrationId?: string,
    accountId?: string,
    useVault = true,
  ): Promise<OAuthTokenSet> {
    const body: Record<string, string> = {
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
      ...cfg.extraTokenParams,
    };

    // PKCE code_verifier
    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json',
      'User-Agent':   'Sulla-Desktop/1.0',
    };

    if (custody.kind === 'vault' && useVault) {
      if (!integrationId || !accountId) throw new Error(`${ LOG_PREFIX } OAuth exchange is missing its vault scope`);
      const injections = cfg.clientAuthMethod === 'header'
        ? [{ field: 'client_secret', target: 'header' as const, name: 'authorization', scheme: 'BasicClient' as const }]
        : cfg.clientAuthMethod === 'none'
          ? []
          : [
            { field: 'client_id', target: 'form' as const, name: 'client_id', scheme: 'raw' as const },
            { field: 'client_secret', target: 'form' as const, name: 'client_secret', scheme: 'raw' as const },
          ];
      if (cfg.clientAuthMethod === 'none') body.client_id = clientId;
      const context = await issueLocalBrokerContext({
        agentId:         'oauth-exchange',
        podId:           'desktop-main',
        credentialScope: { integration_id: integrationId, account_id: accountId },
      });
      const broker = requireConfiguredCredentialBroker();
      const result = await broker.execute(broker.requestFor(context, {
        operation: 'oauth.exchange',
        ref:       { integrationId, accountId },
        url:       cfg.tokenUrl,
        method:    'POST',
        headers,
        body,
        injections,
      }));
      if (result.status < 200 || result.status >= 300 || !result.body || typeof result.body !== 'object') {
        throw new Error(`${ LOG_PREFIX } Vault-owned token exchange failed`);
      }
      return result.body as OAuthTokenSet;
    }

    if (cfg.clientAuthMethod === 'header') {
      const basic = Buffer.from(`${ clientId }:${ clientSecret }`).toString('base64');
      headers.Authorization = `Basic ${ basic }`;
    } else if (cfg.clientAuthMethod === 'none') {
      // Public client — only send client_id, no secret
      body.client_id = clientId;
    } else {
      body.client_id = clientId;
      body.client_secret = clientSecret;
    }

    const res = await fetch(cfg.tokenUrl, {
      method:  'POST',
      headers,
      body:    new URLSearchParams(body).toString(),
    });
    firstRunTrace('oauth', 'token exchange response', { integrationId, providerId: cfg.id, status: res.status, success: res.ok });

    if (!res.ok) {
      throw new Error(`${ LOG_PREFIX } Token exchange failed with status ${ res.status }`);
    }

    const json = await res.json() as OAuthTokenSet;

    return normalizeTokenExpiry(json);
  }

  // ── Refresh tokens ────────────────────────────────────────────

  async refreshAccessToken(
    integrationId: string,
    accountId: string,
    providerId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<OAuthTokenSet> {
    const custody = this.custodyResolver.resolve();
    return this.refreshAccessTokenWithCustody(custody, integrationId, accountId, providerId, clientId, clientSecret);
  }

  private async refreshAccessTokenWithCustody(
    custody: ResolvedTokenCustody,
    integrationId: string,
    accountId: string,
    providerId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<OAuthTokenSet> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`${ LOG_PREFIX } Unknown OAuth provider: ${ providerId }`);
    }
    const cfg = provider.config;

    if (custody.kind === 'vault') {
      const key = timerKey(integrationId, accountId);
      const pending = this.scheduler.inFlight.get(key);
      if (pending) return pending;
      const refresh = this.refreshInVault(custody, cfg, integrationId, accountId, providerId, clientId)
        .finally(() => this.scheduler.inFlight.delete(key));
      this.scheduler.inFlight.set(key, refresh);
      return refresh;
    }

    const stored = await custody.getRawTokens(integrationId, accountId);
    if (!stored?.refresh_token) {
      throw new Error(`${ LOG_PREFIX } No refresh token for ${ integrationId }/${ accountId }`);
    }

    const body: Record<string, string> = {
      grant_type:    'refresh_token',
      refresh_token: stored.refresh_token,
      ...cfg.extraTokenParams,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json',
    };

    if (cfg.clientAuthMethod === 'header') {
      const basic = Buffer.from(`${ clientId }:${ clientSecret }`).toString('base64');
      headers.Authorization = `Basic ${ basic }`;
    } else if (cfg.clientAuthMethod === 'none') {
      body.client_id = clientId;
    } else {
      body.client_id = clientId;
      body.client_secret = clientSecret;
    }

    const res = await fetch(cfg.tokenUrl, {
      method:  'POST',
      headers,
      body:    new URLSearchParams(body).toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${ LOG_PREFIX } Token refresh failed (${ res.status }): ${ text }`);
    }

    const json = await res.json() as OAuthTokenSet;

    // Some providers don't return a new refresh_token — keep the old one
    if (!json.refresh_token && stored.refresh_token) {
      json.refresh_token = stored.refresh_token;
    }

    normalizeTokenExpiry(json);

    await custody.store({ integrationId, accountId, providerId }, json);

    // Reschedule the next refresh
    this.scheduleRefresh(custody, integrationId, accountId, providerId, clientId, clientSecret, json);

    await provider.onTokenReceived(json, { integrationId, accountId, providerId, clientId });

    console.log(`${ LOG_PREFIX } Token refreshed for ${ integrationId }/${ accountId }`);
    return json;
  }

  /**
   * Refresh inside the vault authority. The authority injects the stored
   * refresh token, persists the rotated credentials, and returns metadata
   * only; Desktop reschedules from that metadata's expiry.
   */
  private async refreshInVault(
    custody: TokenCustody,
    cfg: OAuthProviderConfig,
    integrationId: string,
    accountId: string,
    providerId: string,
    clientId: string,
  ): Promise<OAuthTokenSet> {
    const context = await issueLocalBrokerContext({
      agentId:         'oauth-refresh',
      podId:           'desktop-main',
      credentialScope: { integration_id: integrationId, account_id: accountId },
    });
    const body: Record<string, string> = { grant_type: 'refresh_token', ...cfg.extraTokenParams };
    const refreshToken = { field: 'refresh_token', target: 'form' as const, name: 'refresh_token', scheme: 'raw' as const };
    // Public clients send their public client_id in the clear, exactly as the
    // vault-mode code exchange does. Built-in ids (Codex, Grok) are never
    // written into the vault item, so injecting `client_id` would fail.
    if (cfg.clientAuthMethod === 'none' && clientId) body.client_id = clientId;
    const injections = cfg.clientAuthMethod === 'header'
      ? [
        refreshToken,
        { field: 'client_secret', target: 'header' as const, name: 'authorization', scheme: 'BasicClient' as const },
      ]
      : cfg.clientAuthMethod === 'none'
        ? clientId
          ? [refreshToken]
          : [refreshToken, { field: 'client_id', target: 'form' as const, name: 'client_id', scheme: 'raw' as const }]
        : [
          refreshToken,
          { field: 'client_id', target: 'form' as const, name: 'client_id', scheme: 'raw' as const },
          { field: 'client_secret', target: 'form' as const, name: 'client_secret', scheme: 'raw' as const },
        ];
    const broker = requireConfiguredCredentialBroker();
    const result = await broker.execute(broker.requestFor(context, {
      operation:  'oauth.refresh',
      ref:        { integrationId, accountId },
      url:        cfg.tokenUrl,
      method:     'POST',
      headers:    { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      injections,
    }));
    if (result.status < 200 || result.status >= 300 || !result.body || typeof result.body !== 'object') {
      const reason = refreshFailureReason(result.body);
      throw new Error(`Token refresh failed: status ${ result.status }${ reason ? ` (${ reason })` : '' }`);
    }
    // The authority persisted the rotated credentials and deliberately
    // returns metadata only. Keep that boundary explicit in the legacy
    // return type until all callers consume refresh metadata directly.
    const metadata = result.body as OAuthTokenSet;
    this.scheduleRefresh(custody, integrationId, accountId, providerId, clientId, '', metadata);
    console.log(`${ LOG_PREFIX } Token refreshed in vault for ${ integrationId }/${ accountId }`);
    return metadata;
  }

  /**
   * Request-time guard for vault mode: refresh before an outbound provider
   * call when the access token is expired or inside the refresh buffer.
   * A failed refresh is retried on the usual backoff and propagated with its
   * real cause so callers do not continue with a token known to be stale.
   */
  async ensureVaultTokenFresh(integrationId: string, accountId: string): Promise<void> {
    const custody = this.custodyResolver.resolve();
    if (custody.kind !== 'vault') return;
    await this.ensureVaultTokenFreshWithCustody(custody, integrationId, accountId);
  }

  private async ensureVaultTokenFreshWithCustody(
    custody: TokenCustody,
    integrationId: string,
    accountId: string,
  ): Promise<void> {
    const cached = this.scheduler.refreshAt.get(timerKey(integrationId, accountId));
    if (cached !== undefined && Date.now() < cached) return;
    let target: VaultRefreshTarget | null = null;
    try {
      // Looks due (or unknown): confirm against the vault's current metadata
      // in case the token was already rotated by a reconnect or another call.
      target = await this.vaultRefreshTarget(custody, integrationId, accountId);
      if (!target) {
        // No OAuth session for this account (missing/never-created credential).
        // Cache the negative result so every upstream request doesn't re-query the vault.
        this.scheduler.refreshAt.set(timerKey(integrationId, accountId), Date.now() + REFRESH_RETRY_DELAY_MS);
        return;
      }
      if (Date.now() < target.refreshAt) return;
      await this.refreshAccessTokenWithCustody(custody, integrationId, accountId, target.providerId, target.clientId, '');
    } catch (err) {
      console.error(`${ LOG_PREFIX } Auto-refresh failed for ${ integrationId }/${ accountId }:`, err);
      if (target) this.scheduleRefreshRetry(custody, integrationId, accountId, target.providerId, target.clientId, '');
      else this.scheduler.refreshAt.set(timerKey(integrationId, accountId), Date.now() + REFRESH_RETRY_DELAY_MS);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`OAuth refresh failed: ${ reason }`, { cause: err });
    }
  }

  /** Force a vault refresh (after an upstream 401). Resolves true when the vault rotated the token. */
  async forceVaultRefresh(integrationId: string, accountId: string): Promise<boolean> {
    const custody = this.custodyResolver.resolve();
    if (custody.kind !== 'vault') return false;
    try {
      const target = await this.vaultRefreshTarget(custody, integrationId, accountId);
      if (!target) return false;
      await this.refreshAccessTokenWithCustody(custody, integrationId, accountId, target.providerId, target.clientId, '');
      return true;
    } catch (err) {
      console.error(`${ LOG_PREFIX } Auto-refresh failed for ${ integrationId }/${ accountId }:`, err);
      return false;
    }
  }

  /**
   * Resolve provider, public client id and next refresh time for a vault
   * account from metadata, the same way the non-vault path resolves them from
   * stored rows. Returns null for accounts that are not OAuth sessions.
   */
  private async vaultRefreshTarget(
    custody: TokenCustody,
    integrationId: string,
    accountId: string,
    fallbackProviderId?: string,
  ): Promise<VaultRefreshTarget | null> {
    const metadata = await custody.getMetadata(integrationId, accountId);
    // Only OAuth sessions carry token metadata; API-key accounts are skipped.
    if (!metadata) return null;
    let providerId = [metadata.providerId, fallbackProviderId]
      .find(candidate => !!candidate && !!getOAuthProvider(candidate));
    if (!providerId) {
      const { integrations } = await import('../integrations/catalog');
      const catalogProvider = integrations[integrationId]?.oauthProviderId;
      if (catalogProvider && getOAuthProvider(catalogProvider)) providerId = catalogProvider;
    }
    const provider = providerId ? getOAuthProvider(providerId) : undefined;
    if (!providerId || !provider) return null;
    const key = timerKey(integrationId, accountId);
    const expiresAt = metadata.expiresAt;
    const bufferMs = (provider.config.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000;
    // Unknown expiry: keep the current schedule, else allow the usual window.
    const refreshAt = expiresAt
      ? expiresAt - bufferMs
      : this.scheduler.refreshAt.get(key) ?? Date.now() + UNKNOWN_EXPIRY_REFRESH_AFTER_MS;
    this.scheduler.refreshAt.set(key, refreshAt);
    return {
      providerId,
      clientId: provider.config.builtInClientId || metadata.clientId || '',
      expiresAt,
      refreshAt,
    };
  }

  // ── Adopt tokens from another flow ────────────────────────────

  /**
   * Connect an integration with a token set that a different sign-in already
   * obtained (the OpenAI sign-in hands its ChatGPT tokens to Codex this way).
   * Runs the same tail as startFlow: provider post-processing, storage,
   * connected status, and scheduled refresh.
   */
  async adoptTokens(
    integrationId: string,
    accountId: string,
    providerId: string,
    tokens: OAuthTokenSet,
  ): Promise<void> {
    const custody = this.custodyResolver.resolve();
    if (custody.kind === 'vault') {
      throw new Error('unsupported_secret_egress: OAuth token adoption must complete inside the local vault authority');
    }
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`${ LOG_PREFIX } Unknown OAuth provider: ${ providerId }`);
    }
    const clientId = provider.config.builtInClientId || '';
    normalizeTokenExpiry(tokens);

    await provider.onTokenReceived(tokens, { integrationId, accountId, providerId, clientId });
    await custody.store({ integrationId, accountId, providerId }, tokens);

    const integrationService = getIntegrationService();
    await integrationService.setConnectionStatus(integrationId, true, accountId);
    await integrationService.setActiveAccount(integrationId, accountId);

    this.scheduleRefresh(custody, integrationId, accountId, providerId, clientId, '', tokens);
    console.log(`${ LOG_PREFIX } Adopted tokens for ${ integrationId }/${ accountId }`);
  }

  // ── Schedule proactive refresh ────────────────────────────────

  private scheduleRefresh(
    custody: ResolvedTokenCustody,
    integrationId: string,
    accountId: string,
    providerId: string,
    clientId: string,
    clientSecret: string,
    tokens: OAuthTokenSet,
  ): void {
    const key = timerKey(integrationId, accountId);

    // Clear any existing timer
    const existing = this.scheduler.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    // In vault mode Desktop never holds the refresh token; the authority does.
    if (!tokens.refresh_token && custody.kind !== 'vault') {
      return; // No refresh token — nothing to schedule
    }

    const provider = getOAuthProvider(providerId);
    const bufferMs = ((provider?.config.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000);
    const delayMs = refreshDelayMs(metadataExpiry(tokens.expires_at), bufferMs);
    if (custody.kind === 'vault') this.scheduler.refreshAt.set(key, Date.now() + delayMs);

    console.log(`${ LOG_PREFIX } Scheduling refresh for ${ integrationId }/${ accountId } in ${ Math.round(delayMs / 1000) }s`);

    const timer = setTimeout(async() => {
      try {
        await this.refreshAccessTokenWithCustody(custody, integrationId, accountId, providerId, clientId, clientSecret);
      } catch (err) {
        console.error(`${ LOG_PREFIX } Auto-refresh failed for ${ integrationId }/${ accountId }:`, err);
        this.scheduleRefreshRetry(custody, integrationId, accountId, providerId, clientId, clientSecret);
      }
    }, delayMs);

    // Don't hold the process open for the timer
    if (timer.unref) {
      timer.unref();
    }

    this.scheduler.set(key, timer);
  }

  private scheduleRefreshRetry(
    custody: ResolvedTokenCustody,
    integrationId: string,
    accountId: string,
    providerId: string,
    clientId: string,
    clientSecret: string,
  ): void {
    const key = timerKey(integrationId, accountId);
    const existing = this.scheduler.get(key);
    if (existing) clearTimeout(existing);
    // Back off exponentially so a missing/dead credential doesn't retry forever at 60s.
    const failures = (this.scheduler.retryCounts.get(key) ?? 0) + 1;
    this.scheduler.retryCounts.set(key, failures);
    const delayMs = refreshRetryDelayMs(failures);
    // Request-time checks wait for the retry instead of hammering the vault.
    if (custody.kind === 'vault') this.scheduler.refreshAt.set(key, Date.now() + delayMs);
    const retryTimer = setTimeout(async() => {
      try {
        await this.refreshAccessTokenWithCustody(custody, integrationId, accountId, providerId, clientId, clientSecret);
        this.scheduler.retryCounts.delete(key);
      } catch (err) {
        console.error(`${ LOG_PREFIX } Auto-refresh retry failed for ${ integrationId }/${ accountId }:`, err);
        this.scheduleRefreshRetry(custody, integrationId, accountId, providerId, clientId, clientSecret);
      }
    }, delayMs);

    if (retryTimer.unref) {
      retryTimer.unref();
    }
    this.scheduler.set(key, retryTimer);
  }

  // ── Revoke tokens ─────────────────────────────────────────────

  async revokeTokens(integrationId: string, accountId = 'default'): Promise<void> {
    const custody = this.custodyResolver.resolve();
    if (custody.kind === 'vault') {
      const metadata = await custody.getMetadata(integrationId, accountId);
      const provider = getOAuthProvider(metadata?.providerId || '');
      if (!provider?.config.revokeUrl) throw new Error(`${ LOG_PREFIX } OAuth provider does not expose a revoke endpoint`);
      const context = await issueLocalBrokerContext({
        agentId:         'oauth-revoke',
        podId:           'desktop-main',
        credentialScope: { integration_id: integrationId, account_id: accountId },
      });
      const broker = requireConfiguredCredentialBroker();
      await broker.execute(broker.requestFor(context, {
        operation:  'oauth.revoke',
        ref:        { integrationId, accountId },
        url:        provider.config.revokeUrl,
        method:     'POST',
        headers:    { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body:       {},
        injections: [{ field: 'access_token', target: 'form', name: 'token', scheme: 'raw' }],
      }));
      await custody.remove(integrationId, accountId);
      this.clearRefreshTimer(integrationId, accountId);
      return;
    }
    const stored = await custody.getRawTokens(integrationId, accountId);
    if (!stored) return;

    const metadata = await custody.getMetadata(integrationId, accountId);
    const provider = getOAuthProvider(metadata?.providerId || '');
    const revokeUrl = provider?.config.revokeUrl;

    if (revokeUrl && stored.access_token) {
      try {
        await fetch(revokeUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({ token: stored.access_token }).toString(),
        });
        console.log(`${ LOG_PREFIX } Token revoked at provider for ${ integrationId }/${ accountId }`);
      } catch (err) {
        console.warn(`${ LOG_PREFIX } Revocation request failed (non-fatal):`, err);
      }
    }

    // Remove from DB
    await custody.remove(integrationId, accountId);

    this.clearRefreshTimer(integrationId, accountId);

    // Mark integration as disconnected
    const integrationService = getIntegrationService();
    await integrationService.setConnectionStatus(integrationId, false, accountId);

    // Let the provider clean up credential state it materialized outside the
    // DB (e.g. CodexOAuth's ~/.codex/auth.json) so disconnect actually stops
    // authentication.
    try {
      await provider?.onTokensRevoked({
        integrationId,
        accountId,
        providerId: metadata?.providerId || '',
      });
    } catch (err) {
      console.warn(`${ LOG_PREFIX } provider onTokensRevoked failed (non-fatal):`, err);
    }

    console.log(`${ LOG_PREFIX } Tokens removed for ${ integrationId }/${ accountId }`);
  }

  private clearRefreshTimer(integrationId: string, accountId: string): void {
    const key = timerKey(integrationId, accountId);
    const timer = this.scheduler.get(key);
    if (timer) {
      clearTimeout(timer);
      this.scheduler.clearTimer(key);
    }
    this.scheduler.refreshAt.delete(key);
    this.scheduler.retryCounts.delete(key);
  }

  // ── Get a valid access token (auto-refreshes if expired) ──────

  async getAccessToken(
    integrationId: string,
    accountId = 'default',
    clientId?: string,
    clientSecret?: string,
  ): Promise<string> {
    const custody = this.custodyResolver.resolve();
    if (!isRawTokenCustody(custody)) {
      throw new Error('unsupported_secret_egress: OAuth access tokens stay inside the local vault authority');
    }
    const tokens = await this.ensureFreshTokensWithCustody(custody, integrationId, accountId, clientId, clientSecret);

    return tokens.access_token;
  }

  async ensureFreshTokens(
    integrationId: string,
    accountId = 'default',
    clientId?: string,
    clientSecret?: string,
  ): Promise<OAuthTokenSet> {
    const custody = this.custodyResolver.resolve();
    if (!isRawTokenCustody(custody)) {
      // Keep the vault copy fresh for brokered callers, but the token set
      // itself never leaves the authority.
      await this.ensureVaultTokenFreshWithCustody(custody, integrationId, accountId);
      throw new Error('unsupported_secret_egress: OAuth token sets stay inside the local vault authority');
    }
    return this.ensureFreshTokensWithCustody(custody, integrationId, accountId, clientId, clientSecret);
  }

  private async ensureFreshTokensWithCustody(
    custody: RawTokenCustody,
    integrationId: string,
    accountId: string,
    clientId?: string,
    clientSecret?: string,
  ): Promise<OAuthTokenSet> {
    const stored = await custody.getRawTokens(integrationId, accountId);
    if (!stored) {
      throw new Error(`${ LOG_PREFIX } No OAuth tokens for ${ integrationId }/${ accountId }`);
    }

    const metadata = await custody.getMetadata(integrationId, accountId);
    const providerId = metadata?.providerId || '';
    const provider = getOAuthProvider(providerId);
    const providerCfg = provider?.config;
    const bufferMs = ((providerCfg?.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000);
    const derivedExpiry = stored.expires_at ?? decodeAccessTokenExpiry(stored.access_token);
    const hasKnownExpiry = !!derivedExpiry;
    const unknownExpiryLooksStale = !hasKnownExpiry &&
      !!stored.refresh_token &&
      Date.now() - (metadata?.updatedAt ?? Date.now()) > UNKNOWN_EXPIRY_REFRESH_AFTER_MS;

    // Still valid, or no expiry is tracked and it was refreshed recently enough.
    if ((hasKnownExpiry && Date.now() < derivedExpiry - bufferMs) ||
        (!hasKnownExpiry && !unknownExpiryLooksStale)) {
      return stored;
    }

    // Need to refresh — resolve client credentials

    if (!clientId) {
      // Use built-in client_id for public clients, otherwise read from form
      if (providerCfg?.builtInClientId) {
        clientId = providerCfg.builtInClientId;
      } else {
        const integrationService = getIntegrationService();
        const cidVal = await integrationService.getIntegrationValue(integrationId, 'oauth_client_id', accountId) ||
          await integrationService.getIntegrationValue(integrationId, 'client_id', accountId);
        if (!cidVal?.value) {
          throw new Error(`${ LOG_PREFIX } Token expired and no client_id available for refresh`);
        }
        clientId = cidVal.value;
      }
    }
    if (!clientSecret && providerCfg?.clientAuthMethod !== 'none') {
      const integrationService = getIntegrationService();
      const csVal = await integrationService.getIntegrationValue(integrationId, 'client_secret', accountId);
      if (!csVal?.value) {
        throw new Error(`${ LOG_PREFIX } Token expired and no client_secret available for refresh`);
      }
      clientSecret = csVal.value;
    }

    const refreshed = await this.refreshAccessTokenWithCustody(
      custody, integrationId, accountId, providerId, clientId, clientSecret ?? '',
    );

    return refreshed;
  }

  // ── DB: Read tokens ───────────────────────────────────────────

  async getStoredTokens(integrationId: string, accountId = 'default'): Promise<OAuthTokenRow | null> {
    const custody = this.custodyResolver.resolve();
    if (!isRawTokenCustody(custody)) {
      throw new Error('unsupported_secret_egress: OAuth token records stay inside the local vault authority');
    }
    const [tokens, metadata] = await Promise.all([
      custody.getRawTokens(integrationId, accountId),
      custody.getMetadata(integrationId, accountId),
    ]);
    if (!tokens || !metadata) return null;
    return {
      integration_id: integrationId, account_id: accountId, provider_id: metadata.providerId,
      access_token: tokens.access_token, refresh_token: tokens.refresh_token || null,
      token_type: tokens.token_type || 'Bearer', scope: tokens.scope || null,
      expires_at: tokens.expires_at || null, raw_response: tokens,
      updated_at: new Date(metadata.updatedAt || Date.now()),
    };
  }

  // ── Resume refresh timers on startup ──────────────────────────

  async resumeRefreshTimers(): Promise<void> {
    const custody = this.custodyResolver.resolve();
    try {
      const accounts = await custody.listRefreshable();
      const integrationService = getIntegrationService();

      for (const account of accounts) {
        // Read client credentials — use built-in for public clients
        const provider = getOAuthProvider(account.providerId);
        const providerCfg = provider?.config;
        let cid = providerCfg?.builtInClientId || account.clientId || '';
        let cs = '';

        if (!cid) {
          const cidVal = await integrationService.getIntegrationValue(account.integrationId, 'oauth_client_id', account.accountId) ||
            await integrationService.getIntegrationValue(account.integrationId, 'client_id', account.accountId);
          cid = cidVal?.value || '';
        }
        if (custody.kind !== 'vault' && providerCfg?.clientAuthMethod !== 'none') {
          const csVal = await integrationService.getIntegrationValue(account.integrationId, 'client_secret', account.accountId);
          cs = csVal?.value || '';
        }

        if (!cid || (custody.kind !== 'vault' && providerCfg?.clientAuthMethod !== 'none' && !cs)) {
          console.warn(`${ LOG_PREFIX } Skipping refresh timer for ${ account.integrationId }/${ account.accountId } — missing client credentials`);
          continue;
        }

        this.scheduleRefresh(
          custody,
          account.integrationId,
          account.accountId,
          account.providerId,
          cid,
          cs,
          { access_token: '', refresh_token: account.refreshable ? 'custodied' : undefined, token_type: account.tokenType || 'Bearer', expires_at: account.expiresAt },
        );
      }

      console.log(`${ LOG_PREFIX } Resumed ${ accounts.length } refresh timer(s)`);
    } catch (err) {
      console.warn(`${ LOG_PREFIX } Failed to resume refresh timers (table may not exist yet):`, err);
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────

  shutdown(): void {
    this.scheduler.shutdown();
    console.log(`${ LOG_PREFIX } All refresh timers cleared`);
  }
}
