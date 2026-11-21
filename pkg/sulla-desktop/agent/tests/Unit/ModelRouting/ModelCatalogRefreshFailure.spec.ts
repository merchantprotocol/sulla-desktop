// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { ModelRouter, type EditableState } from '../../../languagemodels/modelRouter';
import { sharedModelCatalog } from '../../../languagemodels/sharedModelCatalog';

vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {}, openai: {}, alibaba: {} } }));
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
    vi.spyOn(sharedModelCatalog, 'refreshNow').mockResolvedValue(undefined);
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
    expect(getModelsForProvider).toHaveBeenCalledWith('codex');
    expect(SullaSettingsModel.set).toHaveBeenCalledWith('modelCatalogCheck', expect.objectContaining({ lists: { codex: ['gpt-saved', 'gpt-saved-fast'] } }), 'json');
    await expect(router.getEditableState()).resolves.toMatchObject({
      classes:    { standard: [{ provider: 'codex', model: 'gpt-saved' }], fast: [{ provider: 'codex', model: 'gpt-saved-fast' }] },
      agentsList: [{ provider: 'codex', class: 'standard', enabled: true }],
    });
  });

  it('records the shared-catalog discovery reason and omits disconnected providers', async() => {
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
  it('keeps the explicit Codex Auto route usable when it is the only advertised CLI model', async() => {
    const router = new ModelRouter(() => ({
      getAvailableProviders: () => Promise.resolve([{ id: 'codex', connected: true }]),
      getModelsForProvider:  () => Promise.resolve([{ id: 'codex', name: 'Auto (CLI default)' }]),
    }));

    await expect(router.refreshCatalog()).resolves.toMatchObject({
      checks: [{ provider: 'codex', status: 'refreshed' }],
    });
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
