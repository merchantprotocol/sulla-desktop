/**
 * OpenAI OAuth handler — opens the OAuth flow in an embedded Electron BrowserWindow.
 * Intercepts the callback to extract the authorization code, then exchanges it for tokens.
 */

import { BrowserWindow } from 'electron';

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

const LOG_PREFIX = '[OpenAIOAuth]';

/**
 * Open the OAuth URL in an Electron BrowserWindow and intercept the callback.
 */
function openAuthWindow(url: string): { window: BrowserWindow; codePromise: Promise<{ code: string; state: string } | null> } {
  const window = new BrowserWindow({
    width:          800,
    height:         600,
    title:          'Sign in with OpenAI',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
    },
  });

  const codePromise = new Promise<{ code: string; state: string } | null>((resolve) => {
    let resolved = false;
    const doResolve = (result: { code: string; state: string } | null) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const handleUrl = (targetUrl: string) => {
      try {
        const parsed = new URL(targetUrl);
        // OpenAI redirects to: http://localhost:1455/auth/callback?code=...&state=...
        if (parsed.pathname === '/auth/callback') {
          const code = parsed.searchParams.get('code');
          const state = parsed.searchParams.get('state');
          if (code && state) {
            console.log(`${ LOG_PREFIX } Intercepted callback, code received`);
            doResolve({ code, state });
          }
        }
      } catch { /* not a URL */ }
    };

    // Watch all navigation events to catch the OAuth callback
    window.webContents.on('will-redirect', (_event, u) => handleUrl(u));
    window.webContents.on('will-navigate', (_event, u) => handleUrl(u));
    window.webContents.on('did-navigate', (_event, u) => handleUrl(u));
    window.webContents.on('did-navigate-in-page', (_event, u) => handleUrl(u));

    window.on('closed', () => doResolve(null));
  });

  console.log(`${ LOG_PREFIX } Opening auth window for OpenAI OAuth`);
  window.loadURL(url);
  return { window, codePromise };
}

export function initOpenAIOAuthEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  /**
   * Start OpenAI OAuth flow.
   */
  ipcMainProxy.handle('openai-oauth:start', async(): Promise<{ success: boolean; error?: string }> => {
    try {
      const integrationService = getIntegrationService();

      // Build the authorize URL (same as OAuthService does)
      const cfg = {
        authorizeUrl: 'https://auth.openai.com/oauth/authorize',
        scopeSeparator: ' ',
      };
      const scopes = ['openid', 'profile', 'email', 'offline_access', 'model.request'];
      const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
      const redirectUri = 'http://localhost:1455/auth/callback';

      // Generate PKCE
      const crypto = await import('crypto');
      const codeVerifier = crypto.randomBytes(64).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

      // Generate state
      const state = crypto.randomBytes(24).toString('hex');

      const params = new URLSearchParams({
        response_type:                 'code',
        client_id:                     clientId,
        redirect_uri:                  redirectUri,
        scope:                         scopes.join(' '),
        state,
        code_challenge:                codeChallenge,
        code_challenge_method:         'S256',
        id_token_add_organizations:    'true',
        originator:                    'pi',
      });

      const authorizeUrl = `${ cfg.authorizeUrl }?${ params.toString() }`;

      // Open the OAuth window
      const { window, codePromise } = openAuthWindow(authorizeUrl);

      // Wait for the callback
      const result = await Promise.race([
        codePromise,
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('OAuth timeout')), 300_000)),
      ]);

      if (!result) {
        window.destroy();
        return { success: false, error: 'User cancelled OAuth' };
      }

      const { code } = result;

      // Exchange code for tokens
      const body = new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        code_verifier: codeVerifier,
      });

      const tokenRes = await fetch('https://auth.openai.com/oauth/token', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept:         'application/json',
          'User-Agent':   'Sulla-Desktop/1.0',
        },
        body: body.toString(),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '');
        throw new Error(`Token exchange failed: ${ tokenRes.status } ${ text }`);
      }

      const tokens = await tokenRes.json() as any;
      window.destroy();

      // Store the tokens (don't store in oauth_tokens table, store the access_token as api_key)
      const accountId = 'oauth';
      const apiKey = tokens.access_token;
      if (!apiKey) {
        throw new Error('No access_token in OAuth response');
      }

      // Store the API key so OpenAIService.create() can use it
      await integrationService.setIntegrationValue({
        integration_id: 'openai',
        account_id:     accountId,
        property:       'api_key',
        value:          apiKey,
      });

      await integrationService.setConnectionStatus('openai', true, accountId);

      // Bust the LLM service cache so the next call re-reads the new API key
      try {
        const { resetOpenAIService } = await import('@pkg/agent/languagemodels/OpenAIService');
        resetOpenAIService();
      } catch { /* non-critical */ }

      console.log(`${ LOG_PREFIX } OAuth successful, tokens stored`);
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`${ LOG_PREFIX } OAuth failed:`, errMsg);
      return { success: false, error: errMsg };
    }
  });
}
