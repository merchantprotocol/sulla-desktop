// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
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
let scheduleFlush: (() => void) | undefined;

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
  const key = keyFor(entry);
  const previous = pending.get(key);
  if (previous) clearValues(previous.values);
  pending.set(key, {
    integrationId: entry.integrationId,
    accountId:     entry.accountId,
    values:        { ...entry.values },
    activate:      entry.activate,
  });
  if (vaultUnlocked) scheduleFlush?.();
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
  if (usesContainerVaultAuthority() && entry.integrationId === 'sulla-cloud') {
    const client = getConfiguredApprovalClient();
    if (!client) throw new Error('Desktop vault session service is unavailable');
    await client.adoptSullaCloudSession({
      userId:             entry.values.user_id,
      activeContractorId: entry.values.active_contractor_id,
      contractors:        JSON.parse(entry.values.contractors_json || '[]'),
      accessToken:        entry.values.access_token,
      refreshToken:       entry.values.refresh_token,
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
    for (const [key, entry] of [...pending.entries()]) {
      try {
        await writeEntry(entry);
        if (pending.get(key) !== entry) continue;
        pending.delete(key);
        clearValues(entry.values);
        flushed.push(entry.integrationId);
      } catch {
        failed.push(entry.integrationId);
      }
    }
    return { flushed: [...new Set(flushed)], failed: [...new Set(failed)] };
  })().finally(() => { flushRun = undefined });
  return flushRun;
}

export function startPendingCredentialFlush(): void {
  if (hooksStarted) return;
  hooksStarted = true;
  const lifecycle = getServiceLifecycleManager();
  const schedule = () => {
    if (!pending.size || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void flushPendingCredentials().then(result => {
        if (result.failed.length) schedule();
      });
    }, 1_000);
  };
  scheduleFlush = schedule;
  lifecycle.on('vault:state', (unlocked: boolean) => {
    vaultUnlocked = unlocked;
    if (unlocked) schedule();
  });
  lifecycle.on('service:ready', (name: string) => { if (name === 'vault' && vaultUnlocked) schedule() });
}
