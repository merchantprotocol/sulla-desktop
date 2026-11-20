// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  accounts: {} as Record<string, any[]>,
  active:   {} as Record<string, string>,
  fault:    {} as Record<string, boolean>,
  cli:      {} as Record<string, boolean>,
  get:      vi.fn(),
  set:      vi.fn(),
}));

vi.mock('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({
    getAccounts: async(providerId: string) => {
      if (f.fault[providerId]) throw new Error('vault metadata unavailable');
      return f.accounts[providerId] ?? [];
    },
    getActiveAccountId: async(providerId: string) => f.active[providerId] ?? '',
  }),
}));
vi.mock('../../../services/ServiceLifecycleManager', () => ({ getServiceLifecycleManager: () => ({ on: vi.fn() }) }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: f.get, set: f.set } }));
vi.mock('../../../integrations/catalog', () => ({ integrations: {
  'claude-code': { id: 'claude-code', name: 'Claude Code', category: 'AI Infrastructure', oauth: true, properties: [{ key: 'api_key' }] },
  codex:        { id: 'codex', name: 'OpenAI Codex', category: 'AI Infrastructure', oauth: true, properties: [] },
  grok:        { id: 'grok', name: 'Grok', category: 'AI Infrastructure', oauth: true, properties: [{ key: 'api_key' }] },
  openai:      { id: 'openai', name: 'OpenAI', category: 'AI Infrastructure', properties: [{ key: 'api_key' }] },
  cursor:      { id: 'cursor', name: 'Cursor CLI', category: 'AI Infrastructure', properties: [] },
} }));
vi.mock('../../../integrations/select_box', () => ({ getSelectBoxProvider: vi.fn() }));
vi.mock('../../../tools/models/shared', () => ({ getCliStatus: async(providerId: string) => ({ installed: f.cli[providerId] === true }) }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));
vi.mock('@pkg/main/firstRun/pendingCredentials', () => ({ hasPendingCredential: () => false }));
vi.mock('../../../languagemodels/sharedModelCatalog', () => ({ sharedModelCatalog: {
  getStatus: () => ({ authority: 'shared-model-catalog', state: 'fresh' }),
  listModels: async(provider: string) => provider === 'codex' ? [
    { id: 'codex', name: 'Auto (CLI default)', selectionMode: 'auto' },
    { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', selectionMode: 'exact' },
  ] : provider === 'claude-code' ? [
    { id: 'claude-code', name: 'Auto (Claude picks)', selectionMode: 'auto' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', supportedReasoningEfforts: ['high'], selectionMode: 'exact' },
    { id: 'opus', name: 'Opus 5.5 (CLI alias)', supportedReasoningEfforts: ['high'], selectionMode: 'alias' },
  ] : [],
} }));

import { getModelProviderService } from '../../../services/ModelProviderService';

const account = (accountId: string, connected = true, active = true) => ({ account_id: accountId, connected, active, label: accountId });
const providerFor = async(id: string) => (await getModelProviderService().getAvailableProviders()).find(provider => provider.id === id)!;

describe('ModelProviderService access metadata', () => {
  beforeEach(() => {
    f.accounts = {
      'claude-code': [account('oauth')],
      codex:        [account('oauth')],
      grok:         [account('api-key')],
      openai:       [],
      cursor:       [],
    };
    f.active = { 'claude-code': 'oauth', codex: 'oauth', grok: 'api-key' };
    f.fault = {};
    f.cli = { cursor: true };
    f.get.mockReset(); f.set.mockReset();
  });

  it('labels each selected account lane and only enables a runnable account or CLI', async() => {
    const providers = await getModelProviderService().getAvailableProviders();
    const byId = (id: string) => providers.find(provider => provider.id === id)!;

    expect(byId('claude-code')).toMatchObject({ connected: true, selectable: true, accessMethod: 'subscription-cli', accessLabel: 'Subscription · CLI' });
    expect(byId('codex')).toMatchObject({ connected: true, selectable: true, accessMethod: 'subscription-cli', accessLabel: 'Subscription · CLI' });
    expect(byId('grok')).toMatchObject({ connected: true, selectable: true, accessMethod: 'api-key', accessLabel: 'API · separate billing' });
    expect(byId('cursor')).toMatchObject({ connected: true, selectable: true, accessMethod: 'cli-account', accessLabel: 'CLI account' });
    // No account is a known, unconfigured state, not a transient lookup fault.
    expect(byId('openai')).toMatchObject({ connected: false, selectable: false, accessMethod: 'unknown' });
    expect(byId('openai').connectionStatus).toBeUndefined();
  });

  it('keeps a missing selected account known-unrunnable instead of substituting another connected account', async() => {
    f.accounts['claude-code'] = [account('team-key'), account('oauth', true, false)];
    f.active['claude-code'] = 'missing-active-account';

    const missing = await providerFor('claude-code');
    expect(missing).toMatchObject({ connected: false, selectable: false, accessMethod: 'unknown' });
    expect(missing.connectionStatus).toBeUndefined();

    f.active['claude-code'] = 'team-key';
    expect(await providerFor('claude-code')).toMatchObject({ connected: true, accessMethod: 'api-key', accessLabel: 'API · separate billing' });
  });

  it('keeps a disconnected selected account unrunnable even when another API account is connected', async() => {
    f.accounts['claude-code'] = [account('oauth', false), account('team-key', true, false)];

    const disconnected = await providerFor('claude-code');
    expect(disconnected).toMatchObject({ connected: false, selectable: false, accessMethod: 'unknown' });
    expect(disconnected.connectionStatus).toBeUndefined();
  });

  it('reports a real vault metadata fault as unknown, never as selectable', async() => {
    f.fault.codex = true;

    expect(await providerFor('codex')).toMatchObject({ connected: false, selectable: false, connectionStatus: 'unknown', accessMethod: 'unknown' });
  });

  it('labels Grok by the lane GrokService actually runs: a connected OAuth account wins over a selected API account', async() => {
    f.accounts.grok = [account('api-key'), account('oauth', true, false)];
    f.active.grok = 'api-key';
    expect(await providerFor('grok')).toMatchObject({ connected: true, accessMethod: 'subscription', accessLabel: 'Subscription · OAuth' });

    // A disconnected OAuth account is not used by the runtime; the API account is.
    f.accounts.grok = [account('api-key'), account('oauth', false, false)];
    expect(await providerFor('grok')).toMatchObject({ connected: true, accessMethod: 'api-key', accessLabel: 'API · separate billing' });

    // API-only accounts are separate billing.
    f.accounts.grok = [account('api-key')];
    expect(await providerFor('grok')).toMatchObject({ connected: true, accessMethod: 'api-key', accessLabel: 'API · separate billing' });

    // Selected API account disconnected and no connected OAuth account: fail closed.
    f.accounts.grok = [account('api-key', false), account('oauth', false, false)];
    const closed = await providerFor('grok');
    expect(closed).toMatchObject({ connected: false, selectable: false, accessMethod: 'unknown' });
    expect(closed.connectionStatus).toBeUndefined();
  });

  it('marks the provider auto alias separately from exact model ids', async() => {
    await expect(getModelProviderService().getModelsForProvider('codex', { liveOnly: true })).resolves.toMatchObject([
      { id: 'codex', name: 'Auto (CLI default)', selectionMode: 'automatic', source: 'shared-model-catalog' },
      { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', selectionMode: 'exact' },
    ]);
  });

  it('classifies Claude CLI family aliases as automatic versions while keeping ids and efforts', async() => {
    await expect(getModelProviderService().getModelsForProvider('claude-code')).resolves.toMatchObject([
      { id: 'claude-code', name: 'Auto (Claude picks)', selectionMode: 'automatic' },
      { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: [{ id: 'high' }], selectionMode: 'exact' },
      { id: 'opus', name: 'Opus 5.5 (CLI alias)', efforts: [{ id: 'high' }], selectionMode: 'alias' },
    ]);
  });
});
