// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { sharedModelCatalog } from '../../../languagemodels/sharedModelCatalog';
import { ModelRouter, type EditableState } from '../../../languagemodels/modelRouter';

vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {}, openai: {}, alibaba: {} } }));
vi.mock('../../../languagemodels/sharedModelCatalog', () => ({ sharedModelCatalog: { refreshNow: vi.fn().mockResolvedValue(undefined) } }));
afterEach(() => vi.restoreAllMocks());

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
    vi.mocked(sharedModelCatalog.refreshNow).mockClear();
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
    expect(sharedModelCatalog.refreshNow).toHaveBeenCalledOnce();
    expect(getModelsForProvider).toHaveBeenCalledWith('codex');
    expect(vi.mocked(sharedModelCatalog.refreshNow).mock.invocationCallOrder[0]).toBeLessThan(getModelsForProvider.mock.invocationCallOrder[0]);
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
    await expect(router.refreshCatalog()).resolves.toMatchObject({
      checks: [{ provider: 'openai', status: 'unavailable', reason: 'No validated Cloud catalog models available (or private endpoint unavailable)' }],
    });
  });
  it('reports a Cloud refresh failure without substituting Codex Auto or changing saved settings', async() => {
    vi.mocked(sharedModelCatalog.refreshNow).mockRejectedValueOnce(new Error('Shared model catalog unavailable'));
    const getModelsForProvider = vi.fn(() => Promise.resolve([{ id: 'codex', name: 'Auto (CLI default)' }]));
    const router = new ModelRouter(() => ({
      getAvailableProviders: () => Promise.resolve([{ id: 'codex', connected: true }]),
      getModelsForProvider,
    }));

    await expect(router.refreshCatalog()).rejects.toThrow('Shared model catalog unavailable');
    expect(getModelsForProvider).not.toHaveBeenCalled();
    expect(SullaSettingsModel.set).not.toHaveBeenCalled();
    await expect(router.getEditableState()).resolves.toMatchObject(saved);
  });
});

it('does not write inferred model routing from the startup snapshot over saved choices', async() => {
  let ready = false;
  vi.spyOn(SullaSettingsModel, 'ready', 'get').mockImplementation(() => ready);
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async(key: string, fallback: unknown) => {
    if (key === 'modelRouting') return ready ? saved : null;
    if (key === 'primaryProvider') return 'codex';
    if (key === 'activeModelId') return 'gpt-legacy';
    return fallback;
  });
  const write = vi.spyOn(SullaSettingsModel, 'set').mockResolvedValue(undefined as never);
  const router = new ModelRouter();

  await router.getEditableState();
  expect(write).not.toHaveBeenCalled();
  ready = true;
  await expect(router.getEditableState()).resolves.toMatchObject(saved);
});
