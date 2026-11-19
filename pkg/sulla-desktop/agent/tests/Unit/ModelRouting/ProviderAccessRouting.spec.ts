// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Composition: the real ModelProviderService availability DTO feeds the real
// ModelRouter. Only the IntegrationService metadata seam and catalogs are faked;
// no credential value or provider request is involved.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  accounts: {} as Record<string, any[]>,
  active:   {} as Record<string, string>,
  fault:    {} as Record<string, boolean>,
  saved:    null as any,
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
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {
  get: vi.fn(async(key: string, fallback: unknown) => key === 'modelRouting' ? structuredClone(f.saved) : fallback),
  set: vi.fn(async() => undefined),
} }));
vi.mock('../../../integrations/catalog', () => ({ integrations: {
  'claude-code': { id: 'claude-code', name: 'Claude Code', category: 'AI Infrastructure', oauth: true, properties: [{ key: 'api_key' }] },
  codex:        { id: 'codex', name: 'OpenAI Codex', category: 'AI Infrastructure', oauth: true, properties: [] },
  grok:         { id: 'grok', name: 'Grok', category: 'AI Infrastructure', oauth: true, properties: [{ key: 'api_key' }] },
  openai:       { id: 'openai', name: 'OpenAI', category: 'AI Infrastructure', properties: [{ key: 'api_key' }] },
} }));
vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { 'claude-code': {}, codex: {}, grok: {}, openai: {} } }));
vi.mock('../../../integrations/select_box', () => ({ getSelectBoxProvider: vi.fn() }));
vi.mock('../../../tools/models/shared', () => ({ getCliStatus: async() => ({ installed: false }) }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));
vi.mock('@pkg/main/firstRun/pendingCredentials', () => ({ hasPendingCredential: () => false }));
vi.mock('../../../languagemodels/codexModelCatalog', () => ({ listCodexModels: async() => [{ id: 'codex', name: 'Auto (CLI default)' }, { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }] }));
vi.mock('../../../languagemodels/claudeModelCatalog', () => ({ listClaudeCodeModels: async() => [{ id: 'claude-code', name: 'Auto (Claude picks)' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' }] }));

import { ModelRouter } from '../../../languagemodels/modelRouter';
import { getModelProviderService } from '../../../services/ModelProviderService';

const account = (accountId: string, connected = true, active = true) => ({ account_id: accountId, connected, active, label: accountId });
const router = () => new ModelRouter(() => getModelProviderService());
const providers = (routes: { provider: string }[]) => routes.map(route => route.provider);

describe('provider availability composed into routing', () => {
  beforeEach(() => {
    f.accounts = {
      'claude-code': [account('oauth')],
      codex:         [account('oauth')],
      grok:          [account('api-key')],
      openai:        [],
    };
    f.active = { 'claude-code': 'oauth', codex: 'oauth', grok: 'api-key' };
    f.fault = {};
    const row = (provider: string) => ({ provider, class: 'frontier', enabled: true });
    f.saved = {
      agentsList:       ['claude-code', 'openai', 'grok', 'codex'].map(row),
      subconsciousList: [],
      classes:          {
        frontier: [
          { provider: 'claude-code', model: 'claude-opus-5-5' },
          { provider: 'openai', model: 'gpt-x' },
          { provider: 'grok', model: 'grok-4.6' },
          { provider: 'codex', model: 'gpt-6.2-sol' },
        ],
        standard: [], fast: [], coding: [], local: [],
      },
      followProviderOrder: {},
      neverUse:            [],
    };
  });

  it('routes valid connected selected accounts in order and skips a provider with no account', async() => {
    expect(providers(await router().resolve('agents'))).toEqual(['claude-code', 'grok', 'codex']);
    const info = await router().providerInfo();
    expect(info.find(provider => provider.id === 'openai')).toMatchObject({ connected: false, status: 'disconnected', lastError: null });
  });

  it('never routes a disconnected selected Claude account through another connected API account', async() => {
    f.accounts['claude-code'] = [account('oauth', false), account('team-key', true, false)];

    expect(providers(await router().resolve('agents'))).toEqual(['grok', 'codex']);
    const info = await router().providerInfo();
    expect(info.find(provider => provider.id === 'claude-code')).toMatchObject({ connected: false, status: 'disconnected' });
  });

  it('never routes a missing selected account even when another account is connected', async() => {
    f.active.grok = 'deleted-account';
    f.accounts.grok = [account('api-key', true, false)];

    expect(providers(await router().resolve('agents'))).toEqual(['claude-code', 'codex']);
  });

  it('keeps a real metadata fault routable for authenticated execution, as before', async() => {
    f.fault.codex = true;

    expect(providers(await router().resolve('agents'))).toEqual(['claude-code', 'grok', 'codex']);
    const info = await router().providerInfo();
    expect(info.find(provider => provider.id === 'codex')).toMatchObject({ connected: false, status: 'error' });
  });
});
