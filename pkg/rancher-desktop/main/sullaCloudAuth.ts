/**
 * Sulla Cloud authentication handler.
 *
 * Signs in to the same sulla-workers account used by Sulla Mobile. Session
 * tokens + profile data are stored as an IntegrationService account under
 * integration_id="sulla-cloud", which means they're vault-encrypted at rest
 * alongside every other integration's credentials.
 *
 * User vs contractor:
 *   - `userId` is the stable identity we use to pair with the mobile app
 *     over the DesktopRelay. It does not change when the user switches
 *     businesses.
 *   - `activeContractorId` is the business currently selected. One user may
 *     belong to multiple contractors (future — today the server returns only
 *     a single contractor, so `userId === activeContractorId`).
 *
 * Three sign-in methods feed the same storage:
 *   - Phone OTP ............... sulla-cloud:send-otp / verify-otp
 *   - Email + password ........ sulla-cloud:email-login / email-register
 *   - Sign in with Apple ...... sulla-cloud:apple-sign-in (takes identity token)
 */

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

import { getDesktopRelayClient } from './desktopRelay';
import { DevicesCloudApi } from './devicesCloudApi';
import { runOAuthFlow } from './sullaOAuthService';

const console = Logging.background;

const API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';
const INTEGRATION_ID = 'sulla-cloud';

// Legacy setting keys — cleared on first migration pass.
const LEGACY_ENCRYPTED_TOKENS = 'sullaCloudTokensEncrypted';
const LEGACY_USER_ID = 'sullaCloudUserId';
const LEGACY_PHONE = 'sullaCloudPhone';

interface StoredTokens {
  accessToken:  string;
  refreshToken: string;
}

interface CloudContractor {
  id:           string;
  phone:        string;
  businessName: string | null;
  name:         string | null;
  email:        string | null;
}

/**
 * Normalized sign-in result. Maps both today's `contractor`-only server response
 * and the future `{userId, contractors[]}` response into the same shape.
 */
interface CloudSession {
  userId:             string;            // Stable identity — used for relay pairing
  activeContractorId: string;            // Currently selected business
  contractors:        CloudContractor[]; // All businesses this user can access (today: 1)
  tokens:             StoredTokens;
}

interface AuthStatus {
  signedIn:           boolean;
  userId:             string;
  activeContractorId: string;
  phone:              string;
  name:               string;
  contractorCount:    number;
  lastError?:         string;
}

interface AuthResult {
  ok:         boolean;
  error?:     string;
  status:     AuthStatus;
}

// ── Session storage (IntegrationService, vault-encrypted) ──────

async function saveSession(session: CloudSession): Promise<void> {
  const svc = getIntegrationService();
  const accountId = session.userId;

  await svc.setMultipleValues([
    { integration_id: INTEGRATION_ID, account_id: accountId, property: 'access_token', value: session.tokens.accessToken },
    { integration_id: INTEGRATION_ID, account_id: accountId, property: 'refresh_token', value: session.tokens.refreshToken },
    { integration_id: INTEGRATION_ID, account_id: accountId, property: 'user_id', value: session.userId },
    { integration_id: INTEGRATION_ID, account_id: accountId, property: 'active_contractor_id', value: session.activeContractorId },
    { integration_id: INTEGRATION_ID, account_id: accountId, property: 'contractors_json', value: JSON.stringify(session.contractors) },
  ]);
  await svc.setConnectionStatus(INTEGRATION_ID, true, accountId);

  // Clear any legacy settings left over from the safeStorage era.
  await clearLegacySettings();

  // Register this desktop with the cloud so mobile's AI Assistant settings
  // screen sees it as a pairing target, and start the heartbeat so it shows
  // as online while this process runs.
  void DevicesCloudApi.register().then(() => DevicesCloudApi.startHeartbeat());
}

