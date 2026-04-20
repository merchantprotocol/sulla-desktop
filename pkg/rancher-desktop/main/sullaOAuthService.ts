/**
 * Sulla Cloud OAuth client.
 *
 * Drives the generic /oauth/* flow on sulla-workers for any provider
 * (Apple today; Google, GitHub, etc. when they're added server-side).
 *
 * Flow:
 *   1. POST /oauth/start → get { authorizeUrl, state }
 *   2. Open authorizeUrl in a modal BrowserWindow
 *   3. Poll /oauth/result/:state every 1.5s until status != "pending"
 *   4. Close the window, return the result
 *
 * The worker signs the user into Sulla Cloud directly when we pass
 * returnTo: 'sulla-cloud' — the result includes a `sullaSession` which
 * the caller uses to complete the sign-in locally (vault save + relay pair).
 */

import { BrowserWindow } from 'electron';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

const API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';
const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes — matches KV TTL window

export interface OAuthSullaSession {
  userId:       string;
  accessToken:  string;
  refreshToken: string;
  contractor:   unknown;
  isNewUser:    boolean;
}

export interface OAuthRunResult {
  provider:      string;
  claims:        {
    sub:           string;
    email?:        string;
    emailVerified?: boolean;
    fullName?:     string;
  };
  tokens: {
    idToken?:     string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?:   number;
  };
  sullaSession?: OAuthSullaSession;
}

interface StartResponse {
  authorizeUrl: string;
  state:        string;
}

interface ResultResponse {
  status:   'pending' | 'done' | 'error' | 'expired';
  provider: string;
  returnTo?: string;
  result?:  OAuthRunResult;
  error?:   string;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function startFlow(provider: string, returnTo?: string): Promise<StartResponse> {
  const res = await fetch(`${ API_BASE }/oauth/start`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ provider, returnTo }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Failed to start OAuth flow (HTTP ${ res.status })`);
  }
  return res.json() as Promise<StartResponse>;
}

async function pollResult(state: string, signal: { cancelled: boolean }): Promise<OAuthRunResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.cancelled) throw new Error('user_cancelled');

    const res = await fetch(`${ API_BASE }/oauth/result/${ encodeURIComponent(state) }`);
    if (!res.ok) {
      await wait(POLL_INTERVAL_MS);
      continue;
    }
    const body = await res.json() as ResultResponse;

    if (body.status === 'done' && body.result) return body.result;
    if (body.status === 'error') throw new Error(body.error || 'OAuth flow returned error');
    if (body.status === 'expired') throw new Error('oauth_flow_expired');

    await wait(POLL_INTERVAL_MS);
  }
  throw new Error('oauth_flow_timeout');
}

/**
 * Run an end-to-end OAuth flow. Opens a modal BrowserWindow for the user
 * to sign in with the provider, then polls the worker for the result.
 */
export async function runOAuthFlow(provider: string, returnTo?: string): Promise<OAuthRunResult> {
  const { authorizeUrl, state } = await startFlow(provider, returnTo);
  console.log(`[SullaOAuth] Starting ${ provider } flow (state=${ state.slice(0, 8) }…)`);

  const signal = { cancelled: false };

  const win = new BrowserWindow({
    width:          500,
    height:         720,
    resizable:      true,
    title:          'Sign in to Sulla Cloud',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
      partition:        'persist:sulla-cloud-oauth',
    },
  });

  win.on('closed', () => { signal.cancelled = true });

  try {
    await win.loadURL(authorizeUrl);
    const result = await pollResult(state, signal);
    return result;
  } finally {
    try { if (!win.isDestroyed()) win.close() } catch { /* ignore */ }
  }
}
