// OAuthService — Core orchestrator for OAuth 2.0 flows.
// Handles: authorize URL generation, code exchange, token storage (DB-backed),
// automatic refresh, and revocation.

import crypto from 'crypto';
import { shell } from 'electron';
import { postgresClient } from '../database/PostgresClient';
import { getOAuthProvider, type OAuthTokenSet } from '../integrations/oauth';
import type { OAuthProviderConfig } from '../integrations/oauth/OAuthProvider';
import { startOAuthCallbackServer } from './OAuthCallbackServer';
import { getIntegrationService } from './IntegrationService';

const LOG_PREFIX = '[OAuthService]';

// ─── DB row shape ─────────────────────────────────────────────────

interface OAuthTokenRow {
  token_id: number;
  integration_id: string;
  account_id: string;
  provider_id: string;
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  scope: string | null;
  expires_at: number | null;
  raw_response: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

// ─── Active refresh timers ────────────────────────────────────────

const refreshTimers = new Map<string, NodeJS.Timeout>();

function timerKey(integrationId: string, accountId: string): string {
  return `${ integrationId }::${ accountId }`;
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

    // Resolve effective client_id (built-in takes precedence for public clients)
    const effectiveClientId = cfg.builtInClientId || clientId;
    const effectiveClientSecret = cfg.clientAuthMethod === 'none' ? '' : clientSecret;

    // Generate CSRF state
    const state = crypto.randomBytes(24).toString('hex');

    // Generate PKCE verifier/challenge if required
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (cfg.usePKCE) {
      codeVerifier = crypto.randomBytes(32).toString('base64url');
      codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    }

    // Start callback server (with optional fixed port/path)
    const { redirectUri, codePromise, shutdown } = startOAuthCallbackServer({
      expectedState: state,
      fixedPort:     cfg.fixedCallbackPort,
      callbackPath:  cfg.fixedCallbackPath,
      useLocalhostHostname: !!cfg.fixedCallbackPort,
    });
    console.log(`${ LOG_PREFIX } Callback server listening at ${ redirectUri }`);

    try {
      // Build authorize URL
      const authorizeUrl = this.buildAuthorizeUrl(cfg, effectiveClientId, redirectUri, state, extraScopes, codeChallenge);
      console.log(`${ LOG_PREFIX } Opening browser for authorization...`);

      // Open in user's default browser
      await shell.openExternal(authorizeUrl);

      // Wait for the user to complete authorization
      const { code } = await codePromise;
      console.log(`${ LOG_PREFIX } Received authorization code`);

      // Exchange code for tokens
      const tokens = await this.exchangeCode(cfg, effectiveClientId, effectiveClientSecret, code, redirectUri, codeVerifier);
      console.log(`${ LOG_PREFIX } Token exchange successful`);

      // Let the provider do post-processing
      await provider.onTokenReceived(tokens);

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
    }
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

    // Compute absolute expiry
    if (json.expires_in && !json.expires_at) {
      json.expires_at = Date.now() + json.expires_in * 1000;
    }

    return json;
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

    if (json.expires_in && !json.expires_at) {
      json.expires_at = Date.now() + json.expires_in * 1000;
    }

    await provider.onTokenReceived(json);
    await this.storeTokens(integrationId, accountId, providerId, json);

    // Reschedule the next refresh
    this.scheduleRefresh(integrationId, accountId, providerId, clientId, clientSecret, json);

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

    if (!tokens.expires_at || !tokens.refresh_token) {
      return; // No expiry or no refresh_token — nothing to schedule
    }

    const provider = getOAuthProvider(providerId);
    const bufferMs = ((provider?.config.refreshBufferSeconds ?? 300) * 1000);
    const refreshAt = tokens.expires_at - bufferMs;
    const delayMs = Math.max(refreshAt - Date.now(), 5000); // at least 5s from now

    console.log(`${ LOG_PREFIX } Scheduling refresh for ${ integrationId }/${ accountId } in ${ Math.round(delayMs / 1000) }s`);

    const timer = setTimeout(async () => {
      try {
        await this.refreshAccessToken(integrationId, accountId, providerId, clientId, clientSecret);
      } catch (err) {
        console.error(`${ LOG_PREFIX } Auto-refresh failed for ${ integrationId }/${ accountId }:`, err);
      }
    }, delayMs);

    // Don't hold the process open for the timer
    if (timer.unref) {
      timer.unref();
    }

    refreshTimers.set(key, timer);
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
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: stored.access_token }).toString(),
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

    console.log(`${ LOG_PREFIX } Tokens removed for ${ integrationId }/${ accountId }`);
  }

  // ── Get a valid access token (auto-refreshes if expired) ──────

  async getAccessToken(
    integrationId: string,
    accountId = 'default',
    clientId?: string,
    clientSecret?: string,
  ): Promise<string> {
    const stored = await this.getStoredTokens(integrationId, accountId);
    if (!stored) {
      throw new Error(`${ LOG_PREFIX } No OAuth tokens for ${ integrationId }/${ accountId }`);
    }

    // If no expiry tracked, return as-is
    if (!stored.expires_at) {
      return stored.access_token;
    }

    const provider = getOAuthProvider(stored.provider_id);
    const providerCfg = provider?.config;
    const bufferMs = ((providerCfg?.refreshBufferSeconds ?? 300) * 1000);

    // Still valid?
    if (Date.now() < stored.expires_at - bufferMs) {
      return stored.access_token;
    }

    // Need to refresh — resolve client credentials

    if (!clientId) {
      // Use built-in client_id for public clients, otherwise read from form
      if (providerCfg?.builtInClientId) {
        clientId = providerCfg.builtInClientId;
      } else {
        const integrationService = getIntegrationService();
        const cidVal = await integrationService.getIntegrationValue(integrationId, 'client_id', accountId);
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
      integrationId, accountId, stored.provider_id, clientId!, clientSecret ?? '',
    );

    return refreshed.access_token;
  }

  // ── DB: Store tokens ──────────────────────────────────────────

  private async storeTokens(
    integrationId: string,
    accountId: string,
    providerId: string,
    tokens: OAuthTokenSet,
  ): Promise<void> {
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
        `SELECT * FROM oauth_tokens WHERE refresh_token IS NOT NULL AND expires_at IS NOT NULL`,
      );

      const integrationService = getIntegrationService();

      for (const row of rows) {
        // Read client credentials — use built-in for public clients
        const provider = getOAuthProvider(row.provider_id);
        const providerCfg = provider?.config;
        let cid = providerCfg?.builtInClientId || '';
        let cs = '';

        if (!cid) {
          const cidVal = await integrationService.getIntegrationValue(row.integration_id, 'client_id', row.account_id);
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

        const tokens: OAuthTokenSet = {
          access_token:  row.access_token,
          refresh_token: row.refresh_token ?? undefined,
          token_type:    row.token_type,
          expires_at:    row.expires_at ?? undefined,
          scope:         row.scope ?? undefined,
        };

        this.scheduleRefresh(
          row.integration_id,
          row.account_id,
          row.provider_id,
          cid,
          cs,
          tokens,
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
