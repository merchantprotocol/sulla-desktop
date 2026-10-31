// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

import fs from 'node:fs';
import { BrowserWindow, clipboard, dialog } from 'electron';

import { IntegrationValueModel } from '@pkg/agent/database/models/IntegrationValueModel';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { applyFirstRunChoicesWhenReady } from '@pkg/main/firstRun/applyFirstRunChoices';
import { getFirstRunState } from '@pkg/main/firstRun/firstRunState';
import { clearPendingCredential, getPendingCredential, queuePendingCredential, startPendingCredentialFlush } from '@pkg/main/firstRun/pendingCredentials';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import { getConfiguredApprovalClient, requireConfiguredCredentialBroker, usesContainerVaultAuthority, VaultBrokerError } from '@pkg/vault-broker';
import { deriveAccountAuthHash, deriveMasterKey } from '../../../packages/vault-crypto/src/index';

import { getDesktopRelayClient } from './desktopRelay';
import { DevicesCloudApi } from './devicesCloudApi';
import { readRecoveryKeyFromMacKeychain, recoveryKeyStorageStatus, saveRecoveryKeyToMacKeychain } from './recoveryKeychain';
import { runOAuthFlow } from './sullaOAuthService';

const console = Logging.background;

const API_BASE = 'https://sulla-workers.merchantprotocol.workers.dev';
const INTEGRATION_ID = 'sulla-cloud';

