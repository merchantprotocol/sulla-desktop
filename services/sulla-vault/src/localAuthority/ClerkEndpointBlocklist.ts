// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Canonical security refusals shared by the Desktop preflight and the Vault egress choke point. */
export class ClerkEndpointBlocklist {
  /**
   * Credential-route inventory from the Clerk Backend API families:
   * /api_keys (create/list/retrieve) and /api_keys/:id/secret; /machines (create/list/update and
   * all nested token/secret routes, including /machines/:id/secret_key[/rotate]); /m2m_tokens
   * (list/create/revoke); and
   * /users/:id/oauth_access_tokens/:provider. SessionApi also returns minted credentials from
   * /sessions/:id/tokens[/template] and /sessions/:id/refresh. The broader instance/config
   * families below are blocked as well. These checks intentionally ignore HTTP method and key
   * environment because reads can return credentials and test slots can contain live keys.
   */
  refusal(pathInput: string): string | undefined {
    const path = this.canonicalPath(pathInput);
    if (!path) return undefined;

    if (this.route(path, '/v1/api_keys')) return this.message('api_keys');
    if (this.route(path, '/v1/machines')) return this.message('machines');
    if (this.route(path, '/v1/m2m_tokens')) return this.message('m2m_tokens');
    if (this.userOAuthAccessTokens(path)) return this.message('oauth_access_tokens');
    if (this.route(path, '/v1/sign_in_tokens')) return this.message('sign_in_tokens');
    if (this.route(path, '/v1/actor_tokens')) return this.message('actor_tokens');
    if (this.sessionTokens(path)) return this.message('sessions/*/tokens');
    if (this.sessionRefresh(path)) return this.message('sessions/*/refresh');
    if (path.startsWith('/v1/instance')) return this.message('instance');
    if (this.route(path, '/v1/jwt_templates')) return this.message('jwt_templates');
    if (this.route(path, '/v1/webhooks') || this.route(path, '/v1/webhook_endpoints') || this.route(path, '/v1/svix')) {
      return this.message('webhooks');
    }
    if (this.route(path, '/v1/oauth_applications')) return this.message('oauth_applications');
    if (this.route(path, '/v1/saml_connections')) return this.message('saml_connections');
    if (this.route(path, '/v1/testing_tokens')) return this.message('testing_tokens');
    return undefined;
  }

  private canonicalPath(input: string): string | undefined {
    if (typeof input !== 'string' || input.length > 8192) return undefined;
    let decoded = input.split(/[?#]/, 1)[0];
    for (let pass = 0; pass < 4; pass++) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    const collapsed = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    try {
      // URL applies the same dot-segment normalization the eventual HTTPS request uses.
      return new URL(`https://clerk.invalid${ collapsed.startsWith('/') ? collapsed : `/${ collapsed }` }`).pathname.toLowerCase();
    } catch {
      return collapsed.toLowerCase();
    }
  }

  private route(path: string, route: string): boolean {
    return path === route || path.startsWith(`${ route }/`);
  }

  private sessionTokens(path: string): boolean {
    const segments = path.split('/').filter(Boolean);
    return segments[0] === 'v1' && segments[1] === 'sessions' && segments.length >= 4 && segments[3] === 'tokens';
  }

  private sessionRefresh(path: string): boolean {
    const segments = path.split('/').filter(Boolean);
    return segments[0] === 'v1' && segments[1] === 'sessions' && segments.length >= 4 && segments[3] === 'refresh';
  }

  private userOAuthAccessTokens(path: string): boolean {
    const segments = path.split('/').filter(Boolean);
    return segments[0] === 'v1' && segments[1] === 'users' && segments.length >= 4 && segments[3] === 'oauth_access_tokens';
  }

  private message(endpoint: string): string {
    return `Clerk endpoint ${ endpoint } is blocked for security; this request was not sent.`;
  }
}
