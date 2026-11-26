// SPDX-License-Identifier: GPL-2.0-or-later
import { performance } from 'node:perf_hooks';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoopProviderResolution, LoopProviderResolutionError } from '../../../nodes/LoopProviderResolution';

const f = vi.hoisted(() => ({
  definition: { id: 'grok-agent-id', slug: 'grok-reviewer', source_kind: 'local', enabled: false },
  providers: [
    { id: 'grok', connected: true, models: [{ id: 'grok-4.6', efforts: [] }, { id: 'grok-4.5', efforts: [] }] },
    { id: 'codex', connected: true, models: [{ id: 'gpt-6-luna', efforts: [{ id: 'max' }] }] },
  ] as any[],
  settings: { neverUse: [], workerBindings: { sibling: { agentId: 'sibling-id', revision: 4, candidates: [{ provider: 'codex', model: 'gpt-6-luna' }] } } } as any,
  accounts: { grok: 'oauth', codex: 'codex-subscription' } as Record<string, string>,
  set: vi.fn(),
  outageCalls: 0,
  providerCalls: 0,
  lookupCalls: 0,
  nextLookupErrors: [] as unknown[],
  stickyLookupError: null as unknown,
  hangProviderInfo: false,
}));

vi.mock('../../../services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: async() => f.definition } }));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: () => ({
  getActiveAccountId: async(provider: string) => {
    f.lookupCalls += 1;
    const queued = f.nextLookupErrors.shift();
    if (queued) throw queued;
    if (f.stickyLookupError) throw f.stickyLookupError;
    return f.accounts[provider];
  },
  getAccounts: async(provider: string) => [{ integration_id: provider, account_id: f.accounts[provider], connected: f.accounts[provider] === 'oauth' || provider === 'codex' }],
}) }));
vi.mock('../../../languagemodels/credentials/ClaudeCredentialResolver', () => ({ claudeCredentialResolver: { resolve: vi.fn() } }));
vi.mock('../../../languagemodels/modelRouter', () => ({ modelRouter: {
  providerInfo: async() => {
    f.providerCalls++;
    if (f.hangProviderInfo) return new Promise(() => {});
    return f.providerCalls <= f.outageCalls ? f.providers.map((row: any) => ({ ...row, models: [] })) : structuredClone(f.providers);
  },
  getEditableState: async() => structuredClone(f.settings),
  set: async(patch: any) => { f.set(patch); f.settings = { ...f.settings, ...structuredClone(patch) }; return f.settings },
  addWorkerBindingIfAbsent: async(slug: string, binding: any) => {
    const existing = f.settings.workerBindings[slug];
    if (existing) {
      if (existing.agentId === binding.agentId) return false;
      throw new Error('A different agent already owns this worker mapping; it was preserved.');
    }
    f.set({ [slug]: binding });
    f.settings.workerBindings[slug] = structuredClone(binding);
    return true;
  },
  writeFilePublishedBinding: async(slug: string, agentId: string, expected: any, next: any) => {
    const existing = f.settings.workerBindings[slug];
    if (expected === null ? existing : existing?.revision !== expected.revision) throw new Error('changed while its file publication was applied');
    const revision = (expected?.revision ?? 0) + 1;
    const binding = { ...next, agentId, revision, filePublication: { ...next.filePublication, revision } };
    f.set({ [slug]: binding });
    f.settings.workerBindings[slug] = structuredClone(binding);
    return { editToken: binding.editToken, revision };
  },
  removeWorkerBindingIfOwned: async(slug: string, agentId: string) => {
    if (f.settings.workerBindings[slug]?.agentId !== agentId) return false;
    const workerBindings = { ...f.settings.workerBindings };
    delete workerBindings[slug];
    f.set({ workerBindings });
    f.settings.workerBindings = workerBindings;
    return true;
  },
} }));
vi.mock('../../../nodes/ThreadStateStore', () => ({ saveThreadState: vi.fn() }));

import { VaultBrokerError } from '../../../../vault-broker/VaultBrokerError';
import { WorkerCatalogUnavailable } from '../../../languagemodels/workerModelBindings';
import { WorkerModelRoutingService } from '../../../services/WorkerModelRouting';

const grok = { provider: 'grok', model: 'grok-4.6' };
const publication = { fileId: 'file-1', versionId: 'version-1' };

