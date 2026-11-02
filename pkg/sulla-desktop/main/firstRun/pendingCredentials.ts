// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Electron from 'electron';

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import { getFirstRunState, updateFirstRunState } from '@pkg/main/firstRun/firstRunState';
import { classifyIntegrationSaveFailure, type IntegrationSaveFailure } from '@pkg/main/integrationSaveFailure';
import { getConfiguredApprovalClient, usesContainerVaultAuthority } from '@pkg/vault-broker';
import { promoteMemoryCredentialToVault } from '@pkg/agent/services/oauth/custody/promote';
import {
  deleteFirstRunCredential,
  deleteFirstRunCredentialsForIntegration,
  loadFirstRunCredentials,
  storeFirstRunCredential,
} from '@pkg/main/firstRun/firstRunCredentialStore';

export interface PendingCredential {
  integrationId: string;
  accountId: string;
  values: Record<string, string>;
  activate?: boolean;
}

const pending = new Map<string, PendingCredential>();
export interface PendingCredentialFlushResult {
  flushed: string[];
  failed: string[];
  failures: Record<string, IntegrationSaveFailure>;
}

let flushRun: Promise<PendingCredentialFlushResult> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let hooksStarted = false;
let vaultUnlocked = false;
let vaultReady = false;
let retryDelayMs = 1_000;
let scheduleFlush: (() => void) | undefined;
let loadRun: Promise<void> | undefined;

class PendingSessionExpiredError extends Error {}

function returnToCloudSignIn(): void {
  const state = getFirstRunState();
  updateFirstRunState({
    step: 0,
    credentialsSaved: false,
    choices: { ...state.choices, accountLinked: false, accountChoice: undefined },
  });
  firstRunTrace('pending', 'pending Cloud session expired; returning to sign-in');
  for (const window of Electron.BrowserWindow.getAllWindows()) {
    window.webContents.send('sulla-cloud:first-run-session-expired', { message: 'Sign in again to finish setup.' });
    window.webContents.reload();
  }
}

async function clearModelListCaches(): Promise<void> {
  try {
    const [{ clearBrokeredModelListCache }, { clearCodexModelCatalogCache }, { clearClaudeModelCatalogCache }] = await Promise.all([
      import('@pkg/agent/services/brokeredModelList'),
      import('@pkg/agent/languagemodels/codexModelCatalog'),
      import('@pkg/agent/languagemodels/claudeModelCatalog'),
    ]);
    clearBrokeredModelListCache();
    clearCodexModelCatalogCache();
    clearClaudeModelCatalogCache();
  } catch (err) {
    console.warn('[pendingCredentials] Could not clear model-list caches:', err);
  }
}

function keyFor(entry: Pick<PendingCredential, 'integrationId' | 'accountId'>): string {
  return `${ entry.integrationId }\0${ entry.accountId }`;
}

function clearValues(values: Record<string, string>): void {
  for (const property of Object.keys(values)) {
    values[property] = '';
    delete values[property];
  }
}

export async function queuePendingCredential(entry: PendingCredential): Promise<void> {
  if (loadRun) await loadRun;
  firstRunTrace('pending', 'sign-in encrypted in runtime Postgres until the vault is ready', {
    integrationId: entry.integrationId, accountId: entry.accountId, fields: Object.keys(entry.values), vaultUnlocked, vaultReady,
  });
  if (entry.integrationId === 'sulla-cloud') {
    for (const [candidateKey, candidate] of pending) {
      if (candidate.integrationId !== 'sulla-cloud') continue;
      pending.delete(candidateKey);
      clearValues(candidate.values);
    }
    await deleteFirstRunCredentialsForIntegration(entry.integrationId);
  }
  const key = keyFor(entry);
  const previous = pending.get(key);
  if (previous) clearValues(previous.values);
  const durableEntry = {
    integrationId: entry.integrationId,
    accountId:     entry.accountId,
    values:        { ...entry.values },
    activate:      entry.activate,
  };
  await storeFirstRunCredential(durableEntry);
  pending.set(key, durableEntry);
  void clearModelListCaches();
  if (vaultUnlocked && vaultReady) scheduleFlush?.();
}

