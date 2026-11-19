// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { ModelRouter, type EditableState } from '../../../languagemodels/modelRouter';

vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {} } }));

const saved: EditableState = {
  agentsList:       [{ provider: 'codex', class: 'standard', enabled: true }],
  subconsciousList: [{ provider: 'codex', class: 'fast', enabled: true }],
  classes:          {
    frontier: [],
    standard: [{ provider: 'codex', model: 'gpt-saved' }],
    fast:     [{ provider: 'codex', model: 'gpt-saved-fast' }],
    coding:   [],
    local:    [],
  },
  followProviderOrder: { frontier: true, standard: true, fast: true, coding: true, local: true },
  neverUse:            [],
};

describe('model catalog refresh failure preservation', () => {
  beforeEach(() => {
    vi.spyOn(SullaSettingsModel, 'get').mockImplementation((key: string, fallback: unknown) => {
      if (key === 'modelRouting') return Promise.resolve(saved);
      if (key === 'modelCatalogCheck') return Promise.resolve({ lists: { codex: ['gpt-saved', 'gpt-saved-fast'] }, report: null });
      return Promise.resolve(fallback);
    });
    vi.spyOn(SullaSettingsModel, 'set').mockResolvedValue(undefined as never);
  });

  it('treats Codex Auto as a usable route and leaves saved model lists and choices untouched', async() => {
    const getModelsForProvider = vi.fn(() => Promise.resolve([{ id: 'codex', name: 'Auto (CLI default)' }]));
    const router = new ModelRouter(() => ({
      getAvailableProviders: () => Promise.resolve([{ id: 'codex', connected: true }]),
      getModelsForProvider,
    }));

    await expect(router.refreshCatalog()).resolves.toMatchObject({ checks: [{ provider: 'codex', status: 'refreshed' }] });
    expect(getModelsForProvider).toHaveBeenCalledWith('codex', { liveOnly: true, forceRefresh: true });
    expect(SullaSettingsModel.set).toHaveBeenCalledWith('modelCatalogCheck', expect.objectContaining({ lists: { codex: ['gpt-saved', 'gpt-saved-fast'] } }), 'json');
    await expect(router.getEditableState()).resolves.toMatchObject({
      classes:    { standard: [{ provider: 'codex', model: 'gpt-saved' }], fast: [{ provider: 'codex', model: 'gpt-saved-fast' }] },
      agentsList: [{ provider: 'codex', class: 'standard', enabled: true }],
    });
  });

  it('records a safe provider discovery reason and omits disconnected providers', async() => {
    const router = new ModelRouter(() => ({
      getAvailableProviders: () => Promise.resolve([
        { id: 'openai', connected: true },
        { id: 'alibaba', connected: false },
      ]),
      getModelsForProvider: () => Promise.resolve([]),
    }));
    const { modelDiscoveryService } = await import('../../../languagemodels/ModelDiscoveryService');
    vi.spyOn(modelDiscoveryService, 'getLastFailure').mockReturnValue('API key rejected (401)');

    await expect(router.refreshCatalog()).resolves.toMatchObject({
      checks: [{ provider: 'openai', status: 'unavailable', reason: 'API key rejected (401)' }],
    });
  });
});