beforeEach(() => {
  f.definition = { id: 'grok-agent-id', slug: 'grok-reviewer', source_kind: 'local', enabled: false };
  f.providers = [
    { id: 'grok', connected: true, models: [{ id: 'grok-4.6', efforts: [] }, { id: 'grok-4.5', efforts: [] }] },
    { id: 'codex', connected: true, models: [{ id: 'gpt-6-luna', efforts: [{ id: 'max' }] }] },
  ];
  f.settings = { neverUse: [], workerBindings: { sibling: { agentId: 'sibling-id', revision: 4, candidates: [{ provider: 'codex', model: 'gpt-6-luna' }] } } };
  f.accounts = { grok: 'oauth', codex: 'codex-subscription' };
  f.set.mockReset();
  f.outageCalls = 0;
  f.providerCalls = 0;
  f.lookupCalls = 0;
  f.nextLookupErrors = [];
  f.stickyLookupError = null;
  f.hangProviderInfo = false;
});

describe('Grok subscription model mapping', () => {
  it('honors exact tier requests and enforces the account boundary for any overrides', async() => {
    const routing = new WorkerModelRoutingService({ budgetMs: 0, pollMs: 1 });
    const other = { ...grok, model: 'grok-4.5' };
    const binding = { agentId: f.definition.id, revision: 1, candidates: [grok, other], connections: { grok: 'oauth' },
      modelTiers: { version: 1, tiers: [{ candidates: [grok] }, { candidates: [other] }], allowLaunchOverride: 'listed' } };
    f.settings.workerBindings[f.definition.slug] = binding;
    const exact = await routing.newRoute(f.definition.slug, other);
    expect(exact).toMatchObject({ selected: 0, candidates: [other], candidateTiers: [2], requestedModel: other });
    await expect(routing.newRoute(f.definition.slug, { ...grok, model: 'missing' })).rejects.toThrow(/list/);
    binding.modelTiers.allowLaunchOverride = 'any';
    await expect(routing.newRoute(f.definition.slug, { provider: 'codex', model: 'gpt-6-luna' })).rejects.toThrow(/approved subscription/);
    await expect(routing.applyWorkflowRequest(exact!, grok)).rejects.toThrow(/chat/);
    expect((await routing.applyWorkflowRequest(exact!, other)).candidates).toEqual([other]);
    f.accounts.grok = 'default';
    await expect(routing.newRoute(f.definition.slug, other)).rejects.toThrow(/subscription/);
  });

  it('accepts only the connected Grok OAuth subscription and records its exact account id', async() => {
    const routing = new WorkerModelRoutingService();
    expect(await routing.validateSubscriptionCandidates([grok])).toEqual({ grok: 'oauth' });
    f.accounts.grok = 'default';
    await expect(routing.validateSubscriptionCandidates([grok])).rejects.toThrow('Grok OAuth subscription');
    expect(f.set).not.toHaveBeenCalled();
  });

  it('initializes the exact newly created definition once and preserves sibling mappings', async() => {
    const routing = new WorkerModelRoutingService();
    await routing.initializeBindingForDefinition('grok-reviewer', 'grok-agent-id', [grok]);
    expect(f.settings.workerBindings['grok-reviewer']).toMatchObject({
      agentId: 'grok-agent-id', revision: 1, connections: { grok: 'oauth' }, candidates: [grok],
    });
    expect(f.settings.workerBindings.sibling.agentId).toBe('sibling-id');
    const saved = structuredClone(f.settings.workerBindings['grok-reviewer']);
    await routing.initializeBindingForDefinition('grok-reviewer', 'grok-agent-id', [{ provider: 'grok', model: 'grok-4.5' }]);
    expect(f.settings.workerBindings['grok-reviewer']).toEqual(saved);
    expect(f.set).toHaveBeenCalledTimes(1);
  });

  it('prepares a published package route before its local definition exists and reports only a newly written mapping', async() => {
    const routing = new WorkerModelRoutingService();
    const created = await routing.reconcilePublishedPackageBinding('grok-pr-reviewer', 'agent-published-exact-id', { candidates: [grok] }, publication);
    expect(created).toEqual({ outcome: 'written', written: { editToken: f.settings.workerBindings['grok-pr-reviewer'].editToken, revision: 1 } });
    expect(f.settings.workerBindings['grok-pr-reviewer']).toMatchObject({ agentId: 'agent-published-exact-id', candidates: [grok], connections: { grok: 'oauth' }, filePublication: { ...publication, revision: 1 } });
    expect(f.set).toHaveBeenCalledTimes(1);
  });

  it('keeps the same agent\'s owner mapping on reactivation even when the package pin differs or Grok is offline', async() => {
    const owner = { editToken: 'owner-edit', agentId: 'agent-published-exact-id', revision: 3, connections: { codex: 'codex-subscription' }, candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }] };
    f.settings.workerBindings['grok-pr-reviewer'] = structuredClone(owner);
    f.providers = [{ id: 'grok', connected: false, models: [] }, { id: 'codex', connected: false, models: [] }];
    f.accounts.grok = 'default';
    const routing = new WorkerModelRoutingService();
    expect(await routing.reconcilePublishedPackageBinding('grok-pr-reviewer', 'agent-published-exact-id', { candidates: [grok] }, publication)).toMatchObject({ outcome: 'conflict', message: expect.stringContaining("owner's model mapping (codex/gpt-6-luna (max)) was kept") });
    expect(await routing.reconcilePublishedPackageBinding('grok-pr-reviewer', 'agent-published-exact-id', { candidates: [owner.candidates[0]] }, publication)).toEqual({ outcome: 'unchanged' });
    expect(f.settings.workerBindings['grok-pr-reviewer']).toEqual(owner);
    expect(f.set).not.toHaveBeenCalled();
  });

  it('still requires an exact live subscription model for a new package mapping and refuses another owner before writing', async() => {
    const routing = new WorkerModelRoutingService();
    f.providers = [{ id: 'grok', connected: true, models: [{ id: 'grok-4.5', efforts: [] }] }];
    await expect(routing.reconcilePublishedPackageBinding('grok-pr-reviewer', 'agent-published-exact-id', { candidates: [grok] }, publication)).rejects.toThrow('verified catalog');
    f.settings.workerBindings['grok-pr-reviewer'] = { agentId: 'someone-else', revision: 1, candidates: [grok] };
    await expect(routing.reconcilePublishedPackageBinding('grok-pr-reviewer', 'agent-published-exact-id', { candidates: [{ provider: 'grok', model: 'grok-4.5' }] }, publication)).rejects.toThrow('different agent');
    expect(f.set).not.toHaveBeenCalled();
    expect(f.settings.workerBindings['grok-pr-reviewer'].agentId).toBe('someone-else');
  });

  it('refuses a different owner instead of overwriting its mapping', async() => {
    f.settings.workerBindings['grok-reviewer'] = { agentId: 'other-id', revision: 2, candidates: [grok] };
    const routing = new WorkerModelRoutingService();
    await expect(routing.initializeBindingForDefinition('grok-reviewer', 'grok-agent-id', [grok])).rejects.toThrow('preserved');
    expect(f.set).not.toHaveBeenCalled();
  });

  it('uses an owner-approved Codex fallback if the Grok OAuth account changes', async() => {
    f.accounts.grok = 'default';
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0,
      connections: { grok: 'oauth', codex: 'codex-subscription' }, candidates: [grok, { provider: 'codex', model: 'gpt-6-luna', effort: 'max' }] };
    const routing = new WorkerModelRoutingService();
    expect(await routing.resolveRoute(route)).toEqual([{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }]);
  });

  it('waits through a transient catalog outage and resumes the same approved model', async() => {
    f.outageCalls = 2;
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0, connections: { grok: 'oauth' }, candidates: [grok] };
    const routing = new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 });
    expect(await routing.resolveRoute(route)).toEqual([grok]);
    expect(f.providerCalls).toBe(3);
    expect(route.selected).toBe(0);
  });

  it('bounds a never-settling resolveRouteOnce and retries within the provider-resolution budget', async() => {
    f.hangProviderInfo = true;
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0,
      connections: { grok: 'oauth' }, candidates: [grok] };
    const routing = new WorkerModelRoutingService({ budgetMs: 5 * 60_000, pollMs: 15_000 }, 15);
    const resolution = new LoopProviderResolution({ timeoutMs: 200, attemptTimeoutMs: 40, maxAttempts: 3, retryBackoffMs: [1, 1] });
    const startedAt = performance.now();
    const failure = await resolution.run(({ signal, stage }) =>
      stage('workerModelRouting.resolveRoute', () => routing.resolveRoute(route, signal)),
    ).then(() => null, error => error);

    expect(failure).toBeInstanceOf(LoopProviderResolutionError);
    expect(failure).toMatchObject({ stage: 'workerModelRouting.resolveRouteOnce', attempts: 3, timedOut: true });
    expect(f.providerCalls).toBe(3);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it('re-arms the resolveRouteOnce deadline when a timer fires after suspend', async() => {
    vi.useFakeTimers();
    let activeMs = 0;
    f.hangProviderInfo = true;
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0,
      connections: { grok: 'oauth' }, candidates: [grok] };
    const routing = new WorkerModelRoutingService({ budgetMs: 5 * 60_000, pollMs: 15_000 }, 40, () => activeMs);
    const pending = routing.resolveRoute(route).then(() => null, error => error);
    let settled = false;
    pending.then(() => { settled = true });

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      activeMs = 40;
      await vi.advanceTimersByTimeAsync(40);
      expect(await pending).toMatchObject({ stage: 'workerModelRouting.resolveRouteOnce' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits through an unreadable vault account lookup and returns the original approved route', async() => {
    // Production account lookups read the local vault broker; these are its real failure shapes.
    const unavailable = new VaultBrokerError('database_unavailable', 'Vault database is unavailable', 503);
    const transport = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const electron = new Error('net::ERR_CONNECTION_REFUSED');
    f.nextLookupErrors = [unavailable, transport, electron];
    const codex = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0,
      connections: { grok: 'oauth', codex: 'codex-subscription' }, candidates: [grok, codex] };
    const routing = new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 });
    expect(await routing.resolveRoute(route)).toEqual([grok, codex]);
    expect(f.lookupCalls).toBe(5);
    expect(route.selected).toBe(0);
    expect(route.connections).toEqual({ grok: 'oauth', codex: 'codex-subscription' });
  });

  it('stops an account-lookup wait cleanly instead of substituting an approved fallback', async() => {
    f.stickyLookupError = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const codex = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0,
      connections: { grok: 'oauth', codex: 'codex-subscription' }, candidates: [grok, codex] };
    const stop = new AbortController();
    const waiting = new WorkerModelRoutingService({ budgetMs: 60_000, pollMs: 60_000 }).resolveRoute(route, stop.signal);
    setTimeout(() => stop.abort(new Error('stopped by owner')), 5);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(route.selected).toBe(0);
    expect(route.candidates[0]).toEqual(grok);
  });

  it('skips a confirmed different account or a billing refusal once, without waiting', async() => {
    const codex = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
    const changed: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0,
      connections: { codex: 'codex-subscription', grok: 'oauth' }, candidates: [codex, grok] };
    f.accounts.codex = 'other-subscription';
    const routing = new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 });
    expect(await routing.resolveRoute(changed)).toEqual([grok]);
    expect(f.lookupCalls).toBe(2);
    expect(changed.connections.codex).toBe('codex-subscription');

    f.lookupCalls = 0;
    f.accounts.codex = 'codex-subscription';
    f.accounts.grok = 'default';
    const refused: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0, connections: { grok: 'oauth' }, candidates: [grok] };
    await expect(routing.resolveRoute(refused)).rejects.toThrow('approved account');
    expect(f.lookupCalls).toBe(1);
  });

  it('does not retry an unknown account-lookup error or call it an owner mismatch', async() => {
    const codex = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0,
      connections: { grok: 'oauth', codex: 'codex-subscription' }, candidates: [grok, codex] };
    const routing = new WorkerModelRoutingService({ budgetMs: 1_000, pollMs: 1 });
    const badRequest = new VaultBrokerError('invalid_operation', 'Integration metadata reference is invalid', 400);
    for (const fault of [new TypeError('account map is not a function'), Object.assign(new Error('duplicate key'), { code: '23505' }), new Error('timeout'), badRequest]) {
      f.lookupCalls = 0;
      f.stickyLookupError = fault;
      await expect(routing.resolveRoute(route)).rejects.toBe(fault);
      expect(f.lookupCalls).toBe(1);
    }
  });

  it('keeps an account-lookup outage retryable until the bounded wait ends', async() => {
    f.stickyLookupError = new VaultBrokerError('vault_unavailable', 'Vault broker service identity is not configured', 503);
    const codex = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0,
      connections: { grok: 'oauth', codex: 'codex-subscription' }, candidates: [grok, codex] };
    const routing = new WorkerModelRoutingService({ budgetMs: 250, pollMs: 1 });
    const error = await routing.resolveRoute(route).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkerCatalogUnavailable);
    expect((error as Error).message).not.toContain('approved account');
    expect(f.lookupCalls).toBeGreaterThan(1);
  });

  it('fails with retryable infrastructure, not a substitute, when the outage outlasts the wait or the run stops', async() => {
    f.outageCalls = Number.POSITIVE_INFINITY;
    const route: any = { version: 1, slug: 'grok-reviewer', agentId: 'grok-agent-id', revision: 2, selected: 0, connections: { grok: 'oauth' }, candidates: [grok] };
    const { InfrastructureFailure } = await import('../../../languagemodels/providerRecovery');
    await expect(new WorkerModelRoutingService({ budgetMs: 5, pollMs: 1 }).resolveRoute(route)).rejects.toBeInstanceOf(InfrastructureFailure);
    const stop = new AbortController();
    const waiting = new WorkerModelRoutingService({ budgetMs: 60_000, pollMs: 60_000 }).resolveRoute(route, stop.signal);
    setTimeout(() => stop.abort(new Error('stopped by owner')), 5);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });
});
