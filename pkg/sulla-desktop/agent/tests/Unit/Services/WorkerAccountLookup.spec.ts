// SPDX-License-Identifier: GPL-2.0-or-later
// Worker account lookups go through the real IntegrationService, ClaudeCredentialResolver and
// LocalVaultBrokerClient. Only the vault transport and service identity are injected, so every
// failure below has the exact shape production sees.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  behavior: {} as Record<string, Array<'ok' | (() => Response | never)>>,
  identity: [] as Array<'ok' | Error>,
  calls: {} as Record<string, number>,
  active: { codex: 'codex-subscription', grok: 'oauth', 'claude-code': 'oauth' } as Record<string, string>,
  accounts: null as null | Record<string, string[]>,
  connected: {} as Record<string, boolean>,
  workspaceId: null as string | null,
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: vi.fn() } }));
vi.mock('../../../nodes/ThreadStateStore', () => ({ saveThreadState: vi.fn() }));
vi.mock('../../../languagemodels/modelRouter', () => ({ modelRouter: {
  providerInfo: async() => [
    { id: 'codex', connected: true, models: [{ id: 'gpt-6-luna', efforts: [{ id: 'max' }] }] },
    { id: 'grok', connected: true, models: [{ id: 'grok-4.6' }] },
    { id: 'claude-code', connected: true, models: [{ id: 'claude-opus-5-5' }] },
  ],
  getEditableState: async() => ({ neverUse: [] }),
} }));

import { configuredVaultBrokerProvider, LocalVaultBrokerClient } from '../../../../vault-broker';
import { WorkerCatalogUnavailable } from '../../../languagemodels/workerModelBindings';
import { InfrastructureFailure } from '../../../languagemodels/providerRecovery';
import { claudeCredentialResolver } from '../../../languagemodels/credentials/ClaudeCredentialResolver';
import { WorkerModelRoutingService } from '../../../services/WorkerModelRouting';
import { getIntegrationService } from '../../../services/IntegrationService';

const codex = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
const grok = { provider: 'grok', model: 'grok-4.6' };
const claude = { provider: 'claude-code', model: 'claude-opus-5-5' };
const connections = { codex: 'codex-subscription', grok: 'oauth', 'claude-code': 'oauth' };
const route = (candidates: any[]): any => ({ version: 1, slug: 'reviewer', agentId: 'reviewer-id', revision: 2, selected: 0, connections: { ...connections }, candidates });

/** Exact vault HTTP error bodies (LocalVaultErrorResponse) that LocalVaultBrokerClient turns into VaultBrokerError. */
const vaultError = (status: number, error: string, extra: Record<string, unknown> = {}) => () => Response.json({ error, message: `${ error } from vault`, ...extra }, { status });
/** Node fetch rejects every connection-level failure this way. */
const nodeFetchFailure = () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:30443'), { code: 'ECONNREFUSED' }) }) };
/** Electron session.fetch (the Desktop transport) rejects with the Chromium net error. */
const electronNetFailure = () => { throw new Error('net::ERR_CONNECTION_REFUSED') };

function metadata(integrationId: string): Response {
  const ids = f.accounts?.[integrationId] ?? [f.active[integrationId]];
  const properties = f.workspaceId ? { workspace_id: f.workspaceId } : {};
  return Response.json({
    integrationId,
    activeAccountId: ids.length ? f.active[integrationId] : undefined,
    accounts: ids.map(accountId => ({ accountId, label: accountId, connected: f.connected[integrationId] ?? true, credentialRequired: true, active: accountId === f.active[integrationId], revision: 1, properties })),
  });
}

async function transport(input: string): Promise<Response> {
  const integrationId = decodeURIComponent(/\/v1\/broker\/integrations\/([^/]+)\/metadata/.exec(new URL(input).pathname)?.[1] ?? '');
  f.calls[integrationId] = (f.calls[integrationId] ?? 0) + 1;
  const queue = f.behavior[integrationId] ?? [];
  const next = queue.length > 1 ? queue.shift()! : queue[0] ?? 'ok';
  return next === 'ok' ? metadata(integrationId) : next();
}

async function identity() {
  const next = f.identity.length > 1 ? f.identity.shift()! : f.identity[0] ?? 'ok';
  if (next !== 'ok') throw next;
  return { serviceId: 'sulla-tools', serviceToken: 'test-service-token' };
}

beforeEach(() => {
  f.behavior = {}; f.identity = []; f.calls = {}; f.accounts = null; f.connected = {}; f.workspaceId = null;
  f.active = { codex: 'codex-subscription', grok: 'oauth', 'claude-code': 'oauth' };
  configuredVaultBrokerProvider.configureCredentialBroker(new LocalVaultBrokerClient('https://127.0.0.1:30443', identity, transport));
});
afterEach(() => { configuredVaultBrokerProvider.configureCredentialBroker(null); vi.restoreAllMocks() });

