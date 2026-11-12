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
import { PendingCloudSessionRefresher } from '@pkg/main/cloud/session/DesktopCloudSessionRefreshers';
import { ElectronCloudAccountTransport } from '@pkg/main/cloud/account/ElectronCloudAccountTransport';
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

// Runtime Postgres is NOT up during most of first run (the VM is still
// starting). Memory is the source of truth for the current process; the
// encrypted Postgres copy is written, reloaded and deleted in the background
// and retried until the database answers. No caller ever fails because
// Postgres is not reachable yet.
const unsyncedWrites = new Map<string, PendingCredential>();
const unsyncedDeletes = new Set<string>();
let durableLoaded = false;
let durableTimer: ReturnType<typeof setTimeout> | undefined;
let durableDelayMs = 2_000;
let durableRun: Promise<boolean> | undefined;

function deleteKey(integrationId: string, accountId = '*'): string {
  return `${ integrationId }\0${ accountId }`;
}

async function runDurableSync(): Promise<boolean> {
  if (durableRun) return durableRun;
  durableRun = (async() => {
    try {
      if (!durableLoaded) {
        const rows = await loadFirstRunCredentials();
        let merged = 0;
        for (const row of rows) {
          const key = keyFor(row);
          if (pending.has(key) || unsyncedDeletes.has(key) || unsyncedDeletes.has(deleteKey(row.integrationId))) continue;
          pending.set(key, row);
          merged++;
        }
        durableLoaded = true;
        firstRunTrace('pending', 'loaded encrypted sign-ins from runtime Postgres', { status: 'success', integrations: rows.map(row => row.integrationId), merged });
      }
      for (const key of [...unsyncedDeletes]) {
        const [integrationId, accountId] = key.split('\0');
        if (accountId === '*') await deleteFirstRunCredentialsForIntegration(integrationId);
        else await deleteFirstRunCredential(integrationId, accountId);
        unsyncedDeletes.delete(key);
        firstRunTrace('pending', 'Postgres staging row deleted', { integrationId, accountId, status: 'success' });
      }
      for (const [key, entry] of [...unsyncedWrites]) {
        await storeFirstRunCredential(entry);
        if (unsyncedWrites.get(key) === entry) unsyncedWrites.delete(key);
        firstRunTrace('pending', 'Postgres custody write completed', { integrationId: entry.integrationId, accountId: entry.accountId, status: 'success' });
      }
      durableDelayMs = 2_000;
      return true;
    } catch (error) {
      firstRunTrace('pending', 'runtime Postgres not reachable yet; sign-ins stay in memory and the encrypted copy will retry', {
        status: 'postgres_unavailable', retryInMs: durableDelayMs, unsyncedWrites: unsyncedWrites.size, unsyncedDeletes: unsyncedDeletes.size, error,
      });
      return false;
    } finally {
      durableRun = undefined;
    }
  })();
  return durableRun;
}

function scheduleDurableSync(delayMs = 0): void {
  if (durableTimer) return;
  durableTimer = setTimeout(() => {
    durableTimer = undefined;
    void runDurableSync().then((ok) => {
      if (ok) {
        if (!durableLoaded || unsyncedWrites.size || unsyncedDeletes.size) scheduleDurableSync(durableDelayMs);
        else if (vaultUnlocked && vaultReady) scheduleFlush?.();
        return;
      }
      durableDelayMs = Math.min(durableDelayMs * 2, 60_000);
      scheduleDurableSync(durableDelayMs);
    });
  }, delayMs);
  durableTimer.unref?.();
}

class PendingSessionExpiredError extends Error {}

const pendingSessionRefresher = new PendingCloudSessionRefresher(
  // POST /auth/refresh {refreshToken}, one attempt, 20 s timeout (unchanged).
  new ElectronCloudAccountTransport().singleAttemptRefreshHttp,
  () => new PendingSessionExpiredError('Cloud session expired'),
);

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
  firstRunTrace('pending', 'sign-in held in memory; encrypted runtime Postgres copy queued until the vault is ready', {
    integrationId: entry.integrationId, accountId: entry.accountId, fields: Object.keys(entry.values), vaultUnlocked, vaultReady,
  });
  if (entry.integrationId === 'sulla-cloud') {
    for (const [candidateKey, candidate] of pending) {
      if (candidate.integrationId !== 'sulla-cloud') continue;
      pending.delete(candidateKey);
      unsyncedWrites.delete(candidateKey);
      clearValues(candidate.values);
    }
    unsyncedDeletes.add(deleteKey(entry.integrationId));
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
  pending.set(key, durableEntry);
  unsyncedDeletes.delete(key);
  unsyncedWrites.set(key, durableEntry);
  firstRunTrace('pending', 'custody write started', { integrationId: entry.integrationId, accountId: entry.accountId, status: 'started' });
  scheduleDurableSync();
  void clearModelListCaches();
  if (vaultUnlocked && vaultReady) scheduleFlush?.();
}

export async function clearPendingCredential(integrationId: string): Promise<void> {
  for (const [key, entry] of pending) {
    if (entry.integrationId !== integrationId) continue;
    pending.delete(key);
    unsyncedWrites.delete(key);
    clearValues(entry.values);
  }
  unsyncedDeletes.add(deleteKey(integrationId));
  scheduleDurableSync();
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
    await pendingSessionRefresher.refreshIfExpiring(entry);
    const accessToken = entry.values.access_token;
    const refreshToken = entry.values.refresh_token;
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
          firstRunTrace('pending', 'vault custody confirmed', { integrationId: entry.integrationId, accountId: entry.accountId, status: 'success' });
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
          unsyncedWrites.delete(key);
          unsyncedDeletes.add(deleteKey(entry.integrationId, entry.accountId));
          scheduleDurableSync();
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
  // Never block startup or the wizard on runtime Postgres: try once now and
  // keep retrying in the background until it answers.
  scheduleDurableSync();
  const lifecycle = getServiceLifecycleManager();
  vaultUnlocked = lifecycle.isVaultUnlocked();
  vaultReady = lifecycle.serviceStatuses().some(({ name, status }) => name === 'vault' && status === 'ready');
  const schedule = () => {
    if (!pending.size || !vaultUnlocked || !vaultReady || retryTimer) return;
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
    firstRunTrace('pending', 'vault flush retry scheduled', { status: 'scheduled', retryInMs: retryDelayMs, pending: pending.size });
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
  if (vaultUnlocked && vaultReady) schedule();
}