async function cloudFetch(path: string, init: RequestInit, retry = false): Promise<Response> {
  const attempts = retry ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(`${ API_BASE }${ path }`, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

interface AccountKdf {
  alg:         'argon2id13';
  salt:        string;
  memoryBytes: number;
  ops:         number;
}

interface DerivedAccountCredential {
  authHash: string;
  kdf:      AccountKdf;
  masterKey: Uint8Array;
}

let pendingCloudMasterKey: Uint8Array | undefined;
let pendingCloudAccountKdf: AccountKdf | undefined;
let pendingCloudUserId: string | undefined;
let quitCleanupInstalled = false;
let accountWrapFlushHookInstalled = false;
let unshownRecoveryKey: { recoveryKey: string; storage: ReturnType<typeof recoveryKeyStorageStatus>; madeAt: string } | undefined;

function zeroPendingCloudMasterKey(): void {
  pendingCloudMasterKey?.fill(0);
  pendingCloudMasterKey = undefined;
  pendingCloudAccountKdf = undefined;
  pendingCloudUserId = undefined;
}

/**
 * D2 consumes this key when the vault is ready. Ownership transfers to the
 * caller, which must zero it after wrapping/flush. Nothing is persisted.
 */
export function takePendingCloudMasterKey(): Uint8Array | undefined {
  const key = pendingCloudMasterKey;
  pendingCloudMasterKey = undefined;
  return key;
}

export function clearPendingCloudMasterKey(): void {
  zeroPendingCloudMasterKey();
}

function retainCloudMasterKey(key: Uint8Array, kdf: AccountKdf, userId: string): void {
  zeroPendingCloudMasterKey();
  pendingCloudMasterKey = key;
  pendingCloudAccountKdf = kdf;
  pendingCloudUserId = userId;
  if (!quitCleanupInstalled) {
    quitCleanupInstalled = true;
    process.once('exit', zeroPendingCloudMasterKey);
  }
}

async function flushAccountPasswordWrap(userId = pendingCloudUserId): Promise<{ recoveryKey?: string }> {
  const kdf = pendingCloudAccountKdf;
  const key = pendingCloudMasterKey;
  if (!key || !kdf || !userId || !usesContainerVaultAuthority()) {
    return {};
  }
  const attemptKey = Uint8Array.from(key);
  try {
    const client = getConfiguredApprovalClient();
    if (!client) throw new Error('Desktop vault account-wrap service is unavailable');
    const result = await client.rewrapForAccountPassword({ masterKey: Buffer.from(attemptKey).toString('base64url'), kdf });
    // The vault is authoritative now. Publish before optional Keychain/UI work.
    const { onVaultUnlocked } = await import('@pkg/sulla');
    await onVaultUnlocked();
    zeroPendingCloudMasterKey();
    if (result.recoveryKey) {
      let storage = recoveryKeyStorageStatus();
      try {
        storage = await saveRecoveryKeyToMacKeychain(userId, result.recoveryKey);
      } catch (error) {
        console.warn('[SullaCloudAuth] Recovery key was created but Keychain save failed:', error instanceof Error ? error.message : String(error));
      }
      unshownRecoveryKey = { recoveryKey: result.recoveryKey, storage, madeAt: new Date().toISOString() };
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('sulla-cloud:recovery-key-created', unshownRecoveryKey);
      }
    }
    return { recoveryKey: result.recoveryKey };
  } finally {
    attemptKey.fill(0);
  }
}

function parseAccountKdf(value: unknown): AccountKdf {
  const kdf = value as Partial<AccountKdf> | null;
  if (kdf?.alg !== 'argon2id13' || typeof kdf.salt !== 'string' || !kdf.salt ||
      kdf.memoryBytes !== 67_108_864 || kdf.ops !== 3) {
    throw new Error('Sulla Cloud returned an unsupported account KDF.');
  }
  return kdf as AccountKdf;
}

async function deriveAccountCredential(password: string, accountKdf?: AccountKdf): Promise<DerivedAccountCredential> {
  const derived = await deriveMasterKey(
    password,
    accountKdf?.salt,
    accountKdf ? { memoryBytes: accountKdf.memoryBytes, operations: accountKdf.ops } : undefined,
  );
  const kdf: AccountKdf = {
    alg:         'argon2id13',
    salt:        derived.salt,
    memoryBytes: derived.parameters.memoryBytes,
    ops:         derived.parameters.operations,
  };
  try {
    return { authHash: await deriveAccountAuthHash(derived.key), kdf, masterKey: derived.key };
  } catch (error) {
    derived.key.fill(0);
    throw error;
  }
}

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

function signedOutStatus(lastError?: string): AuthStatus {
  return { signedIn: false, userId: '', activeContractorId: '', phone: '', name: '', contractorCount: 0, lastError };
}

const SIGN_IN_AGAIN = 'Sign in to Sulla Cloud again.';
let startupAdoptionComplete = false;
let startupAdoptionPromise: Promise<void> | null = null;
let startupAdoptionError: string | undefined;
let wakeStartupRestore: (() => void) | undefined;

export function signalSullaCloudStartupRestore(): void {
  wakeStartupRestore?.();
}

function vaultSessionError(error: unknown, action: 'sign in' | 'sign out'): string {
  if (error instanceof VaultBrokerError) {
    if (error.code === 'vault_locked' || error.status === 423) return `Unlock the vault to ${ action }.`;
    if (error.status === 404 || error.code === 'not_found') {
      return `Update the Sulla Vault service to ${ action } from Desktop.`;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Could not ${ action }: ${ message || 'the vault is unavailable' }`;
}

// ── Session storage (IntegrationService, vault-encrypted) ──────

async function saveSession(session: CloudSession): Promise<void> {
  if (usesContainerVaultAuthority()) {
    const client = getConfiguredApprovalClient();
    if (!client) throw new Error('Desktop vault session service is unavailable');
    await client.adoptSullaCloudSession({
      userId: session.userId, activeContractorId: session.activeContractorId,
      contractors: session.contractors, accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
    });
    await clearLegacySettings();
    return;
  }
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

  // Device registration, heartbeat, secure channel and any opted-in sync
  // are started by cloudLifecycle.startCloudServices() on sign-in/restore,
  // not here — saveSession also runs on every token refresh.
}

async function loadSession(): Promise<CloudSession | null> {
  const queued = getPendingCredential(INTEGRATION_ID);
  if (queued) {
    return {
      userId: queued.values.user_id,
      activeContractorId: queued.values.active_contractor_id,
      contractors: JSON.parse(queued.values.contractors_json || '[]'),
      tokens: { accessToken: queued.values.access_token, refreshToken: queued.values.refresh_token },
    };
  }
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

type SessionIdentity = Pick<CloudSession, 'userId' | 'activeContractorId' | 'contractors'>;

function activeConnectedAccountId(metadata: Awaited<ReturnType<ReturnType<typeof requireConfiguredCredentialBroker>['integrationMetadata']>>): string | undefined {
  const active = metadata.accounts.find(account => account.accountId === metadata.activeAccountId && account.connected);
  return active?.accountId ?? metadata.accounts.find(account => account.active && account.connected)?.accountId;
}

/**
 * Non-secret session identity. Under the container vault the app may read
 * only account metadata (tokens stay in the vault), so the identity comes
 * from the account id, which saveSession keys by userId.
 */
async function loadSessionIdentity(): Promise<SessionIdentity | null> {
  const queued = getPendingCredential(INTEGRATION_ID);
  if (queued) {
    return {
      userId:             queued.values.user_id,
      activeContractorId: queued.values.active_contractor_id,
      contractors:        JSON.parse(queued.values.contractors_json || '[]'),
    };
  }
  if (!usesContainerVaultAuthority()) {
    const session = await loadSession();
    return session ? { userId: session.userId, activeContractorId: session.activeContractorId, contractors: session.contractors } : null;
  }
  const broker = requireConfiguredCredentialBroker();
  const status = await broker.status();
  if (!status.unlocked) throw new VaultBrokerError('vault_locked', 'Waiting for the vault to be unlocked.', 423);
  const metadata = await broker.integrationMetadata(INTEGRATION_ID);
  const accountId = activeConnectedAccountId(metadata);
  if (!accountId) return null;
  // Today userId === activeContractorId (single-contractor server response).
  return { userId: accountId, activeContractorId: accountId, contractors: [] };
}

class VaultNotReadyError extends Error {}

/**
 * Startup-restore variant of loadSessionIdentity. getAccounts() swallows vault
 * errors and returns [] so settings stay usable while the vault boots — but
 * the vault container comes up minutes after Electron, and reading that []
 * as "signed out" skipped device heartbeat and the secure channel for the
 * whole app session (phone and Cloud dashboard saw the desktop as offline).
 * Here "vault not reachable/unlocked yet" throws so restore keeps waiting.
 */
async function loadSessionIdentityForRestore(): Promise<SessionIdentity | null> {
  if (!usesContainerVaultAuthority()) return loadSessionIdentity();
  let metadata: Awaited<ReturnType<ReturnType<typeof requireConfiguredCredentialBroker>['integrationMetadata']>>;
  try {
    const broker = requireConfiguredCredentialBroker();
    const status = await broker.status();
    if (!status.unlocked) throw new Error('vault is locked');
    await ensureLegacySessionAdopted();
    metadata = await broker.integrationMetadata(INTEGRATION_ID);
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    const code = (err as any)?.code ?? (err as any)?.cause?.code;
    if (err instanceof VaultBrokerError && (err.code === 'vault_locked' || err.status === 423) ||
        ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code) ||
        /locked|unavailable|timeout|timed out|not ready|connection/i.test(message)) {
      throw new VaultNotReadyError(`vault not ready: ${ message }`);
    }
    throw err;
  }
  const accountId = activeConnectedAccountId(metadata);
  // A first-run sign-in held in memory is written into the vault right after
  // it unlocks. Retry until it lands instead of reporting a signed-out Mac.
  if (!accountId && getPendingCredential(INTEGRATION_ID)) {
    throw new VaultNotReadyError('vault not ready: the Sulla Cloud session is still being saved');
  }
  if (!accountId) {
    startupAdoptionError = SIGN_IN_AGAIN;
    return null;
  }
  startupAdoptionError = undefined;
  return { userId: accountId, activeContractorId: accountId, contractors: [] };
}

/**
 * Adopt a session written by Desktop before the container vault became the
 * authority. The handoff runs at most once successfully per process; startup
 * retries it while Postgres/the vault are unavailable. Tokens never leave the
 * main process except for the existing fixed-purpose vault adoption call.
 */
async function ensureLegacySessionAdopted(): Promise<void> {
  if (!usesContainerVaultAuthority() || startupAdoptionComplete) return;
  if (startupAdoptionPromise) return startupAdoptionPromise;
  startupAdoptionPromise = (async() => {
    const broker = requireConfiguredCredentialBroker();
    const metadata = await broker.integrationMetadata(INTEGRATION_ID);
    if (metadata.activeAccountId || metadata.accounts.length > 0) {
      await IntegrationValueModel.deleteLegacySullaCloudSession();
      startupAdoptionComplete = true;
      return;
    }

    const legacy = await IntegrationValueModel.findLegacySullaCloudSession();
    const userId = legacy?.user_id;
    const refreshToken = legacy?.refresh_token;
    if (!legacy) {
      startupAdoptionComplete = true;
      return;
    }
    if (!userId || !refreshToken) {
      startupAdoptionError = SIGN_IN_AGAIN;
      startupAdoptionComplete = true;
      return;
    }

    let refreshed: Response;
    try {
      refreshed = await cloudFetch('/auth/refresh', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ refreshToken }),
      }, true);
    } catch (error) {
      throw new VaultNotReadyError(`cloud refresh unavailable: ${ (error as Error)?.message || error }`);
    }
    if (refreshed.status === 401 || refreshed.status === 403) {
      startupAdoptionError = SIGN_IN_AGAIN;
      startupAdoptionComplete = true;
      return;
    }
    if (!refreshed.ok) throw new VaultNotReadyError(`cloud refresh failed: HTTP ${ refreshed.status }`);
    const tokens = await refreshed.json() as { accessToken?: string; refreshToken?: string };
    if (!tokens.accessToken) {
      startupAdoptionError = SIGN_IN_AGAIN;
      startupAdoptionComplete = true;
      return;
    }

    let contractors: CloudContractor[] = [];
    try {
      contractors = legacy.contractors_json ? JSON.parse(legacy.contractors_json) as CloudContractor[] : [];
    } catch { /* use an empty list for legacy single-contractor sessions */ }
    const activeContractorId = legacy.active_contractor_id || userId;
    const client = getConfiguredApprovalClient();
    if (!client) throw new VaultNotReadyError('Desktop vault session service is unavailable');
    try {
      await client.adoptSullaCloudSession({
        userId, activeContractorId, contractors,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || refreshToken,
      });
    } catch (error) {
      if (error instanceof VaultBrokerError && error.code === 'invalid_operation') {
        startupAdoptionError = SIGN_IN_AGAIN;
        startupAdoptionComplete = true;
        return;
      }
      throw error;
    }
    await IntegrationValueModel.deleteLegacySullaCloudSession();
    await clearLegacySettings();
    startupAdoptionError = undefined;
    startupAdoptionComplete = true;
    console.log('[SullaCloudAuth] Adopted existing Sulla Cloud session into the container vault');
  })().finally(() => {
    startupAdoptionPromise = null;
  });
  return startupAdoptionPromise;
}

async function clearSession(): Promise<void> {
  if (usesContainerVaultAuthority()) {
    const client = getConfiguredApprovalClient();
    if (!client) throw new Error('Desktop vault session service is unavailable');
    await client.clearSullaCloudSession();
    await IntegrationValueModel.deleteLegacySullaCloudSession();
    await clearLegacySettings();
    return;
  }
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

function findActiveContractor(session: SessionIdentity): CloudContractor | null {
  return session.contractors.find(c => c.id === session.activeContractorId)
    ?? session.contractors[0]
    ?? null;
}

async function buildStatus(lastError?: string): Promise<AuthStatus> {
  let session: SessionIdentity | null = null;
  try {
    session = await loadSessionIdentity();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...signedOutStatus(lastError ?? startupAdoptionError ?? message), ...( /lock/i.test(message) ? { vaultLocked: true } : { vaultMissing: true }) } as AuthStatus;
  }
  if (!session) {
    return { signedIn: false, userId: '', activeContractorId: '', phone: '', name: '', contractorCount: 0, lastError: lastError ?? startupAdoptionError };
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
  const res = await cloudFetch('/auth/otp/send', {
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
  const res = await cloudFetch('/auth/otp/verify', {
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

async function prelogin(email: string): Promise<{ kdf: AccountKdf; authVersion: 1 | 2 }> {
  const res = await cloudFetch('/auth/prelogin', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email }),
  }, true);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(`${ res.status }: ${ body.error || 'Sulla Cloud request failed' }`);
  }
  const data = await res.json() as { kdf?: unknown; authVersion?: unknown };
  if (data.authVersion !== 1 && data.authVersion !== 2) throw new Error('Sulla Cloud returned an unsupported authentication version.');
  return { kdf: parseAccountKdf(data.kdf), authVersion: data.authVersion };
}

interface PasswordAuthResponse {
  ok:          boolean;
  error?:      string;
  httpStatus?: number;
  retryAfter?: number;
  data?:       VerifyResponse;
  masterKey?:  Uint8Array;
  kdf?:        AccountKdf;
}

/** Cloud throttles repeated sign-in attempts with 429 + Retry-After (seconds). */
function retryAfterSeconds(res: Response): number | undefined {
  const value = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
  return Number.isFinite(value) ? value : undefined;
}

function throttled(result: PasswordAuthResponse) {
  const wait = result.retryAfter ?? 60;
  return { ok: false as const, accountExists: true, retryAfter: wait, error: `Too many tries. Wait ${ wait } seconds and try again, or reset your password.` };
}

async function emailLogin(email: string, password: string, knownAccount?: Awaited<ReturnType<typeof prelogin>>): Promise<PasswordAuthResponse> {
  const account = knownAccount ?? await prelogin(email);
  const credential = await deriveAccountCredential(password, account.kdf);
  const endpoint = account.authVersion === 1 ? '/auth/upgrade' : '/auth/email/login';
  const body = account.authVersion === 1
    ? { email, password, authHash: credential.authHash, kdf: credential.kdf }
    : { email, authHash: credential.authHash };
  try {
    const res = await cloudFetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      credential.masterKey.fill(0);
      const response = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, error: response.error || `HTTP ${ res.status }`, httpStatus: res.status, retryAfter: retryAfterSeconds(res) };
    }
    return { ok: true, data: await res.json() as VerifyResponse, masterKey: credential.masterKey, kdf: credential.kdf };
  } catch (error) {
    credential.masterKey.fill(0);
    throw error;
  }
}

async function emailRegister(email: string, password: string, name?: string): Promise<PasswordAuthResponse> {
  const credential = await deriveAccountCredential(password);
  try {
    const res = await cloudFetch('/auth/email/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        email,
        authHash: credential.authHash,
        kdf: credential.kdf,
        name,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    if (!res.ok) {
      credential.masterKey.fill(0);
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, error: body.error || `HTTP ${ res.status }`, httpStatus: res.status, retryAfter: retryAfterSeconds(res) };
    }
    return { ok: true, data: await res.json() as VerifyResponse, masterKey: credential.masterKey, kdf: credential.kdf };
  } catch (error) {
    credential.masterKey.fill(0);
    throw error;
  }
}

/** Passwordless: email a 6-digit code that signs in or creates the account. */
async function emailCodeStart(email: string): Promise<{ ok: boolean; error?: string }> {
  const res = await cloudFetch('/auth/email-code/start', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email }),
  });
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({})) as { error?: string };
  return { ok: false, error: body.error || `HTTP ${ res.status }` };
}

async function emailCodeVerify(email: string, code: string, name?: string): Promise<{ ok: boolean; error?: string; data?: VerifyResponse & { isNewUser?: boolean } }> {
  const res = await cloudFetch('/auth/email-code/verify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, code, name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: body.error || `HTTP ${ res.status }` };
  }
  return { ok: true, data: await res.json() as VerifyResponse & { isNewUser?: boolean } };
}

async function appleSignIn(identityToken: string, fullName?: string, email?: string): Promise<{ ok: boolean; error?: string; data?: VerifyResponse }> {
  const res = await cloudFetch('/auth/apple', {
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

// Refresh is attempted from nearly every authenticated code path, so an
// unreachable cloud produced thousands of identical warn lines per day
// (observed: 4,084 in one background.log). Log the first failure, then
// every 40th, and announce recovery so outage windows stay visible.
let refreshFailCount = 0;

function warnRefreshFailure(message: string): void {
  refreshFailCount++;
  if (refreshFailCount === 1 || refreshFailCount % 40 === 0) {
    console.warn(`${ message }${ refreshFailCount > 1 ? ` (${ refreshFailCount } consecutive failures, logging every 40th)` : '' }`);
  }
}

/**
 * Exchange the stored refresh token for a new access token. On success, the
 * session's accessToken (and refreshToken, if rotated) are written back to
 * storage. Returns the new access token, or empty string on failure — the
 * caller should surface a re-auth prompt at that point.
 */
async function refreshAccessToken(): Promise<string> {
  const pendingSession = getPendingCredential(INTEGRATION_ID);
  // In container-vault mode refresh and token rotation happen within the
  // vault broker. Secret token egress into Electron is intentionally blocked.
  if (usesContainerVaultAuthority() && !pendingSession) return '';
  const session = await loadSession();
  if (!session?.tokens.refreshToken) return '';

  try {
    const res = await cloudFetch('/auth/refresh', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refreshToken: session.tokens.refreshToken }),
    }, true);
    if (!res.ok) {
      warnRefreshFailure(`[sullaCloudAuth] Refresh failed: HTTP ${ res.status }`);
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
    if (pendingSession) {
      queuePendingCredential({
        integrationId: INTEGRATION_ID,
        accountId:     refreshed.userId,
        activate:      true,
        values: {
          access_token:         refreshed.tokens.accessToken,
          refresh_token:        refreshed.tokens.refreshToken,
          user_id:              refreshed.userId,
          active_contractor_id: refreshed.activeContractorId,
          contractors_json:     JSON.stringify(refreshed.contractors),
        },
      });
    } else {
      await saveSession(refreshed);
    }
    if (refreshFailCount > 1) {
      console.log(`[sullaCloudAuth] Refresh recovered after ${ refreshFailCount } consecutive failures`);
    }
    refreshFailCount = 0;
    return data.accessToken;
  } catch (err: any) {
    warnRefreshFailure(`[sullaCloudAuth] Refresh error: ${ err?.message || err }`);
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
  if (usesContainerVaultAuthority()) return '';
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

/** True when non-secret Sulla Cloud account metadata identifies an active session. */
export async function isCloudSignedIn(): Promise<boolean> {
  return (await loadSessionIdentity()) !== null;
}

/**
 * Returns the active contractor id for the signed-in user, or an empty
 * string if not signed in. One user may own multiple contractors; this
 * reflects whichever they've selected in the UI. Used by the sync layer
 * as a fallback when an inbound payload doesn't embed contractor_id.
 */
export async function getActiveContractorId(): Promise<string> {
  const session = await loadSessionIdentity();
  return session?.activeContractorId ?? '';
}

/**
 * Returns the signed-in user id (stable across contractor switches),
 * or an empty string if not signed in.
 */
export async function getCurrentUserId(): Promise<string> {
  const session = await loadSessionIdentity();
  return session?.userId ?? '';
}

// ── IPC handlers ───────────────────────────────────────────

export function initSullaCloudAuthEvents(): void {
  applyFirstRunChoicesWhenReady();
  startPendingCredentialFlush();
  if (!accountWrapFlushHookInstalled) {
    accountWrapFlushHookInstalled = true;
    const lifecycle = getServiceLifecycleManager();
    let flushing = false;
    let wrapRetryMs = 2_000;
    let wrapRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const flushWhenReady = () => {
      // Create the vault as soon as its service is up, even mid-setup: the key
      // exists from the Account step, and waiting only widens the window
      // where a quit loses it. Sign-ins held in memory flush right after.
      if (flushing || !pendingCloudMasterKey ||
          !lifecycle.serviceStatuses().some(({ name, status }) => name === 'vault' && status === 'ready')) return;
      flushing = true;
      void (async() => {
        // An unlocked vault moves to the account password; a vault that does
        // not exist yet (fresh install) is created from the account key.
        let creating = false;
        if (!lifecycle.isVaultUnlocked()) {
          const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
          const status = await getDesktopVaultClient().status();
          if (!status.setup?.required) return;
          creating = true;
        }
        await flushAccountPasswordWrap();
        if (creating) {
          console.log('[SullaCloudAuth] Vault created from the Cloud account password and unlocked');
        }
        wrapRetryMs = 2_000;
      })().catch(error => {
        console.error('[SullaCloudAuth] Account-password vault migration failed; retrying:', error instanceof Error ? error.message : String(error));
        if (!wrapRetryTimer) {
          wrapRetryTimer = setTimeout(() => {
            wrapRetryTimer = undefined;
            flushWhenReady();
          }, wrapRetryMs);
          wrapRetryTimer.unref?.();
          wrapRetryMs = Math.min(wrapRetryMs * 2, 60_000);
        }
      }).finally(() => { flushing = false });
    };
    lifecycle.on('vault:state', flushWhenReady);
    lifecycle.on('service:ready', (name: string) => { if (name === 'vault') flushWhenReady() });
    const retry = setInterval(flushWhenReady, 5_000);
    retry.unref?.();
  }
  const ipcMainProxy = getIpcMainProxy(console);

  ipcMainProxy.handle('sulla-cloud:first-run-session', async() => {
    let oldVaultLocked = false;
    try {
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      const status = await getDesktopVaultClient().status();
      oldVaultLocked = status.setup?.required === false && !status.unlocked;
    } catch { /* the vault may not be running yet */ }
    const queued = getPendingCredential(INTEGRATION_ID);
    return {
      sessionInMemory: !!queued,
      masterKeyRetained: !!pendingCloudMasterKey,
      email: queued?.values.email || queued?.values.contractors_json && JSON.parse(queued.values.contractors_json || '[]')[0]?.email || undefined,
      oldVaultLocked,
    };
  });
  // Sulla Cloud deliberately does not reveal whether an email has an account
  // (prelogin returns a decoy KDF for unknown emails), so this cannot tell.
  // The first-run copy stays neutral until email-continue reports accountExists.
  ipcMainProxy.handle('sulla-cloud:account-exists', async() => ({ exists: null }));
  ipcMainProxy.handle('sulla-cloud:email-code-availability', async() => ({ available: true }));
  ipcMainProxy.handle('sulla-cloud:recovery-key-pending', async() => unshownRecoveryKey);
  ipcMainProxy.handle('sulla-cloud:recovery-key-shown', async() => { unshownRecoveryKey = undefined });

  ipcMainProxy.handle('sulla-cloud:get-status', async(): Promise<AuthStatus> => {
    return buildStatus();
  });

  ipcMainProxy.handle('sulla-cloud:recovery-key-status', async() => {
    const status = recoveryKeyStorageStatus();
    if (status.location !== 'unavailable' && !await readRecoveryKeyFromMacKeychain()) {
      return { location: 'unavailable', label: 'Recovery key is not saved', checkedAt: new Date().toISOString() };
    }
    return { ...status, checkedAt: new Date().toISOString() };
  });
  ipcMainProxy.handle('sulla-cloud:recovery-key-rotate', async() => {
    const status = await buildStatus();
    if (!status.signedIn || !status.userId) throw new Error('Sign in to Sulla Cloud before making a recovery key.');
    const client = getConfiguredApprovalClient();
    if (!client) throw new Error('Desktop vault recovery service is unavailable.');
    const result = await client.rotateRecoveryKey();
    const storage = await saveRecoveryKeyToMacKeychain(status.userId, result.recoveryKey);
    return { ...result, storage, madeAt: new Date().toISOString() };
  });
  ipcMainProxy.handle('sulla-cloud:recovery-key-copy', async(_event: unknown, recoveryKey: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)) throw new Error('Recovery key is invalid.');
    clipboard.writeText(recoveryKey);
  });
  ipcMainProxy.handle('sulla-cloud:recovery-key-print', async(_event: unknown, recoveryKey: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)) throw new Error('Recovery key is invalid.');
    const owner = BrowserWindow.getFocusedWindow();
    const print = new BrowserWindow({ show: false, parent: owner ?? undefined, webPreferences: { sandbox: true } });
    try {
      await print.loadURL(`data:text/html,${ encodeURIComponent(`<title>Sulla recovery key</title><h1>Sulla recovery key</h1><p>Keep this somewhere safe.</p><pre>${ recoveryKey }</pre>`) }`);
      await new Promise<void>((resolve, reject) => print.webContents.print({}, (ok, reason) => ok ? resolve() : reject(new Error(reason))));
    } finally { print.destroy() }
  });
  ipcMainProxy.handle('sulla-cloud:recovery-key-save', async(_event: unknown, recoveryKey: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)) throw new Error('Recovery key is invalid.');
    const owner = BrowserWindow.getFocusedWindow();
    const options = { defaultPath: 'Sulla recovery key.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    const output = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (output.canceled || !output.filePath) return { saved: false };
    const page = new BrowserWindow({ show: false, parent: owner ?? undefined, webPreferences: { sandbox: true } });
    try {
      await page.loadURL(`data:text/html,${ encodeURIComponent(`<title>Sulla recovery key</title><style>body{font:18px system-ui;padding:48px}pre{font:22px monospace}</style><h1>Sulla recovery key</h1><p>Keep this somewhere safe.</p><pre>${ recoveryKey }</pre>`) }`);
      const pdf = await page.webContents.printToPDF({});
      await fs.promises.writeFile(output.filePath, pdf, { mode: 0o600 });
    } finally { page.destroy() }
    return { saved: true };
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
    try {
      await saveSession(session);
    } catch (err) {
      if (!usesContainerVaultAuthority()) throw err;
      const error = vaultSessionError(err, 'sign in');
      console.warn('[SullaCloudAuth] Could not save the Sulla Cloud session:', error);
      return { ok: false, error, status: await buildStatus(error).catch(() => signedOutStatus(error)) };
    }
    try {
      // Relay room is the stable userId, not the active contractor — so
      // switching businesses later doesn't drop the mobile connection.
      await getDesktopRelayClient().setPairedUserId(session.userId);
    } catch (err) {
      console.warn('[SullaCloudAuth] Auto-pair failed:', err);
    }
    try {
      // Always connected while signed in: device registration + secure
      // channel, plus whichever syncs the owner opted into.
      const { startCloudServices } = await import('./cloud/cloudLifecycle');
      await startCloudServices();
    } catch (err) {
      console.warn('[SullaCloudAuth] Failed to start cloud services:', err);
    }
    console.log(`[SullaCloudAuth] Signed in — user=${ session.userId }, active contractor=${ session.activeContractorId }`);
    return { ok: true, status: await buildStatus() };
  };

  // First run cannot assume the vault, Postgres, or Redis exists. Keep the
  // authenticated session only in main-process memory and let the vault
  // lifecycle flush it after the owner creates and unlocks their vault.
  const completeFirstRunSignIn = async(data: VerifyResponse): Promise<AuthResult> => {
    const session = responseToSession(data);
    queuePendingCredential({
      integrationId: INTEGRATION_ID,
      accountId:     session.userId,
      activate:      true,
      values: {
        access_token:        session.tokens.accessToken,
        refresh_token:       session.tokens.refreshToken,
        user_id:             session.userId,
        active_contractor_id: session.activeContractorId,
        contractors_json:    JSON.stringify(session.contractors),
      },
    });
    try { await getDesktopRelayClient().setPairedUserId(session.userId) } catch (err) { console.warn('[SullaCloudAuth] Auto-pair failed:', err) }
    try {
      const { startCloudServices } = await import('./cloud/cloudLifecycle');
      await startCloudServices();
    } catch (err) { console.warn('[SullaCloudAuth] Failed to start cloud services:', err) }
    return { ok: true, status: await buildStatus().catch(() => signedOutStatus()) };
  };

  // On first run the VM's Postgres may still be booting, so saving the session
  // can fail for a while. Keep trying for up to ~2 minutes before giving up.
  const completeSignInWhenReady = async(data: VerifyResponse, notReadyError: string): Promise<AuthResult> => {
    const deadline = Date.now() + 120_000;
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 15_000)) {
      try {
        const result = await completeSignIn(data);
        if (result.ok) return result;
        if (Date.now() + delay > deadline) return { ...result, error: notReadyError };
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (err) {
        if (Date.now() + delay > deadline) {
          console.warn('[SullaCloudAuth] Could not save the Sulla Cloud session:', err);
          return { ok: false, error: notReadyError, status: await buildStatus().catch(() => ({} as any)) };
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };

  const shouldKeepSessionInMemory = (): boolean => {
    if (!getFirstRunState().onboardingComplete) return true;
    const lifecycle = getServiceLifecycleManager();
    return !lifecycle.isVaultUnlocked() ||
      !lifecycle.serviceStatuses().some(({ name, status }) => name === 'vault' && status === 'ready');
  };

  const completeSignInForCurrentState = (data: VerifyResponse, notReadyError: string) =>
    shouldKeepSessionInMemory() ? completeFirstRunSignIn(data) : completeSignInWhenReady(data, notReadyError);

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
    return completeSignInForCurrentState(result.data, 'Sulla is still starting up. Wait a minute, then try again.');
  });

  ipcMainProxy.handle('sulla-cloud:email-login', async(_event: unknown, email: string, password: string): Promise<AuthResult> => {
    const e = email.trim().toLowerCase();
    if (!e || !password) {
      return { ok: false, error: 'Email and password are required.', status: await buildStatus() };
    }
    const result = await emailLogin(e, password);
    if (!result.ok || !result.data || !result.masterKey) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    retainCloudMasterKey(result.masterKey, result.kdf!, (result.data.userId ?? result.data.contractor.id));
    const inMemory = shouldKeepSessionInMemory();
    const signedIn = await completeSignInForCurrentState(result.data, 'Sulla is still starting up. Wait a minute, then try again.');
    if (signedIn.ok && !inMemory) await flushAccountPasswordWrap((result.data.userId ?? result.data.contractor.id)).catch(error => {
      console.warn('[SullaCloudAuth] Account-password vault migration is pending:', error instanceof Error ? error.message : String(error));
    });
    return signedIn;
  });

  ipcMainProxy.handle('sulla-cloud:email-code-start', async(_event: unknown, email: string) => {
    const e = String(email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, error: 'Enter a valid email address.' };
    try {
      return await emailCodeStart(e);
    } catch {
      return { ok: false, error: 'Could not reach Sulla Cloud. Check your connection and try again.' };
    }
  });

  ipcMainProxy.handle('sulla-cloud:email-code-verify', async(_event: unknown, email: string, code: string, name?: string) => {
    const e = String(email ?? '').trim().toLowerCase();
    const c = String(code ?? '').replace(/\s+/g, '');
    if (!e || !/^\d{6}$/.test(c)) {
      return { ok: false, error: 'Enter the 6-digit code from the email.', status: await buildStatus() };
    }
    let result: Awaited<ReturnType<typeof emailCodeVerify>>;
    try {
      result = await emailCodeVerify(e, c, name?.trim() || undefined);
    } catch {
      return { ok: false, error: 'Could not reach Sulla Cloud. Check your connection and try again.', status: await buildStatus() };
    }
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    // The code is spent and the tokens are in hand. On first run the VM's
    // Postgres may still be booting, so keep trying to persist the session
    // instead of forcing the user to request a new code.
    const firstRun = shouldKeepSessionInMemory();
    const signedIn = await completeSignInForCurrentState(result.data, 'Your email is verified, but Sulla is still starting up. Wait a minute, then send a new code.');
    return { ...signedIn, isNewUser: !!result.data.isNewUser, needsPassword: firstRun };
  });

  /**
   * First run: one email + password form that either creates the Sulla Cloud
   * account or signs in to the existing one. Register answers 409 when the
   * email already has an account; only then is the password checked against
   * it. No email is sent, so this works before email delivery exists.
   */
  ipcMainProxy.handle('sulla-cloud:email-continue', async(_event: unknown, email: string, password: string, name?: string) => {
    const e = String(email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, error: 'Enter a valid email address.', status: await buildStatus().catch(() => ({} as any)) };
    }
    if (!password) {
      return { ok: false, error: 'Enter a password.', status: await buildStatus().catch(() => ({} as any)) };
    }
    let data: VerifyResponse;
    let masterKey: Uint8Array;
    let accountKdf: AccountKdf;
    let isNewUser: boolean;
    try {
      // /auth/prelogin answers every email with a KDF (real or decoy) so it
      // cannot reveal whether an account exists. Register first; only a 409
      // means the account exists and the password should sign in.
      const created = await emailRegister(e, password, name?.trim() || undefined);
      if (created.ok && created.data) {
        data = created.data;
        masterKey = created.masterKey!;
        accountKdf = created.kdf!;
        isNewUser = true;
      } else if (created.httpStatus === 429) {
        return { ...throttled(created), status: await buildStatus().catch(() => ({} as any)) };
      } else if (created.httpStatus === 409) {
        const login = await emailLogin(e, password);
        if (login.httpStatus === 429) return { ...throttled(login), status: await buildStatus().catch(() => ({} as any)) };
        if (!login.ok || !login.data) {
          const error = login.httpStatus === 401 || login.httpStatus === 403
            ? 'That password is not correct.'
            : login.httpStatus && login.httpStatus >= 500
              ? 'Sulla Cloud had a problem, try again.'
              : login.error || 'Sulla needs an update to sign in.';
          return { ok: false, accountExists: true, error, status: await buildStatus().catch(() => ({} as any)) };
        }
        data = login.data;
        masterKey = login.masterKey!;
        accountKdf = login.kdf!;
        isNewUser = false;
      } else {
        return { ok: false, error: created.error || 'Could not create your Sulla Cloud account.', status: await buildStatus().catch(() => ({} as any)) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const friendly = /unsupported|kdf|version/i.test(message)
        ? 'Sulla needs an update to sign in.'
        : /\b5\d\d\b/.test(message) ? 'Sulla Cloud had a problem, try again.' : 'Could not reach Sulla Cloud. Check your connection and try again.';
      return { ok: false, error: friendly, status: await buildStatus().catch(() => ({} as any)) };
    }
    retainCloudMasterKey(masterKey!, accountKdf!, (data.userId ?? data.contractor.id));
    const signedIn = shouldKeepSessionInMemory()
      ? await completeFirstRunSignIn(data)
      : await completeSignInWhenReady(data, 'Sulla is still starting up. Wait a minute, then try again.');
    if (signedIn.ok && !shouldKeepSessionInMemory()) await flushAccountPasswordWrap((data.userId ?? data.contractor.id)).catch(error => {
      console.warn('[SullaCloudAuth] Account-password vault migration is pending:', error instanceof Error ? error.message : String(error));
    });
    return { ...signedIn, isNewUser };
  });

  ipcMainProxy.handle('sulla-cloud:email-register', async(_event: unknown, email: string, password: string, name?: string): Promise<AuthResult> => {
    const e = email.trim().toLowerCase();
    if (!e || !password) {
      return { ok: false, error: 'Enter your email and a password.', status: await buildStatus() };
    }
    const result = await emailRegister(e, password, name?.trim());
    if (!result.ok || !result.data || !result.masterKey) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    retainCloudMasterKey(result.masterKey, result.kdf!, (result.data.userId ?? result.data.contractor.id));
    const inMemory = shouldKeepSessionInMemory();
    const signedIn = await completeSignInForCurrentState(result.data, 'Sulla is still starting up. Wait a minute, then try again.');
    if (signedIn.ok && !inMemory) await flushAccountPasswordWrap((result.data.userId ?? result.data.contractor.id)).catch(error => {
      console.warn('[SullaCloudAuth] Account-password vault migration is pending:', error instanceof Error ? error.message : String(error));
    });
    return signedIn;
  });

  ipcMainProxy.handle('sulla-cloud:apple-sign-in', async(_event: unknown, identityToken: string, fullName?: string, email?: string): Promise<AuthResult> => {
    if (!identityToken?.trim()) {
      return { ok: false, error: 'Apple identity token missing.', status: await buildStatus() };
    }
    const result = await appleSignIn(identityToken.trim(), fullName, email);
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error, status: await buildStatus(result.error) };
    }
    return completeSignInForCurrentState(result.data, 'Sulla is still starting up. Wait a minute, then try again.');
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
      if (!usesContainerVaultAuthority()) {
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
      return completeSignInForCurrentState(verifyLike, 'Sulla is still starting up. Wait a minute, then try again.');
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
    clearPendingCloudMasterKey();
    clearPendingCredential(INTEGRATION_ID);
    try {
      await clearSession();
    } catch (err) {
      console.warn('[SullaCloudAuth] Could not remove the Sulla Cloud account:', err);
      // The broker clear is the authority. If it fails, keep Desktop paired
      // and Cloud services running so both sides still describe one session.
      return buildStatus(vaultSessionError(err, 'sign out'));
    }
    try {
      // Also disconnect the apple_signin vault record so it no longer shows
      // as connected. Deletes all Apple accounts for this user.
      if (!usesContainerVaultAuthority()) {
        const svc = getIntegrationService();
        const appleAccounts = await svc.getAccounts('apple_signin');
        for (const acc of appleAccounts) {
          await svc.deleteAccount('apple_signin', acc.account_id);
        }
      }
    } catch (err) {
      console.warn('[SullaCloudAuth] Failed to clear apple_signin accounts:', err);
    }
    try {
      await getDesktopRelayClient().setPairedUserId('');
    } catch { /* ignore */ }
    try {
      const { stopCloudServices } = await import('./cloud/cloudLifecycle');
      await stopCloudServices();
      // Approved browsers/phones belong to the signed-out account.
      const { ApprovedClients } = await import('./cloud/approvedClients');
      ApprovedClients.removeAll();
    } catch (err) {
      console.warn('[SullaCloudAuth] Failed to stop cloud services:', err);
    }
    DevicesCloudApi.stopHeartbeat();
    console.log('[SullaCloudAuth] Signed out');
    return buildStatus();
  });

  // Auto-pair relay on startup if we have a signed-in session.
  //
  // This needs to be resilient to a DB that isn't ready yet. On a fresh app
  // launch the Sulla Postgres container can take 30-60s to come up while
  // The runtime provisions the VM and docker compose brings up the service, so
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
  const lifecycle = getServiceLifecycleManager();
  let restoreWakeVersion = 0;
  let wakeRestore: (() => void) | undefined;
  const signalRestore = () => {
    restoreWakeVersion++;
    wakeRestore?.();
    wakeRestore = undefined;
  };
  wakeStartupRestore = signalRestore;
  const onVaultState = (unlocked: boolean) => { if (unlocked) signalRestore() };
  const onServiceReady = (name: string) => { if (name === 'vault') signalRestore() };

  lifecycle.on('vault:state', onVaultState);
  lifecycle.on('service:ready', onServiceReady);

  (async() => {
    const RETRY_BASE_MS  = 2_000;
    const RETRY_MAX_MS   = 60_000;
    const RETRY_GIVEUP_MS = 10 * 60_000;
    const startedAt = Date.now();
    let delay = RETRY_BASE_MS;

    const isTransient = (err: any): boolean => {
      if (err instanceof VaultNotReadyError) return true;
      const code = err?.code ?? err?.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNRESET') return true;
      const msg = String(err?.message || err || '').toLowerCase();
      return /econnrefused|etimedout|enotfound|econnreset|connect.*failed|pool.*shutting down|database.*not ready/.test(msg);
    };

    while (true) {
      const attemptWakeVersion = restoreWakeVersion;
      try {
        const session = await loadSessionIdentityForRestore();
        if (session) {
          await getDesktopRelayClient().setPairedUserId(session.userId);
          // Always connected while signed in: registration, heartbeat,
          // secure channel, and whichever syncs the owner opted into.
          try {
            const { startCloudServices } = await import('./cloud/cloudLifecycle');
            await startCloudServices();
          } catch (err) {
            console.warn('[SullaCloudAuth] Failed to start cloud services on restore:', err);
            throw new VaultNotReadyError(`cloud services unavailable: ${ (err as Error)?.message || err }`);
          }
          console.log(`[SullaCloudAuth] Restored session: user=${ session.userId }`);
        } else {
          console.log('[SullaCloudAuth] Startup restore: no signed-in session');
        }
        // Success (either a session was restored or none exists) — stop retrying.
        return;
      } catch (err) {
        // A locked vault waits for the owner to unlock it, however long that takes.
        const giveUp = !(err instanceof VaultNotReadyError) && (Date.now() - startedAt) >= RETRY_GIVEUP_MS;
        if (!isTransient(err) || giveUp) {
          console.warn('[SullaCloudAuth] Startup restore failed (giving up):', err);
          startupAdoptionError = `Sulla Cloud restore stopped: ${ (err as Error)?.message || err }`;
          return;
        }
        console.log(`[SullaCloudAuth] Startup restore not ready yet (${ (err as Error)?.message || err }); retrying in ${ delay }ms or on vault readiness`);
        if (restoreWakeVersion === attemptWakeVersion) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (wakeRestore === wake) wakeRestore = undefined;
              resolve();
            }, delay);
            const wake = () => {
              clearTimeout(timer);
              resolve();
            };
            wakeRestore = wake;
            // Close the event/listener registration gap.
            if (restoreWakeVersion !== attemptWakeVersion) wake();
          });
        }
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  })().finally(() => {
    if (wakeStartupRestore === signalRestore) wakeStartupRestore = undefined;
    lifecycle.off('vault:state', onVaultState);
    lifecycle.off('service:ready', onServiceReady);
  });
}
