// OAuthService — Core orchestrator for OAuth 2.0 flows.
// Handles: authorize URL generation, code exchange, token storage (DB-backed),
// automatic refresh, and revocation.

import crypto from 'crypto';

import { BrowserWindow, shell } from 'electron';

import { getIntegrationService } from './IntegrationService';
import { startOAuthCallbackServer } from './OAuthCallbackServer';
import { postgresClient } from '../database/PostgresClient';
import { getOAuthProvider, type OAuthTokenSet } from '../integrations/oauth';

import type { OAuthProviderConfig } from '../integrations/oauth/OAuthProvider';

const LOG_PREFIX = '[OAuthService]';
const DEFAULT_REFRESH_BUFFER_SECONDS = 300;
const UNKNOWN_EXPIRY_REFRESH_AFTER_MS = 55 * 60 * 1000;
const REFRESH_RETRY_DELAY_MS = 60 * 1000;

// ─── DB row shape ─────────────────────────────────────────────────

interface OAuthTokenRow {
  token_id:       number;
  integration_id: string;
  account_id:     string;
  provider_id:    string;
  access_token:   string;
  refresh_token:  string | null;
  token_type:     string;
  scope:          string | null;
  expires_at:     number | null;
  raw_response:   Record<string, unknown> | null;
  created_at:     Date;
  updated_at:     Date;
}

interface DynamicClientRegistrationResponse {
  client_id?:    string;
  [key: string]: unknown;
}

// ─── Active refresh timers ────────────────────────────────────────

const refreshTimers = new Map<string, NodeJS.Timeout>();

function timerKey(integrationId: string, accountId: string): string {
  return `${ integrationId }::${ accountId }`;
}