describe('worker account lookup through the real vault broker path', () => {
  it.each([
    ['vault database unavailable (503)', () => { f.behavior.codex = [vaultError(503, 'database_unavailable'), 'ok'] }],
    ['vault unavailable (503)', () => { f.behavior.codex = [vaultError(503, 'vault_unavailable'), 'ok'] }],
    ['retryable upstream failure', () => { f.behavior.codex = [vaultError(502, 'upstream_failed', { retryable: true, reason: 'connect_ECONNREFUSED' }), 'ok'] }],
    ['vault locked (423)', () => { f.behavior.codex = [vaultError(423, 'vault_locked'), 'ok'] }],
    ['Node fetch transport failure', () => { f.behavior.codex = [nodeFetchFailure, 'ok'] }],
    ['Electron net transport failure', () => { f.behavior.codex = [electronNetFailure, 'ok'] }],
    ['vault still starting (no service identity yet)', () => { f.identity = [new Error('Sulla is still starting its password vault. Wait for startup to finish, then try again.'), 'ok'] }],
  ])('waits through %s and returns the original approved route, not a fallback', async(_label, arrange) => {
    arrange();
    const original = route([codex, grok]);
    const resolved = await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(original);
    expect(resolved).toEqual([codex, grok]);
    expect(original.selected).toBe(0);
    expect(original.connections).toEqual(connections);
  });

  it('waits when the Claude credential authority answers unavailable, then resumes Claude', async() => {
    f.behavior['claude-code'] = [vaultError(503, 'database_unavailable'), vaultError(503, 'database_unavailable'), 'ok'];
    const resolved = await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([claude, codex]));
    expect(resolved).toEqual([claude, codex]);
  });

  it('stops cleanly during the bounded account wait without substituting the fallback', async() => {
    f.behavior.codex = [nodeFetchFailure];
    const original = route([codex, grok]);
    const stop = new AbortController();
    const waiting = new WorkerModelRoutingService({ budgetMs: 60_000, pollMs: 60_000 }).resolveRoute(original, stop.signal);
    setTimeout(() => stop.abort(new Error('stopped by owner')), 5);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(original.selected).toBe(0);
    expect(f.calls.grok ?? 0).toBe(0);
  });

  it('reports a still-unreadable account as retryable infrastructure once the bounded wait ends', async() => {
    f.behavior.codex = [vaultError(503, 'database_unavailable')];
    const error = await new WorkerModelRoutingService({ budgetMs: 20, pollMs: 1 }).resolveRoute(route([codex, grok])).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkerCatalogUnavailable);
    expect((error as Error).message).not.toContain('approved account');
  });

  it('keeps a healthy approved primary when a later fallback lookup fails, and reports the omission', async() => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const routing = new WorkerModelRoutingService({ budgetMs: 60_000, pollMs: 60_000 });
    for (const failure of [vaultError(503, 'database_unavailable'), nodeFetchFailure, vaultError(400, 'invalid_operation')]) {
      warn.mockClear();
      f.behavior.grok = [failure];
      expect(await routing.resolveRoute(route([codex, grok, claude]))).toEqual([codex, claude]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[WorkerModelRouting] Omitting fallback grok/grok-4.6'));
    }
  });

  it('skips only to an approved fallback when the account really changed or was removed', async() => {
    f.active.codex = 'other-subscription';
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([codex, grok]))).toEqual([grok]);
    expect(f.calls.codex).toBe(1);

    f.calls = {}; f.active.codex = 'codex-subscription'; f.accounts = { codex: [] };
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([codex, grok]))).toEqual([grok]);
    expect(f.calls.codex).toBe(1);

    f.calls = {}; f.accounts = null; f.behavior.codex = [vaultError(404, 'not_found')];
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([codex, grok]))).toEqual([grok]);
    expect(f.calls.codex).toBe(1);
  });

  it('does not fall back to Grok API-key billing and fails when no approved candidate remains', async() => {
    f.active.grok = 'default';
    f.accounts = { grok: ['default'] };
    await expect(new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([grok])))
      .rejects.toThrow('No configured worker subscription still matches its approved account');
    // One lookup attempt (active account + account list), never retried.
    expect(f.calls.grok).toBe(2);
  });

  it('propagates an unknown primary lookup failure once instead of calling it an owner change', async() => {
    for (const failure of [vaultError(400, 'invalid_operation'), vaultError(401, 'invalid_service_identity')]) {
      f.calls = {}; f.behavior.codex = [failure];
      const error = await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([codex, grok])).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ name: 'VaultBrokerError' });
      expect(error).not.toBeInstanceOf(InfrastructureFailure);
      expect(f.calls.codex).toBe(1);
      expect(f.calls.grok ?? 0).toBe(0);
    }
  });

  it('waits when only the Grok account-list read fails, instead of calling it a billing refusal or falling back', async() => {
    for (const failure of [vaultError(503, 'database_unavailable'), nodeFetchFailure]) {
      // Lookup order is active account, then account list: only the list read fails once, then both recover.
      f.calls = {}; f.behavior.grok = ['ok', failure, 'ok'];
      const original = route([grok, codex]);
      expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(original)).toEqual([grok, codex]);
      expect(f.calls.grok).toBe(4);
      expect(original.selected).toBe(0);
    }
  });

  it('keeps the ordinary settings account list tolerant while the strict read reports the outage', async() => {
    f.behavior.grok = [vaultError(503, 'database_unavailable')];
    expect(await getIntegrationService().getAccounts('grok')).toEqual([]);
    await expect(getIntegrationService().getAccounts('grok', { strict: true })).rejects.toMatchObject({ name: 'VaultBrokerError', status: 503, code: 'database_unavailable' });
    f.behavior.grok = [];
    expect(await getIntegrationService().getAccounts('grok', { strict: true })).toEqual([expect.objectContaining({ account_id: 'oauth', connected: true, active: true })]);
  });

  it.each([
    ['account-list 503', () => { f.behavior['claude-code'] = [vaultError(503, 'database_unavailable'), 'ok'] }],
    ['account-list fetch failure', () => { f.behavior['claude-code'] = [nodeFetchFailure, 'ok'] }],
    ['account-list Electron net failure', () => { f.behavior['claude-code'] = [electronNetFailure, 'ok'] }],
    ['account-list vault locked', () => { f.behavior['claude-code'] = [vaultError(423, 'vault_locked'), 'ok'] }],
  ])('waits through a Claude %s and keeps the original Claude primary', async(_label, arrange) => {
    arrange();
    const original = route([claude, codex]);
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(original)).toEqual([claude, codex]);
    expect(original.selected).toBe(0);
    // The list read fails once. Recovery reads accounts, the active account, and workspace metadata.
    expect(f.calls['claude-code']).toBe(4);
    expect(f.calls.codex).toBe(1);
  });

  it('falls back promptly when no Claude vault account is configured', async() => {
    f.accounts = { 'claude-code': [] };
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([claude, codex]))).toEqual([codex]);
    expect(f.calls['claude-code']).toBe(2);
  });

  it('falls back promptly when Claude metadata is 404', async() => {
    f.behavior['claude-code'] = [vaultError(404, 'not_found')];
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([claude, grok]))).toEqual([grok]);
    expect(f.calls['claude-code']).toBe(1);
    expect(f.calls.grok).toBe(2);
  });

  it.each([
    [400, 'invalid_operation'],
    [401, 'invalid_service_identity'],
  ])('propagates Claude metadata %s once instead of retrying it or falling back', async(status, code) => {
    f.behavior['claude-code'] = [vaultError(status, code)];
    const error = await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([claude, codex])).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'VaultBrokerError', status, code });
    expect(error).not.toBeInstanceOf(InfrastructureFailure);
    expect(error).not.toBeInstanceOf(WorkerCatalogUnavailable);
    expect(f.calls['claude-code']).toBe(1);
    expect(f.calls.codex ?? 0).toBe(0);
  });

  it.each([
    [400, 'invalid_operation'],
    [401, 'invalid_service_identity'],
  ])('propagates a Claude workspace-metadata %s once after the account list succeeded', async(status, code) => {
    f.behavior['claude-code'] = ['ok', 'ok', vaultError(status, code)];
    const error = await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([claude, codex])).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'VaultBrokerError', status, code });
    expect(error).not.toBeInstanceOf(InfrastructureFailure);
    expect(error).not.toBeInstanceOf(WorkerCatalogUnavailable);
    expect(f.calls['claude-code']).toBe(3);
    expect(f.calls.codex ?? 0).toBe(0);
  });

  it('falls back promptly when Claude workspace metadata says the account is gone', async() => {
    f.behavior['claude-code'] = ['ok', 'ok', vaultError(404, 'not_found')];
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([claude, codex]))).toEqual([codex]);
    expect(f.calls['claude-code']).toBe(3);
  });

  it('waits through a Claude workspace-metadata 503 and keeps the original Claude primary', async() => {
    f.behavior['claude-code'] = ['ok', 'ok', vaultError(503, 'database_unavailable'), 'ok'];
    const original = route([claude, codex]);
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(original)).toEqual([claude, codex]);
    expect(original.selected).toBe(0);
    expect(f.calls['claude-code']).toBe(6);
  });

  it('stops the bounded Claude metadata wait without substituting the fallback', async() => {
    f.behavior['claude-code'] = [nodeFetchFailure];
    const original = route([claude, codex]);
    const stop = new AbortController();
    const waiting = new WorkerModelRoutingService({ budgetMs: 60_000, pollMs: 60_000 }).resolveRoute(original, stop.signal);
    setTimeout(() => stop.abort(new Error('stopped by owner')), 5);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(original.selected).toBe(0);
    expect(f.calls.codex ?? 0).toBe(0);
  });

  it('reports Claude metadata that stays unreadable as retryable infrastructure, not a missing account', async() => {
    f.behavior['claude-code'] = [vaultError(503, 'database_unavailable')];
    const error = await new WorkerModelRoutingService({ budgetMs: 20, pollMs: 1 }).resolveRoute(route([claude, codex])).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkerCatalogUnavailable);
    expect((error as Error).message).not.toContain('approved account');
  });

  it('refuses a disconnected Claude account without waiting, and falls back only when another approved candidate exists', async() => {
    f.connected['claude-code'] = false;
    const error = await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([claude])).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(InfrastructureFailure);
    expect(error).not.toBeInstanceOf(WorkerCatalogUnavailable);
    expect((error as Error).message).toContain('approved account');
    expect(f.calls['claude-code']).toBe(2);

    f.calls = {};
    expect(await new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 }).resolveRoute(route([claude, codex]))).toEqual([codex]);
    expect(f.calls['claude-code']).toBe(2);
  });

  it('still refuses Claude API-key billing and does not retry that refusal', async() => {
    f.active['claude-code'] = 'default';
    f.accounts = { 'claude-code': ['default'] };
    const routing = new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 });
    await expect(routing.subscriptionConnections([claude])).rejects.toThrow('This worker requires an existing Claude subscription connection.');
    expect(f.calls['claude-code']).toBe(3);
    f.calls = {};
    await expect(routing.resolveRoute(route([claude]))).rejects.toThrow('No configured worker subscription still matches its approved account');
    expect(f.calls['claude-code']).toBe(3);
    f.calls = {};
    expect(await routing.resolveRoute(route([claude, codex]))).toEqual([codex]);
    expect(f.calls['claude-code']).toBe(3);
  });

  it('keeps a healthy primary when a later Claude metadata lookup fails and redacts the real diagnostic', async() => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const routing = new WorkerModelRoutingService({ budgetMs: 60_000, pollMs: 60_000 });
    for (const failure of [vaultError(503, 'database_unavailable'), nodeFetchFailure]) {
      warn.mockClear();
      f.calls = {};
      f.behavior['claude-code'] = [failure];
      expect(await routing.resolveRoute(route([codex, claude, grok]))).toEqual([codex, grok]);
      const text = warn.mock.calls.map(call => String(call[0])).join('\n');
      expect(text).toContain('[WorkerModelRouting] Omitting fallback claude-code/claude-opus-5-5');
      expect(text).not.toContain('temporarily unavailable');
      expect(f.calls.grok).toBe(2);
    }
    warn.mockClear();
    f.calls = {};
    const secret = 'sk-testtokenvalue';
    f.behavior['claude-code'] = [vaultError(400, 'invalid_operation', { message: `rejected ${ secret }` })];
    expect(await routing.resolveRoute(route([codex, claude]))).toEqual([codex]);
    const text = warn.mock.calls.map(call => String(call[0])).join('\n');
    expect(text).toContain('[WorkerModelRouting] Omitting fallback claude-code/claude-opus-5-5');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(secret);
  });

  it('keeps the default Claude resolver tolerant, including execution, while strict metadata reports the outage', async() => {
    f.behavior['claude-code'] = [vaultError(503, 'database_unavailable')];
    const unavailable = { kind: 'none', accountId: null, source: 'vault-broker', unavailable: true };
    expect(await claudeCredentialResolver.resolve()).toEqual(unavailable);
    expect(await claudeCredentialResolver.resolve({ execution: true })).toEqual(unavailable);
    expect(await getIntegrationService().getAccounts('claude-code')).toEqual([]);
    await expect(claudeCredentialResolver.resolve({ strictMetadata: true })).rejects.toMatchObject({ name: 'VaultBrokerError', status: 503, code: 'database_unavailable' });
  });

  it('keeps the connected Claude workspace on strict metadata resolution without minting a credential', async() => {
    f.workspaceId = 'ws-1';
    const expected = { kind: 'oauth-capability', accountId: 'oauth', source: 'vault-broker', workspaceId: 'ws-1' };
    expect(await claudeCredentialResolver.resolve()).toEqual(expected);
    expect(await claudeCredentialResolver.resolve({ strictMetadata: true })).toEqual(expected);
  });
});