async function loadSession(): Promise<CloudSession | null> {
  const svc = getIntegrationService();
  const accounts = await svc.getAccounts(INTEGRATION_ID);
  if (accounts.length === 0) return null;

  // We only ever have one signed-in user account; use the first (active) one.
  const accountId = accounts.find(a => a.active)?.account_id ?? accounts[0].account_id;

  const [accessTokenV, refreshTokenV, userIdV, activeContractorIdV, contractorsJsonV] = await Promise.all([
    svc.getIntegrationValue(INTEGRATION_ID, 'access_token', accountId),
    svc.getIntegrationValue(INTEGRATION_ID, 'refresh_token', accountId),
    svc.getIntegrationValue(INTEGRATION_ID, 'user_id', accountId),
    svc.getIntegrationValue(INTEGRATION_ID, 'active_contractor_id', accountId),
    svc.getIntegrationValue(INTEGRATION_ID, 'contractors_json', accountId),
  ]);

  if (!accessTokenV?.value || !userIdV?.value) return null;

  let contractors: CloudContractor[] = [];
  try {
    contractors = contractorsJsonV?.value ? JSON.parse(contractorsJsonV.value) as CloudContractor[] : [];
  } catch {
    contractors = [];
  }

  return {
    userId:             userIdV.value,
    activeContractorId: activeContractorIdV?.value || userIdV.value,
    contractors,
    tokens:             {
      accessToken:  accessTokenV.value,
      refreshToken: refreshTokenV?.value ?? '',
    },
  };
}

async function clearSession(): Promise<void> {
  const svc = getIntegrationService();
  const accounts = await svc.getAccounts(INTEGRATION_ID);
  for (const acc of accounts) {
    await svc.deleteAccount(INTEGRATION_ID, acc.account_id);
  }
  await clearLegacySettings();
}

async function clearLegacySettings(): Promise<void> {
  try {
    await SullaSettingsModel.delete(LEGACY_ENCRYPTED_TOKENS);
    await SullaSettingsModel.delete(LEGACY_USER_ID);
    await SullaSettingsModel.delete(LEGACY_PHONE);
  } catch { /* ignore */ }
}

// ── Status ──────────────────────────────────────────────────

function findActiveContractor(session: CloudSession): CloudContractor | null {
  return session.contractors.find(c => c.id === session.activeContractorId)
    ?? session.contractors[0]
    ?? null;
}

async function buildStatus(lastError?: string): Promise<AuthStatus> {
  const session = await loadSession();
  if (!session) {
    return { signedIn: false, userId: '', activeContractorId: '', phone: '', name: '', contractorCount: 0, lastError };
  }
  const active = findActiveContractor(session);
  return {
    signedIn:           true,
    userId:             session.userId,
    activeContractorId: session.activeContractorId,
    phone:              active?.phone ?? '',
    name:               active?.name ?? '',
    contractorCount:    session.contractors.length,
    lastError,
  };
}

// ── Server calls ────────────────────────────────────────────

async function sendOtp(phone: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${ API_BASE }/auth/otp/send`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ phone }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: body.error || `HTTP ${ res.status }` };
  }
  return { ok: true };
}

interface VerifyResponse {
  contractor:    CloudContractor;
  accessToken:   string;
  refreshToken:  string;
  /** Reserved for future multi-contractor support. Today the server does not
   * return a distinct userId — we alias to contractor.id. */
  userId?:       string;
  /** Reserved for future multi-contractor support. Today the server returns a
   * single `contractor` field which we wrap into this list. */
  contractors?:  CloudContractor[];
}

function responseToSession(data: VerifyResponse): CloudSession {
  const contractors = data.contractors?.length ? data.contractors : [data.contractor];
  return {
    userId:             data.userId ?? data.contractor.id,
    activeContractorId: data.contractor.id,
    contractors,
    tokens:             {
      accessToken:  data.accessToken,
      refreshToken: data.refreshToken,
    },
  };
}

async function verifyOtp(phone: string, code: string): Promise<{ ok: boolean; error?: string; data?: VerifyResponse }> {
  const res = await fetch(`${ API_BASE }/auth/otp/verify`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ phone, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: body.error || `HTTP ${ res.status }` };
  }
  const data = await res.json() as VerifyResponse;
  return { ok: true, data };
}

async function emailLogin(email: string, password: string): Promise<{ ok: boolean; error?: string; data?: VerifyResponse }> {
  const res = await fetch(`${ API_BASE }/auth/email/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: body.error || `HTTP ${ res.status }` };
  }
  const data = await res.json() as VerifyResponse;
  return { ok: true, data };
}

