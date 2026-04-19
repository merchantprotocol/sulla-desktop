/**
 * Sulla Cloud authentication handler.
 *
 * Signs in to the same sulla-workers account used by Sulla Mobile, via phone
 * OTP. On success, stores the JWT access + refresh tokens in macOS Keychain
 * (via Electron safeStorage) and auto-pairs the DesktopRelay client using the
 * authenticated contractor_id (JWT sub).
 */

import { safeStorage } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

import { getDesktopRelayClient } from './desktopRelay';

const console = Logging.background;

const API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';
const SETTINGS_KEY_ENCRYPTED_TOKENS = 'sullaCloudTokensEncrypted';
const SETTINGS_KEY_USER_ID = 'sullaCloudUserId';
const SETTINGS_KEY_PHONE = 'sullaCloudPhone';

interface StoredTokens {
  accessToken:  string;
  refreshToken: string;
}

interface CloudContractor {
  id:           string;
  phone:        string;
  businessName: string | null;
  name:         string | null;
}

interface AuthStatus {
  signedIn:   boolean;
  userId:     string;
  phone:      string;
  lastError?: string;
}

interface AuthResult {
  ok:         boolean;
  error?:     string;
  status:     AuthStatus;
}

// ── Token storage (Keychain via safeStorage) ────────────────

async function saveTokens(tokens: StoredTokens, contractor: CloudContractor): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage unavailable on this system');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64');
  await SullaSettingsModel.set(SETTINGS_KEY_ENCRYPTED_TOKENS, encrypted, 'string');
  await SullaSettingsModel.set(SETTINGS_KEY_USER_ID, contractor.id, 'string');
  await SullaSettingsModel.set(SETTINGS_KEY_PHONE, contractor.phone ?? '', 'string');
}

async function loadTokens(): Promise<StoredTokens | null> {
  const encrypted = await SullaSettingsModel.get(SETTINGS_KEY_ENCRYPTED_TOKENS, '');
  if (!encrypted) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    return JSON.parse(plain) as StoredTokens;
  } catch (err) {
    console.warn('[SullaCloudAuth] Failed to decrypt tokens:', err);
    return null;
  }
}

async function clearTokens(): Promise<void> {
  await SullaSettingsModel.delete(SETTINGS_KEY_ENCRYPTED_TOKENS);
  await SullaSettingsModel.delete(SETTINGS_KEY_USER_ID);
  await SullaSettingsModel.delete(SETTINGS_KEY_PHONE);
}

// ── Status ──────────────────────────────────────────────────

async function buildStatus(lastError?: string): Promise<AuthStatus> {
  const tokens = await loadTokens();
  const userId = (await SullaSettingsModel.get(SETTINGS_KEY_USER_ID, '')) ?? '';
  const phone = (await SullaSettingsModel.get(SETTINGS_KEY_PHONE, '')) ?? '';
  return {
    signedIn: !!tokens && !!userId,
    userId,
    phone,
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

  // Shared success path: persist tokens, auto-pair relay, return status.
  const completeSignIn = async(data: VerifyResponse): Promise<AuthResult> => {
    await saveTokens(
      { accessToken: data.accessToken, refreshToken: data.refreshToken },
      data.contractor,
    );
    try {
      await getDesktopRelayClient().setPairedUserId(data.contractor.id);
    } catch (err) {
      console.warn('[SullaCloudAuth] Auto-pair failed:', err);
    }
    console.log(`[SullaCloudAuth] Signed in as ${ data.contractor.id }`);
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
    await clearTokens();
    try {
      await getDesktopRelayClient().setPairedUserId('');
    } catch { /* ignore */ }
    console.log('[SullaCloudAuth] Signed out');
    return buildStatus();
  });

  // Auto-pair relay on startup if we have valid tokens
  (async() => {
    try {
      const tokens = await loadTokens();
      const userId = (await SullaSettingsModel.get(SETTINGS_KEY_USER_ID, '')) ?? '';
      if (tokens && userId) {
        await getDesktopRelayClient().setPairedUserId(userId);
        console.log(`[SullaCloudAuth] Restored session: ${ userId }`);
      }
    } catch (err) {
      console.warn('[SullaCloudAuth] Startup restore failed:', err);
    }
  })();
}
