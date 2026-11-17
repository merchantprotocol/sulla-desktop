// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * First-run credential holds and sign-out. The real pendingCredentials module runs; Electron, the vault broker,
 * the encrypted staging table and the service lifecycle are fakes. Module state is reset for every test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  const vaultWrites: Array<{ integrationId: string; accountId: string; values: Record<string, string> }> = [];
  const stagedWrites: Array<{ integrationId: string; accountId: string; values: Record<string, string>; cloudUserId?: string }> = [];
  const stagedRows: Array<{ integrationId: string; accountId: string; values: Record<string, string>; cloudUserId?: string }> = [];
  const stagedDeleteAll = { count: 0 };
  const lifecycle = {
    unlocked: true,
    ready: true,
    listeners: new Map<string, Array<(...args: any[]) => void>>(),
  };
  return { vaultWrites, stagedWrites, stagedRows, stagedDeleteAll, lifecycle, trace: vi.fn() };
});

vi.mock('electron', () => ({ default: { app: { isPackaged: true }, BrowserWindow: { getAllWindows: () => [] } } }));
vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService: () => ({ setMultipleValues: vi.fn(), setConnectionStatus: vi.fn() }) }));
vi.mock('@pkg/agent/services/ServiceLifecycleManager', () => ({
  getServiceLifecycleManager: () => ({
    isVaultUnlocked: () => env.lifecycle.unlocked,
    serviceStatuses: () => [{ name: 'vault', status: env.lifecycle.ready ? 'ready' : 'stopped' }],
    on: (event: string, listener: (...args: any[]) => void) => {
      const list = env.lifecycle.listeners.get(event) ?? [];
      list.push(listener);
      env.lifecycle.listeners.set(event, list);
    },
  }),
}));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: env.trace }));
vi.mock('@pkg/main/firstRun/firstRunState', () => ({ getFirstRunState: () => ({ choices: {} }), updateFirstRunState: vi.fn() }));
vi.mock('@pkg/main/integrationSaveFailure', () => ({ classifyIntegrationSaveFailure: () => ({ kind: 'unknown' }) }));
vi.mock('@pkg/main/cloud/session/DesktopCloudSessionRefreshers', () => ({
  PendingCloudSessionRefresher: class { refreshIfExpiring = vi.fn(async() => undefined); },
}));
vi.mock('@pkg/main/cloud/account/ElectronCloudAccountTransport', () => ({
  ElectronCloudAccountTransport: class { withSingleAttemptRefresh = vi.fn(() => ({})); },
}));
vi.mock('@pkg/main/cloud/device/SessionBindSigner', () => ({ SessionBindSigner: { forDesktop: () => ({}) } }));
vi.mock('@pkg/vault-broker', () => ({
  usesContainerVaultAuthority: () => true,
  configuredVaultBrokerProvider: { getConfiguredApprovalClient: () => ({ adoptSullaCloudSession: vi.fn(async() => undefined) }) },
}));
vi.mock('@pkg/agent/services/oauth/custody/promote', () => ({
  promoteMemoryCredentialToVault: vi.fn(async(entry: { integrationId: string; accountId: string; values: Record<string, string> }) => {
    env.vaultWrites.push({ integrationId: entry.integrationId, accountId: entry.accountId, values: { ...entry.values } });
  }),
}));
vi.mock('@pkg/main/firstRun/firstRunCredentialStore', () => ({
  storeFirstRunCredential: vi.fn(async(entry: { integrationId: string; accountId: string; values: Record<string, string>; cloudUserId?: string }) => {
    env.stagedWrites.push({ ...entry, values: { ...entry.values } });
  }),
  loadFirstRunCredentials: vi.fn(async() => env.stagedRows.map(row => ({ ...row, values: { ...row.values } }))),
  deleteFirstRunCredential: vi.fn(async() => undefined),
  deleteFirstRunCredentialsForIntegration: vi.fn(async() => undefined),
  deleteAllFirstRunCredentials: vi.fn(async() => { env.stagedDeleteAll.count++; env.stagedRows.length = 0; }),
}));
vi.mock('@pkg/main/sullaCloudAuth', () => ({ signalSullaCloudStartupRestore: vi.fn() }));
vi.mock('@pkg/agent/services/brokeredModelList', () => ({ clearBrokeredModelListCache: vi.fn() }));
vi.mock('@pkg/agent/languagemodels/codexModelCatalog', () => ({ clearCodexModelCatalogCache: vi.fn() }));
vi.mock('@pkg/agent/languagemodels/claudeModelCatalog', () => ({ clearClaudeModelCatalogCache: vi.fn() }));

type Module = typeof import('@pkg/main/firstRun/pendingCredentials');

let mod: Module;

async function freshModule(): Promise<Module> {
  vi.resetModules();
  return import('@pkg/main/firstRun/pendingCredentials');
}

function cloudSession(userId: string) {
  return {
    integrationId: 'sulla-cloud',
    accountId:     userId,
    activate:      true,
    values:        { access_token: `access-${ userId }`, refresh_token: `refresh-${ userId }`, user_id: userId, active_contractor_id: 'c1', contractors_json: '[]' },
  };
}

function notionFor(accountId: string) {
  return { integrationId: 'notion', accountId, values: { api_key: `secret-${ accountId }` }, activate: true };
}

