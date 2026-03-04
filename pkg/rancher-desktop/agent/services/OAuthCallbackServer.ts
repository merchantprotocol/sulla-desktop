// OAuthCallbackServer — Ephemeral localhost HTTP server that captures the OAuth redirect.
// Spins up on a random available port, waits for the provider to redirect with ?code=...,
// then resolves the promise and shuts down.

import http from 'http';
import { URL } from 'url';

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Authorization Successful</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         display: flex; align-items: center; justify-content: center; height: 100vh;
         margin: 0; background: #f8fafc; color: #0f172a; }
  .card { text-align: center; padding: 3rem; border-radius: 1rem;
          background: white; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p  { color: #64748b; margin-top: 0; }
</style></head>
<body><div class="card">
  <h1>Authorization Successful</h1>
  <p>You can close this tab and return to the application.</p>
</div></body></html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html><head><title>Authorization Failed</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         display: flex; align-items: center; justify-content: center; height: 100vh;
         margin: 0; background: #fef2f2; color: #991b1b; }
  .card { text-align: center; padding: 3rem; border-radius: 1rem;
          background: white; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p  { color: #64748b; margin-top: 0; }
</style></head>
<body><div class="card">
  <h1>Authorization Failed</h1>
  <p>${ msg }</p>
</div></body></html>`;

export interface OAuthCallbackServerOptions {
  /** The `state` value we sent in the authorize URL — used to validate the callback. */
  expectedState: string;
  /** How long to wait before rejecting (default 5 min). */
  timeoutMs?: number;
  /** Fixed port to listen on (default: random available port). */
  fixedPort?: number;
  /** Path to match for the callback (default: '/oauth/callback'). */
  callbackPath?: string;
  /** Use 'localhost' instead of '127.0.0.1' in the redirect URI (some providers require this). */
  useLocalhostHostname?: boolean;
}

/**
 * Start an ephemeral localhost HTTP server that waits for a single OAuth callback.
 *
 * @returns The redirect_uri the server is listening on, plus a promise that resolves with the auth code.
 */
export function startOAuthCallbackServer(
  optionsOrState: string | OAuthCallbackServerOptions,
  timeoutMs = 300_000,
): { redirectUri: string; codePromise: Promise<OAuthCallbackResult>; shutdown: () => void } {
  // Support legacy call signature: startOAuthCallbackServer(state, timeoutMs)
  const opts: OAuthCallbackServerOptions = typeof optionsOrState === 'string'
    ? { expectedState: optionsOrState, timeoutMs }
    : optionsOrState;

  const expectedState = opts.expectedState;
  const timeout_ms = opts.timeoutMs ?? timeoutMs;
  const callbackPath = opts.callbackPath ?? '/oauth/callback';
  const listenPort = opts.fixedPort ?? 0;
  const hostname = opts.useLocalhostHostname ? 'localhost' : '127.0.0.1';

  let resolveFn: (result: OAuthCallbackResult) => void;
  let rejectFn: (err: Error) => void;

  const codePromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML('No URL provided.'));
      return;
    }

    const parsed = new URL(req.url, `http://127.0.0.1`);

    // Only handle the configured callback path
    if (parsed.pathname !== callbackPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const error = parsed.searchParams.get('error');
    if (error) {
      const desc = parsed.searchParams.get('error_description') || error;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML(desc));
      rejectFn(new Error(`OAuth error: ${ desc }`));
      cleanup();
      return;
    }

    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML('Missing authorization code.'));
      return;
    }

    if (state !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML('State mismatch — possible CSRF attack.'));
      rejectFn(new Error('OAuth state mismatch'));
      cleanup();
      return;
    }

    // Success
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(SUCCESS_HTML);
    resolveFn({ code, state });
    cleanup();
  });

  // Listen on the configured port (0 = random) on loopback
  server.listen(listenPort, '127.0.0.1');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const redirectUri = `http://${ hostname }:${ port }${ callbackPath }`;

  const timeoutHandle = setTimeout(() => {
    rejectFn(new Error('OAuth callback timed out'));
    cleanup();
  }, timeout_ms);

  function cleanup() {
    clearTimeout(timeoutHandle);
    try {
      server.close();
    } catch { /* already closed */ }
  }

  const shutdown = () => {
    rejectFn(new Error('OAuth flow cancelled'));
    cleanup();
  };

  return { redirectUri, codePromise, shutdown };
}
