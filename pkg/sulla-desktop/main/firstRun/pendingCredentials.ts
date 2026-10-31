// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Electron from 'electron';

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import { getFirstRunState, updateFirstRunState } from '@pkg/main/firstRun/firstRunState';
import { getConfiguredApprovalClient, usesContainerVaultAuthority } from '@pkg/vault-broker';

export interface PendingCredential {
  integrationId: string;
  accountId: string;
  values: Record<string, string>;
  activate?: boolean;
}

const pending = new Map<string, PendingCredential>();
let flushRun: Promise<{ flushed: string[]; failed: string[] }> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let hooksStarted = false;
let vaultUnlocked = false;
let vaultReady = false;
let retryDelayMs = 1_000;
let scheduleFlush: (() => void) | undefined;

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

export function queuePendingCredential(entry: PendingCredential): void {
  firstRunTrace('pending', 'sign-in held in memory until the vault is ready', {
    integrationId: entry.integrationId, accountId: entry.accountId, fields: Object.keys(entry.values), vaultUnlocked, vaultReady,
  });
  if (entry.integrationId === 'sulla-cloud') {
    for (const [candidateKey, candidate] of pending) {
      if (candidate.integrationId !== 'sulla-cloud') continue;
      pending.delete(candidateKey);
      clearValues(candidate.values);
    }
  }
  const key = keyFor(entry);
  const previous = pending.get(key);
  if (previous) clearValues(previous.values);
  pending.set(key, {
    integrationId: entry.integrationId,
    accountId:     entry.accountId,
    values:        { ...entry.values },
    activate:      entry.activate,
  });
  void clearModelListCaches();
  if (vaultUnlocked && vaultReady) scheduleFlush?.();
}

export function clearPendingCredential(integrationId: string): void {
  for (const [key, entry] of pending) {
    if (entry.integrationId !== integrationId) continue;
    pending.delete(key);
    clearValues(entry.values);
  }
}

export function hasPendingCredential(integrationId: string): boolean {
  return [...pending.values()].some(entry => entry.integrationId === integrationId);
}

export function pendingIntegrationIds(): string[] {
  return [...new Set([...pending.values()].map(entry => entry.integrationId))];
}

/** Main-process-only read used while the vault copy is still pending. */
export function getPendingCredential(integrationId: string): PendingCredential | undefined {
  return [...pending.values()].find(candidate => candidate.integrationId === integrationId);
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
    const client = getConfiguredApprovalClient();
    if (!client) throw new Error('Desktop vault session service is unavailable');
    await client.importIntegrationAccount(entry.integrationId, {
      accountId: entry.accountId,
      label: entry.values.account_label,
      values: entry.values,
      active: entry.activate !== false,
      connected: entry.activate !== false,
    });
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

export async function flushPendingCredentials(): Promise<{ flushed: string[]; failed: string[] }> {
  if (flushRun) return flushRun;
  flushRun = (async() => {
    const flushed: string[] = [];
    const failed: string[] = [];
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
          firstRunTrace('pending', 'sign-in saved into the vault', { integrationId: entry.integrationId, accountId: entry.accountId });
          if (pending.get(key) !== entry) continue;
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
        }
      }
      if (!madeProgress) break;
    }
    if (flushed.length) await clearModelListCaches();
    return { flushed: [...new Set(flushed)], failed: [...new Set(failed)] };
  })().finally(() => { flushRun = undefined });
  return flushRun;
}

export function startPendingCredentialFlush(): void {
  if (hooksStarted) return;
  hooksStarted = true;
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