describe('first-run credentials at sign-out', () => {
  beforeEach(async() => {
    env.vaultWrites.length = 0;
    env.stagedWrites.length = 0;
    env.stagedRows.length = 0;
    env.stagedDeleteAll.count = 0;
    env.lifecycle.listeners.clear();
    env.lifecycle.unlocked = true;
    env.lifecycle.ready = true;
    mod = await freshModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sign-out clears every integration\'s pending and unsynced entry, not only sulla-cloud', async() => {
    // risk: credential leak — account A's third-party keys stayed in memory after sign-out
    await mod.queuePendingCredential(cloudSession('acct-A'));
    await mod.queuePendingCredential(notionFor('acct-A'));
    expect(mod.pendingIntegrationIds().sort()).toEqual(['notion', 'sulla-cloud']);

    await mod.clearAllPendingCredentials();

    expect(mod.pendingIntegrationIds()).toEqual([]);
    expect(mod.hasPendingCredential('notion')).toBe(false);
    expect(mod.getPendingCredential('sulla-cloud')).toBeUndefined();
    const result = await mod.flushPendingCredentials();
    expect(result).toEqual({ flushed: [], failed: [], failures: {} });
    expect(env.vaultWrites).toEqual([]);
  });

  it('sign-out overwrites secret bytes and empties the staged copy it was holding', async() => {
    // risk: credential leak — secret bytes left readable in memory after sign-out
    const secretBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const values = { token: 'x', raw: secretBytes } as unknown as Record<string, string>;
    await mod.queuePendingCredential({ integrationId: 'custom', accountId: 'acct-A', values });

    await mod.clearAllPendingCredentials();

    expect([...secretBytes]).toEqual([0, 0, 0, 0, 0]);
    expect(mod.hasPendingCredential('custom')).toBe(false);
  });

  it('sign-out empties the encrypted staging table before anything is staged again', async() => {
    // risk: credential leak — rows from the signed-out account reload into memory on the next durable sync
    env.stagedRows.push({ integrationId: 'notion', accountId: 'acct-A', values: { api_key: 'old' } });
    await mod.queuePendingCredential(cloudSession('acct-A'));
    await mod.clearAllPendingCredentials();

    await mod.queuePendingCredential(cloudSession('acct-B'));
    await vi.waitFor(() => expect(env.stagedRows).toEqual([]));
    expect(mod.pendingIntegrationIds()).toEqual(['sulla-cloud']);
  });

  it('sign-out stops the scheduled flush retry', async() => {
    // risk: credential leak — a retry timer armed before sign-out writes the signed-out account's keys later
    vi.useFakeTimers();
    mod.startPendingCredentialFlush();
    await mod.queuePendingCredential(notionFor('acct-A'));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await mod.clearAllPendingCredentials();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(env.vaultWrites).toEqual([]);
  });

  it('an entry captured under account A is never flushed after account B signs in', async() => {
    // risk: money/credential leak — account A's keys written into account B's vault
    await mod.queuePendingCredential(cloudSession('acct-A'));
    await mod.queuePendingCredential(notionFor('acct-A'));

    // Account B signs in without a sign-out in between.
    await mod.queuePendingCredential(cloudSession('acct-B'));
    const result = await mod.flushPendingCredentials();

    expect(env.vaultWrites.map(write => `${ write.integrationId }:${ write.accountId }`)).not.toContain('notion:acct-A');
    expect(env.vaultWrites.filter(write => write.integrationId === 'notion')).toEqual([]);
    expect(result.flushed).toEqual(['sulla-cloud']);
  });

  it('a staged row from account A is dropped on load when account B is signed in', async() => {
    // risk: credential leak — a row staged under account A reloads after sign-in as B and flushes into B's vault
    await mod.queuePendingCredential(cloudSession('acct-B'));
    env.stagedRows.push({ integrationId: 'notion', accountId: 'acct-A', values: { api_key: 'secret-A' }, cloudUserId: 'acct-A' });

    await mod.flushPendingCredentials();
    await vi.waitFor(() => expect(env.trace).toHaveBeenCalledWith('pending', 'loaded encrypted sign-ins from runtime Postgres', expect.objectContaining({ foreign: 1 })));

    expect(env.vaultWrites.filter(write => write.integrationId === 'notion')).toEqual([]);
    expect(mod.getPendingCredential('notion')).toBeUndefined();
  });

  it('single-account first run still flushes every integration to the vault', async() => {
    // risk: money — a first-run sign-in that never reaches the vault leaves the user unable to use the integration
    await mod.queuePendingCredential(notionFor('acct-A'));
    await mod.queuePendingCredential(cloudSession('acct-A'));

    const result = await mod.flushPendingCredentials();

    expect(result.failed).toEqual([]);
    expect(result.flushed.sort()).toEqual(['notion', 'sulla-cloud']);
    // The Cloud session goes through the vault adopt call, not the generic promote path, so only notion appears here.
    expect(env.vaultWrites.map(write => `${ write.integrationId }:${ write.accountId }`)).toEqual(['notion:acct-A']);
    expect(mod.pendingIntegrationIds()).toEqual([]);
  });

  it('a hold queued before any account signed in still flushes once the account signs in', async() => {
    // risk: money — first-run integrations connected before the Cloud sign-in must not be lost
    await mod.queuePendingCredential(notionFor('oauth'));
    await mod.queuePendingCredential(cloudSession('acct-A'));

    const result = await mod.flushPendingCredentials();

    expect(result.flushed.sort()).toEqual(['notion', 'sulla-cloud']);
    expect(env.vaultWrites.find(write => write.integrationId === 'notion')?.values).toEqual({ api_key: 'secret-oauth' });
  });
});