function updatedAtMs(row: OAuthTokenRow): number {
  const value = row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime();

  return Number.isFinite(value) ? value : 0;
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
  ): Promise<OAuthTokenSet> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`${ LOG_PREFIX } Unknown OAuth provider: ${ providerId }`);
    }
    const cfg = provider.config;

    // Resolve effective client_id (built-in takes precedence for public clients).
    // Providers with registrationEndpoint can fill this after the callback
    // server starts, because DCR needs the actual redirect_uri for this flow.
    let effectiveClientId = cfg.builtInClientId || clientId;
    const effectiveClientSecret = cfg.clientAuthMethod === 'none' ? '' : clientSecret;

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

    try {
      if (!effectiveClientId && cfg.registrationEndpoint) {
        const registration = await this.registerDynamicClient(cfg, redirectUri);
        effectiveClientId = registration.clientId;
        const integrationService = getIntegrationService();
        await integrationService.setIntegrationValue({
          integration_id: integrationId,
          account_id:     accountId,
          property:       'oauth_client_id',
          value:          effectiveClientId,
        });
        console.log(`${ LOG_PREFIX } Registered OAuth client for ${ integrationId }/${ accountId }`);
      }

      if (!effectiveClientId) {
        throw new Error(`${ LOG_PREFIX } Missing client_id for OAuth provider ${ providerId }`);
      }

      // Build authorize URL
      const authorizeUrl = this.buildAuthorizeUrl(cfg, effectiveClientId, redirectUri, state, extraScopes, codeChallenge);

      if (cfg.openInEmbeddedWindow) {
        // Render the sign-in page inside Sulla Desktop rather than handing off
        // to the host's default browser. Required for providers whose tokens
        // are materialized for an in-VM consumer (e.g. Codex's
        // ~/.codex/auth.json) — an external browser would finish the handshake
        // outside Sulla and the in-VM tool would never see the credentials.
        console.log(`${ LOG_PREFIX } Opening embedded auth window for ${ cfg.name }...`);
        authWindow = this.openEmbeddedAuthWindow(authorizeUrl, cfg.name);
      } else {
        console.log(`${ LOG_PREFIX } Opening browser for authorization...`);
        await shell.openExternal(authorizeUrl);
      }

      // Wait for the user to complete authorization. The localhost callback
      // server captures the code regardless of which browser rendered the page;
      // when we own the window, also treat the user closing it as a cancel.
      const { code } = await this.awaitAuthorizationCode(codePromise, authWindow);
      console.log(`${ LOG_PREFIX } Received authorization code`);

      // Exchange code for tokens
      const tokens = normalizeTokenExpiry(
        await this.exchangeCode(cfg, effectiveClientId, effectiveClientSecret, code, redirectUri, codeVerifier),
      );
      if (cfg.registrationEndpoint) {
        tokens.oauth_client_id = effectiveClientId;
      }
      console.log(`${ LOG_PREFIX } Token exchange successful`);

      // Let the provider do post-processing
      await provider.onTokenReceived(tokens, { integrationId, accountId, providerId, clientId: effectiveClientId });

      // Persist tokens
      await this.storeTokens(integrationId, accountId, providerId, tokens);

      // Mark integration as connected
      const integrationService = getIntegrationService();
      await integrationService.setConnectionStatus(integrationId, true, accountId);

      // Schedule proactive refresh
      this.scheduleRefresh(integrationId, accountId, providerId, effectiveClientId, effectiveClientSecret, tokens);

      return tokens;
    } catch (err) {
      shutdown();
      throw err;
    } finally {
      // Always tear down the in-app window we opened — on success (after the
      // brief callback "you can close this" page) and on any error/cancel.
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.destroy();
      }
    }
  }

  // ── Embedded auth window (in-app browser) ─────────────────────

  /** Open the authorize URL in a Sulla-owned Electron window. */
  private openEmbeddedAuthWindow(url: string, providerName: string): BrowserWindow {
    const win = new BrowserWindow({
      width:           820,
      height:          720,
      title:           `Sign in — ${ providerName }`,
      autoHideMenuBar: true,
      webPreferences:  {
        nodeIntegration:  false,
        contextIsolation: true,
        sandbox:          true,
      },
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
    cfg: OAuthProviderConfig,
    redirectUri: string,
  ): Promise<{ clientId: string; response: DynamicClientRegistrationResponse }> {
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

    const json = await res.json() as DynamicClientRegistrationResponse;
    if (!json.client_id || typeof json.client_id !== 'string') {
      throw new Error(`${ LOG_PREFIX } Dynamic client registration response missing client_id`);
    }

    return { clientId: json.client_id, response: json };
  }

  // ── Exchange auth code for tokens ─────────────────────────────

  private async exchangeCode(
    cfg: OAuthProviderConfig,
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
    codeVerifier?: string,
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

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${ LOG_PREFIX } Token exchange failed (${ res.status }): ${ text }`);
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
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`${ LOG_PREFIX } Unknown OAuth provider: ${ providerId }`);
    }
    const cfg = provider.config;

    const stored = await this.getStoredTokens(integrationId, accountId);
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

    await this.storeTokens(integrationId, accountId, providerId, json);

    // Reschedule the next refresh
    this.scheduleRefresh(integrationId, accountId, providerId, clientId, clientSecret, json);

    await provider.onTokenReceived(json, { integrationId, accountId, providerId, clientId });

    console.log(`${ LOG_PREFIX } Token refreshed for ${ integrationId }/${ accountId }`);
    return json;
  }

  // ── Schedule proactive refresh ────────────────────────────────

  private scheduleRefresh(
    integrationId: string,
    accountId: string,
    providerId: string,
    clientId: string,
    clientSecret: string,
    tokens: OAuthTokenSet,
  ): void {
    const key = timerKey(integrationId, accountId);

    // Clear any existing timer
    const existing = refreshTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    if (!tokens.refresh_token) {
      return; // No refresh token — nothing to schedule
    }

    const provider = getOAuthProvider(providerId);
    const bufferMs = ((provider?.config.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000);
    const refreshAt = tokens.expires_at ? tokens.expires_at - bufferMs : Date.now() + UNKNOWN_EXPIRY_REFRESH_AFTER_MS;
    const delayMs = Math.max(refreshAt - Date.now(), 5000); // at least 5s from now

    console.log(`${ LOG_PREFIX } Scheduling refresh for ${ integrationId }/${ accountId } in ${ Math.round(delayMs / 1000) }s`);

    const timer = setTimeout(async() => {
      try {
        await this.refreshAccessToken(integrationId, accountId, providerId, clientId, clientSecret);
      } catch (err) {
        console.error(`${ LOG_PREFIX } Auto-refresh failed for ${ integrationId }/${ accountId }:`, err);
        this.scheduleRefreshRetry(integrationId, accountId, providerId, clientId, clientSecret);
      }
    }, delayMs);

    // Don't hold the process open for the timer
    if (timer.unref) {
      timer.unref();
    }

    refreshTimers.set(key, timer);
  }

  private scheduleRefreshRetry(
    integrationId: string,
    accountId: string,
    providerId: string,
    clientId: string,
    clientSecret: string,
  ): void {
    const key = timerKey(integrationId, accountId);
    const retryTimer = setTimeout(async() => {
      try {
        await this.refreshAccessToken(integrationId, accountId, providerId, clientId, clientSecret);
      } catch (err) {
        console.error(`${ LOG_PREFIX } Auto-refresh retry failed for ${ integrationId }/${ accountId }:`, err);
        this.scheduleRefreshRetry(integrationId, accountId, providerId, clientId, clientSecret);
      }
    }, REFRESH_RETRY_DELAY_MS);

    if (retryTimer.unref) {
      retryTimer.unref();
    }
    refreshTimers.set(key, retryTimer);
  }

  // ── Revoke tokens ─────────────────────────────────────────────

  async revokeTokens(integrationId: string, accountId = 'default'): Promise<void> {
    const stored = await this.getStoredTokens(integrationId, accountId);
    if (!stored) return;

    const provider = getOAuthProvider(stored.provider_id);
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
    await this.deleteStoredTokens(integrationId, accountId);

    // Clear refresh timer
    const key = timerKey(integrationId, accountId);
    const timer = refreshTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      refreshTimers.delete(key);
    }

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
        providerId: stored.provider_id,
      });
    } catch (err) {
      console.warn(`${ LOG_PREFIX } provider onTokensRevoked failed (non-fatal):`, err);
    }

    console.log(`${ LOG_PREFIX } Tokens removed for ${ integrationId }/${ accountId }`);
  }

  // ── Get a valid access token (auto-refreshes if expired) ──────

  async getAccessToken(
    integrationId: string,
    accountId = 'default',
    clientId?: string,
    clientSecret?: string,
  ): Promise<string> {
    const tokens = await this.ensureFreshTokens(integrationId, accountId, clientId, clientSecret);

    return tokens.access_token;
  }

  async ensureFreshTokens(
    integrationId: string,
    accountId = 'default',
    clientId?: string,
    clientSecret?: string,
  ): Promise<OAuthTokenSet> {
    const stored = await this.getStoredTokens(integrationId, accountId);
    if (!stored) {
      throw new Error(`${ LOG_PREFIX } No OAuth tokens for ${ integrationId }/${ accountId }`);
    }

    const provider = getOAuthProvider(stored.provider_id);
    const providerCfg = provider?.config;
    const bufferMs = ((providerCfg?.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000);
    const derivedExpiry = stored.expires_at ?? decodeAccessTokenExpiry(stored.access_token);
    const hasKnownExpiry = !!derivedExpiry;
    const unknownExpiryLooksStale = !hasKnownExpiry &&
      !!stored.refresh_token &&
      Date.now() - updatedAtMs(stored) > UNKNOWN_EXPIRY_REFRESH_AFTER_MS;

    // Still valid, or no expiry is tracked and it was refreshed recently enough.
    if ((hasKnownExpiry && Date.now() < derivedExpiry - bufferMs) ||
        (!hasKnownExpiry && !unknownExpiryLooksStale)) {
      return this.rowToTokenSet(stored);
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

    const refreshed = await this.refreshAccessToken(
      integrationId, accountId, stored.provider_id, clientId, clientSecret ?? '',
    );

    return refreshed;
  }

  // ── DB: Store tokens ──────────────────────────────────────────

  private async storeTokens(
    integrationId: string,
    accountId: string,
    providerId: string,
    tokens: OAuthTokenSet,
  ): Promise<void> {
    normalizeTokenExpiry(tokens);

    await postgresClient.query(
      `INSERT INTO oauth_tokens
         (integration_id, account_id, provider_id, access_token, refresh_token, token_type, scope, expires_at, raw_response, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
       ON CONFLICT (integration_id, account_id)
       DO UPDATE SET
         provider_id   = EXCLUDED.provider_id,
         access_token  = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
         token_type    = EXCLUDED.token_type,
         scope         = EXCLUDED.scope,
         expires_at    = EXCLUDED.expires_at,
         raw_response  = EXCLUDED.raw_response,
         updated_at    = CURRENT_TIMESTAMP`,
      [
        integrationId,
        accountId,
        providerId,
        tokens.access_token,
        tokens.refresh_token ?? null,
        tokens.token_type || 'Bearer',
        tokens.scope ?? null,
        tokens.expires_at ?? null,
        JSON.stringify(tokens),
      ],
    );

    console.log(`${ LOG_PREFIX } Tokens stored for ${ integrationId }/${ accountId }`);
  }

  // ── DB: Read tokens ───────────────────────────────────────────

  async getStoredTokens(integrationId: string, accountId = 'default'): Promise<OAuthTokenRow | null> {
    return postgresClient.queryOne<OAuthTokenRow>(
      `SELECT * FROM oauth_tokens WHERE integration_id = $1 AND account_id = $2`,
      [integrationId, accountId],
    );
  }

  private rowToTokenSet(row: OAuthTokenRow): OAuthTokenSet {
    const raw = (row.raw_response && typeof row.raw_response === 'object' && !Array.isArray(row.raw_response))
      ? row.raw_response
      : {};
    const expiresAt = row.expires_at ??
      (typeof raw.expires_at === 'number' ? raw.expires_at : undefined) ??
      decodeAccessTokenExpiry(row.access_token) ??
      undefined;

    return {
      ...raw,
      access_token:  row.access_token,
      refresh_token: row.refresh_token ?? (typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined),
      token_type:    row.token_type,
      expires_at:    expiresAt,
      scope:         row.scope ?? (typeof raw.scope === 'string' ? raw.scope : undefined),
    };
  }

  // ── DB: Delete tokens ─────────────────────────────────────────

  private async deleteStoredTokens(integrationId: string, accountId: string): Promise<void> {
    await postgresClient.query(
      `DELETE FROM oauth_tokens WHERE integration_id = $1 AND account_id = $2`,
      [integrationId, accountId],
    );
  }

  // ── Resume refresh timers on startup ──────────────────────────

  async resumeRefreshTimers(): Promise<void> {
    try {
      const rows = await postgresClient.query<OAuthTokenRow>(
        `SELECT * FROM oauth_tokens WHERE refresh_token IS NOT NULL`,
      );

      const integrationService = getIntegrationService();

      for (const row of rows) {
        // Read client credentials — use built-in for public clients
        const provider = getOAuthProvider(row.provider_id);
        const providerCfg = provider?.config;
        let cid = providerCfg?.builtInClientId || '';
        let cs = '';

        if (!cid) {
          const cidVal = await integrationService.getIntegrationValue(row.integration_id, 'oauth_client_id', row.account_id) ||
            await integrationService.getIntegrationValue(row.integration_id, 'client_id', row.account_id);
          cid = cidVal?.value || '';
        }
        if (providerCfg?.clientAuthMethod !== 'none') {
          const csVal = await integrationService.getIntegrationValue(row.integration_id, 'client_secret', row.account_id);
          cs = csVal?.value || '';
        }

        if (!cid || (providerCfg?.clientAuthMethod !== 'none' && !cs)) {
          console.warn(`${ LOG_PREFIX } Skipping refresh timer for ${ row.integration_id }/${ row.account_id } — missing client credentials`);
          continue;
        }

        this.scheduleRefresh(
          row.integration_id,
          row.account_id,
          row.provider_id,
          cid,
          cs,
          this.rowToTokenSet(row),
        );
      }

      console.log(`${ LOG_PREFIX } Resumed ${ rows.length } refresh timer(s)`);
    } catch (err) {
      console.warn(`${ LOG_PREFIX } Failed to resume refresh timers (table may not exist yet):`, err);
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────

  shutdown(): void {
    for (const [key, timer] of refreshTimers) {
      clearTimeout(timer);
    }
    refreshTimers.clear();
    console.log(`${ LOG_PREFIX } All refresh timers cleared`);
  }
}
