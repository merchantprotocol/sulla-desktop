// OAuthProvider — Abstract base class defining an OAuth provider's configuration.
// Each concrete provider specifies its endpoints, scopes, and token handling behavior.

export interface OAuthTokenSet {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  /** Absolute epoch-ms when access_token expires (computed at storage time) */
  expires_at?: number;
  scope?: string;
  /** Any extra fields the provider returns (e.g. id_token) */
  [key: string]: unknown;
}

export interface OAuthProviderConfig {
  /** Unique ID matching Integration.oauthProviderId */
  id: string;
  /** Human-readable name shown in UI */
  name: string;
  /** OAuth 2.0 authorization endpoint (browser redirect) */
  authorizeUrl: string;
  /** OAuth 2.0 token endpoint (server-to-server) */
  tokenUrl: string;
  /** OAuth 2.0 revocation endpoint (optional) */
  revokeUrl?: string;
  /** Default scopes requested during authorization */
  scopes: string[];
  /** Scope separator — defaults to ' ' (space) */
  scopeSeparator?: string;
  /**
   * How client credentials are sent to the token endpoint:
   * - 'body' (default): client_id + client_secret in POST body
   * - 'header': HTTP Basic auth header
   * - 'none': public client (no client_secret sent)
   */
  clientAuthMethod?: 'body' | 'header' | 'none';
  /**
   * Additional query parameters appended to the authorize URL.
   * Useful for provider-specific params like `access_type=offline` (Google).
   */
  extraAuthorizeParams?: Record<string, string>;
  /**
   * Additional body parameters sent with the token exchange request.
   */
  extraTokenParams?: Record<string, string>;
  /**
   * Number of seconds before actual expiry to proactively refresh the token.
   * Defaults to 300 (5 minutes).
   */
  refreshBufferSeconds?: number;
  /**
   * If true, use PKCE (S256 code_challenge) in the authorization flow.
   * Required for public clients that don't use a client_secret.
   */
  usePKCE?: boolean;
  /**
   * Built-in client_id for public OAuth apps (e.g. OpenAI Codex CLI).
   * When set, the user does NOT need to supply their own client_id/secret.
   */
  builtInClientId?: string;
  /**
   * Fixed port the callback server must listen on.
   * Required when the provider's OAuth app has a hardcoded redirect_uri.
   */
  fixedCallbackPort?: number;
  /**
   * Fixed path for the callback URL (e.g. '/auth/callback').
   * Defaults to '/oauth/callback' if not specified.
   */
  fixedCallbackPath?: string;
}

/**
 * Abstract base class for OAuth providers.
 * Subclasses only need to supply `config` — all the heavy lifting
 * (authorize URL building, token exchange, refresh) lives in OAuthService.
 */
export abstract class OAuthProvider {
  abstract readonly config: OAuthProviderConfig;

  /** Override to post-process token responses (e.g. extract user info) */
  async onTokenReceived(_tokens: OAuthTokenSet): Promise<void> {}

  /** Override to add per-request headers when calling the provider's API */
  buildAuthHeader(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${ accessToken }` };
  }
}