export async function clearPendingCredential(integrationId: string): Promise<void> {
  if (loadRun) await loadRun;
  for (const [key, entry] of pending) {
    if (entry.integrationId !== integrationId) continue;
    pending.delete(key);
    clearValues(entry.values);
  }
  await deleteFirstRunCredentialsForIntegration(integrationId);
}

export function hasPendingCredential(integrationId: string): boolean {
  return [...pending.values()].some(entry => entry.integrationId === integrationId);
}

export function pendingIntegrationIds(): string[] {
  return [...new Set([...pending.values()].map(entry => entry.integrationId))];
}

/** Main-process-only read used while the vault copy is still pending. */
export function getPendingCredential(integrationId: string, accountId?: string): PendingCredential | undefined {
  return [...pending.values()].find(candidate => candidate.integrationId === integrationId && (!accountId || candidate.accountId === accountId));
}

async function writeEntry(entry: PendingCredential): Promise<void> {
  if (!(Electron.app?.isPackaged ?? true) && process.env.SULLA_E2E === '1' && process.env.SULLA_E2E_VAULT_URL) {
    if (process.env.SULLA_E2E_VAULT === 'absent') throw new Error('Fake vault is absent');
    const response = await fetch(process.env.SULLA_E2E_VAULT_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ integrationId: entry.integrationId, accountId: entry.accountId, values: entry.values }),
    });
    if (!response.ok) throw new Error(`Fake vault returned ${ response.status }`);
    return;
  }
  if (usesContainerVaultAuthority() && entry.integrationId === 'sulla-cloud') {
    let accessToken = entry.values.access_token;
    let refreshToken = entry.values.refresh_token;
    try {
      const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] || '', 'base64url').toString('utf8')) as { exp?: number };
      if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1_000) + 120) {
        const response = await fetch('https://sulla-workers.merchantprotocol.workers.dev/auth/refresh', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }), signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 401 || response.status === 403) throw new PendingSessionExpiredError('Cloud session expired');
        if (!response.ok) throw new Error(`Cloud session refresh returned ${ response.status }`);
        const tokens = await response.json() as { accessToken?: string; refreshToken?: string };
        if (!tokens.accessToken) throw new Error('Cloud session refresh returned no access token');
        accessToken = tokens.accessToken;
        refreshToken = tokens.refreshToken || refreshToken;
        entry.values.access_token = accessToken;
        entry.values.refresh_token = refreshToken;
      }
    } catch (error) {
      if (error instanceof PendingSessionExpiredError) throw error;
      throw new Error(`Pending Cloud session needs refresh: ${ error instanceof Error ? error.message : String(error) }`);
    }
    const client = getConfiguredApprovalClient();
    if (!client) throw new Error('Desktop vault session service is unavailable');
    await client.adoptSullaCloudSession({
      userId:             entry.values.user_id,
      activeContractorId: entry.values.active_contractor_id,
      contractors:        JSON.parse(entry.values.contractors_json || '[]'),
      accessToken,
      refreshToken,
    });
    return;
  }

  if (usesContainerVaultAuthority()) {
    await promoteMemoryCredentialToVault(entry);
    return;
  }

  const service = getIntegrationService();
  await service.setMultipleValues(Object.entries(entry.values).map(([property, value]) => ({
    integration_id: entry.integrationId,
    account_id:     entry.accountId,
    property,
    value,
  })));
  if (entry.activate !== false) await service.setConnectionStatus(entry.integrationId, true, entry.accountId);
}