async function emailRegister(email: string, password: string, name?: string): Promise<{ ok: boolean; error?: string; data?: VerifyResponse }> {
  const res = await fetch(`${ API_BASE }/auth/email/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password, name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: body.error || `HTTP ${ res.status }` };
  }
  const data = await res.json() as VerifyResponse;
  return { ok: true, data };
}

async function appleSignIn(identityToken: string, fullName?: string, email?: string): Promise<{ ok: boolean; error?: string; data?: VerifyResponse }> {
  const res = await fetch(`${ API_BASE }/auth/apple`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ identityToken, fullName, email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: body.error || `HTTP ${ res.status }` };
  }
  const data = await res.json() as VerifyResponse;
  return { ok: true, data };
}

// ── Public helpers ─────────────────────────────────────────

/**
 * Parse the `exp` claim from a JWT without verifying its signature. We only
 * need the timestamp locally to decide whether to refresh. Returns 0 if
 * the token is malformed — callers treat that as "expired, refresh".
 */
function readJwtExpSeconds(jwt: string): number {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return 0;
    const payloadJson = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const payload = JSON.parse(payloadJson) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/**
 * Exchange the stored refresh token for a new access token. On success, the
 * session's accessToken (and refreshToken, if rotated) are written back to
 * storage. Returns the new access token, or empty string on failure — the
 * caller should surface a re-auth prompt at that point.
 */
async function refreshAccessToken(): Promise<string> {
  const session = await loadSession();
  if (!session?.tokens.refreshToken) return '';

  try {
    const res = await fetch(`${ API_BASE }/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refreshToken: session.tokens.refreshToken }),
    });
    if (!res.ok) {
      console.warn(`[sullaCloudAuth] Refresh failed: HTTP ${ res.status }`);
      return '';
    }
    const data = await res.json() as { accessToken: string; refreshToken?: string };
    const refreshed: CloudSession = {
      ...session,
      tokens: {
        accessToken:  data.accessToken,
        refreshToken: data.refreshToken ?? session.tokens.refreshToken,
      },
    };
    await saveSession(refreshed);
    return data.accessToken;
  } catch (err: any) {
    console.warn('[sullaCloudAuth] Refresh error:', err?.message || err);
    return '';
  }
}

/**
 * Returns the currently-signed-in access token, or empty string if not
 * signed in. Automatically refreshes the token when it is within 60s of
 * expiry (or already expired), so callers never need to handle 401s.
 *
 * Used by subsystems that need to call authenticated Sulla backend
 * endpoints (e.g. the relay WebSocket) without going through IPC.
 */
export async function getCurrentAccessToken(): Promise<string> {
  const session = await loadSession();
  const current = session?.tokens.accessToken ?? '';
  if (!current) return '';

  const exp = readJwtExpSeconds(current);
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp === 0 || exp - nowSec <= 60) {
    const refreshed = await refreshAccessToken();
    return refreshed || current;
  }
  return current;
}

/**
 * Returns the active contractor id for the signed-in user, or an empty
 * string if not signed in. One user may own multiple contractors; this
 * reflects whichever they've selected in the UI. Used by the sync layer
 * as a fallback when an inbound payload doesn't embed contractor_id.
 */
export async function getActiveContractorId(): Promise<string> {
  const session = await loadSession();
  return session?.activeContractorId ?? '';
}

/**
 * Returns the signed-in user id (stable across contractor switches),
 * or an empty string if not signed in.
 */
export async function getCurrentUserId(): Promise<string> {
  const session = await loadSession();
  return session?.userId ?? '';
}

// ── IPC handlers ───────────────────────────────────────────

