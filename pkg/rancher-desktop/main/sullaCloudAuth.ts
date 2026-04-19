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

  ipcMainProxy.handle('sulla-cloud:logout', async(): Promise<AuthStatus> => {
    await clearSession();
    try {
      await getDesktopRelayClient().setPairedUserId('');
    } catch { /* ignore */ }
    console.log('[SullaCloudAuth] Signed out');
    return buildStatus();
  });

  // Auto-pair relay on startup if we have a signed-in session
  (async() => {
    try {
      const session = await loadSession();
      if (session) {
        await getDesktopRelayClient().setPairedUserId(session.userId);
        console.log(`[SullaCloudAuth] Restored session: user=${ session.userId }`);
      }
    } catch (err) {
      console.warn('[SullaCloudAuth] Startup restore failed:', err);
    }
  })();
}