export async function flushPendingCredentials(): Promise<PendingCredentialFlushResult> {
  if (flushRun) return flushRun;
  flushRun = (async() => {
    const flushed: string[] = [];
    const failed: string[] = [];
    const failures: Record<string, IntegrationSaveFailure> = {};
    // Keep draining: a refresh or a concurrent sign-in may replace an entry
    // while an earlier snapshot is being written.
    while (true) {
      const snapshot = [...pending.entries()];
      if (!snapshot.length) break;
      let madeProgress = false;
      for (const [key, entry] of snapshot) {
        try {
          firstRunTrace('pending', 'saving sign-in into the vault', { integrationId: entry.integrationId, accountId: entry.accountId });
          await writeEntry(entry);
          // First run keeps Codex tokens only in this main-process map. Once
          // the vault accepts them, materialize the CLI file exactly once and
          // copy it into the guest before clearing the in-memory token set.
          if (entry.integrationId === 'codex') {
            const { prepareCodexAuthAfterExchange } = await import('@pkg/agent/util/codexAuthFile');
            const prepared = await prepareCodexAuthAfterExchange(entry.values, usesContainerVaultAuthority());
            firstRunTrace('codex', 'credentials prepared after vault flush', prepared);
          }
          firstRunTrace('pending', 'sign-in saved into the vault', { integrationId: entry.integrationId, accountId: entry.accountId });
          if (pending.get(key) !== entry) continue;
          // The vault write above is the durability handoff. Delete the
          // encrypted staging row only after that write (and any required
          // Codex preparation) has confirmed.
          await deleteFirstRunCredential(entry.integrationId, entry.accountId);
          pending.delete(key);
          clearValues(entry.values);
          flushed.push(entry.integrationId);
          madeProgress = true;
          if (entry.integrationId === 'sulla-cloud') {
            void import('@pkg/main/sullaCloudAuth').then(({ signalSullaCloudStartupRestore }) => signalSullaCloudStartupRestore());
          }
        } catch (error) {
          if (error instanceof PendingSessionExpiredError && entry.integrationId === 'sulla-cloud') {
            if (pending.get(key) === entry) pending.delete(key);
            clearValues(entry.values);
            returnToCloudSignIn();
            madeProgress = true;
            continue;
          }
          firstRunTrace('pending', 'saving sign-in into the vault failed; will retry', { integrationId: entry.integrationId, accountId: entry.accountId, error });
          failed.push(entry.integrationId);
          failures[entry.integrationId] = classifyIntegrationSaveFailure(error);
        }
      }
      if (!madeProgress) break;
    }
    if (flushed.length) await clearModelListCaches();
    return { flushed: [...new Set(flushed)], failed: [...new Set(failed)], failures };
  })().finally(() => { flushRun = undefined });
  return flushRun;
}

export function startPendingCredentialFlush(): void {
  if (hooksStarted) return;
  hooksStarted = true;
  loadRun = loadFirstRunCredentials().then(entries => {
    for (const entry of entries) pending.set(keyFor(entry), entry);
    firstRunTrace('pending', 'loaded encrypted sign-ins from runtime Postgres', {
      integrations: entries.map(entry => entry.integrationId),
    });
  }).catch(error => {
    firstRunTrace('pending', 'could not load encrypted sign-ins from runtime Postgres; will retry at next start', { error });
  }).finally(() => {
    loadRun = undefined;
    if (vaultUnlocked && vaultReady) scheduleFlush?.();
  });
  const lifecycle = getServiceLifecycleManager();
  vaultUnlocked = lifecycle.isVaultUnlocked();
  vaultReady = lifecycle.serviceStatuses().some(({ name, status }) => name === 'vault' && status === 'ready');
  const schedule = () => {
    if (loadRun || !pending.size || !vaultUnlocked || !vaultReady || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void flushPendingCredentials().then(result => {
        if (result.failed.length) {
          retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
          schedule();
        } else {
          retryDelayMs = 1_000;
        }
      });
    }, retryDelayMs);
  };
  scheduleFlush = schedule;
  lifecycle.on('vault:state', (unlocked: boolean) => {
    vaultUnlocked = unlocked;
    firstRunTrace('vault', unlocked ? 'vault unlocked (published)' : 'vault locked (published)', { pending: [...pending.values()].map(e => e.integrationId) });
    if (!unlocked && retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (unlocked) schedule();
  });
  lifecycle.on('service:ready', (name: string) => {
    if (name !== 'vault') return;
    vaultReady = true;
    firstRunTrace('vault', 'vault service ready', { vaultUnlocked, pending: [...pending.values()].map(e => e.integrationId) });
    if (vaultUnlocked) schedule();
  });
  lifecycle.on('service:stopped', (name: string) => {
    if (name === 'vault') vaultReady = false;
  });
  if (vaultUnlocked && vaultReady && !loadRun) schedule();
}