export function initSullaCloudAuthEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  ipcMainProxy.handle('sulla-cloud:get-status', async(): Promise<AuthStatus> => {
    return buildStatus();
  });

  ipcMainProxy.handle('sulla-cloud:send-otp', async(_event: unknown, phone: string): Promise<AuthResult> => {
    const normalized = phone.trim();
    if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
      return {
        ok:     false,
        error:  'Invalid phone format. Use E.164, e.g. +15551234567.',
        status: await buildStatus(),
      };
    }
    const result = await sendOtp(normalized);
    if (!result.ok) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    return { ok: true, status: await buildStatus() };
  });

  // Shared success path: persist session, auto-pair relay, return status.
  const completeSignIn = async(data: VerifyResponse): Promise<AuthResult> => {
    const session = responseToSession(data);
    await saveSession(session);
    try {
      // Relay room is the stable userId, not the active contractor — so
      // switching businesses later doesn't drop the mobile connection.
      await getDesktopRelayClient().setPairedUserId(session.userId);
    } catch (err) {
      console.warn('[SullaCloudAuth] Auto-pair failed:', err);
    }
    try {
      // Start the offline-friendly sync loop so claude_messages sent from
      // mobile while the WS relay is down still get processed on desktop.
      const { SullaSync } = await import('./sync/SullaSyncService');
      SullaSync.start();
    } catch (err) {
      console.warn('[SullaCloudAuth] Failed to start SullaSync:', err);
    }
    console.log(`[SullaCloudAuth] Signed in — user=${ session.userId }, active contractor=${ session.activeContractorId }`);
    return { ok: true, status: await buildStatus() };
  };

  ipcMainProxy.handle('sulla-cloud:verify-otp', async(_event: unknown, phone: string, code: string): Promise<AuthResult> => {
    const normalizedPhone = phone.trim();
    const normalizedCode = code.trim();
    if (!normalizedPhone || !/^\d{4,8}$/.test(normalizedCode)) {
      return {
        ok:     false,
        error:  'Enter the code from your text message.',
        status: await buildStatus(),
      };
    }

    const result = await verifyOtp(normalizedPhone, normalizedCode);
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    return completeSignIn(result.data);
  });

  ipcMainProxy.handle('sulla-cloud:email-login', async(_event: unknown, email: string, password: string): Promise<AuthResult> => {
    const e = email.trim().toLowerCase();
    if (!e || !password) {
      return { ok: false, error: 'Email and password are required.', status: await buildStatus() };
    }
    const result = await emailLogin(e, password);
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    return completeSignIn(result.data);
  });

  ipcMainProxy.handle('sulla-cloud:email-register', async(_event: unknown, email: string, password: string, name?: string): Promise<AuthResult> => {
    const e = email.trim().toLowerCase();
    if (!e || !password || password.length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters.', status: await buildStatus() };
    }
    const result = await emailRegister(e, password, name?.trim());
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    return completeSignIn(result.data);
  });

  ipcMainProxy.handle('sulla-cloud:apple-sign-in', async(_event: unknown, identityToken: string, fullName?: string, email?: string): Promise<AuthResult> => {
    if (!identityToken?.trim()) {
      return { ok: false, error: 'Apple identity token missing.', status: await buildStatus() };
    }
    const result = await appleSignIn(identityToken.trim(), fullName, email);
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    return completeSignIn(result.data);
  });

  /**
   * Runs the full web-OAuth Sign-in-with-Apple flow in a BrowserWindow. On
   * success, persists:
   *   - The Sulla Cloud session to integration_id="sulla-cloud" (via completeSignIn)
   *   - The Apple identity to integration_id="apple_signin" so the Apple
   *     integration shows as "connected" in the vault UI.
   */
  ipcMainProxy.handle('sulla-cloud:apple-sign-in-browser', async(): Promise<AuthResult> => {
    try {
      const flow = await runOAuthFlow('apple', 'sulla-cloud');

      // Save Apple identity to the apple_signin integration vault record so
      // it appears as "connected" when the user opens the vault.
      try {
        const svc = getIntegrationService();
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
        console.warn('[SullaCloudAuth] Failed to save apple_signin record:', err);
      }

      const sulla = flow.sullaSession;
      if (!sulla) {
        return {
          ok:     false,
          error:  'Apple sign-in did not return a Sulla Cloud session.',
          status: await buildStatus(),
        };
      }
      // Wrap the worker's sullaSession into the VerifyResponse shape that
      // completeSignIn expects.
      const verifyLike: VerifyResponse = {
        accessToken:  sulla.accessToken,
        refreshToken: sulla.refreshToken,
        contractor:   sulla.contractor as CloudContractor,
      };
      return completeSignIn(verifyLike);
    } catch (err: any) {
      const msg = err?.message === 'user_cancelled'
        ? 'Sign-in cancelled.'
        : err?.message === 'oauth_flow_timeout'
          ? 'Sign-in timed out. Try again.'
          : err?.message === 'oauth_flow_expired'
            ? 'Sign-in session expired. Try again.'
            : (err?.message || 'Apple sign-in failed.');
      return { ok: false, error: msg, status: await buildStatus(msg) };
    }
  });

  ipcMainProxy.handle('sulla-cloud:logout', async(): Promise<AuthStatus> => {
    await clearSession();
    try {
      // Also disconnect the apple_signin vault record so it no longer shows
      // as connected. Deletes all Apple accounts for this user.
      const svc = getIntegrationService();
      const appleAccounts = await svc.getAccounts('apple_signin');
      for (const acc of appleAccounts) {
        await svc.deleteAccount('apple_signin', acc.account_id);
      }
    } catch (err) {
      console.warn('[SullaCloudAuth] Failed to clear apple_signin accounts:', err);
    }
    try {
      await getDesktopRelayClient().setPairedUserId('');
    } catch { /* ignore */ }
    try {
      const { SullaSync } = await import('./sync/SullaSyncService');
      SullaSync.stop();
    } catch { /* ignore — service may not have started */ }
    DevicesCloudApi.stopHeartbeat();
    console.log('[SullaCloudAuth] Signed out');
    return buildStatus();
  });

  // Auto-pair relay on startup if we have a signed-in session.
  //
  // This needs to be resilient to a DB that isn't ready yet. On a fresh app
  // launch the Sulla Postgres container can take 30-60s to come up while
  // Lima provisions the VM and docker compose brings up the service, so
  // loadSession() — which reads from integration_values — throws
  // ECONNREFUSED if we fire it too early. Previously the IIFE ran once,
  // caught the error, and gave up. That left the relay permanently
  // disconnected for the entire app session even though the user was
  // signed in, which surfaced as mobile peer-offline errors until the
  // user manually re-signed-in.
  //
  // Retry strategy: backoff 2s → 60s cap, up to ~10 minutes total. Only
  // retries on transient connection errors (ECONNREFUSED, ETIMEDOUT, etc.
  // plus generic network failures). Stops on the first successful
  // loadSession() call — whether that returns a session (pair + start
  // services) or null (no signed-in user — nothing to do).
  (async() => {
    const RETRY_BASE_MS  = 2_000;
    const RETRY_MAX_MS   = 60_000;
    const RETRY_GIVEUP_MS = 10 * 60_000;
    const startedAt = Date.now();
    let delay = RETRY_BASE_MS;

    const isTransient = (err: any): boolean => {
      const code = err?.code ?? err?.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNRESET') return true;
      const msg = String(err?.message || err || '').toLowerCase();
      return /econnrefused|etimedout|enotfound|econnreset|connect.*failed|pool.*shutting down|database.*not ready/.test(msg);
    };

    while (true) {
      try {
        const session = await loadSession();
        if (session) {
          await getDesktopRelayClient().setPairedUserId(session.userId);
          // Resume device registration + heartbeat so this desktop shows online
          // for any mobile looking at the AI Assistant settings screen.
          void DevicesCloudApi.register().then(() => DevicesCloudApi.startHeartbeat());
          // Resume the offline-friendly sync loop so pulled claude_messages
          // can be dispatched to Claude even without the WS relay.
          try {
            const { SullaSync } = await import('./sync/SullaSyncService');
            SullaSync.start();
          } catch (err) {
            console.warn('[SullaCloudAuth] Failed to start SullaSync on restore:', err);
          }
          console.log(`[SullaCloudAuth] Restored session: user=${ session.userId }`);
        } else {
          console.log('[SullaCloudAuth] Startup restore: no signed-in session');
        }
        // Success (either a session was restored or none exists) — stop retrying.
        return;
      } catch (err) {
        if (!isTransient(err) || (Date.now() - startedAt) >= RETRY_GIVEUP_MS) {
          console.warn('[SullaCloudAuth] Startup restore failed (giving up):', err);
          return;
        }
        console.log(`[SullaCloudAuth] Startup restore not ready yet (${ (err as Error)?.message || err }); retrying in ${ delay }ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  })();
}
