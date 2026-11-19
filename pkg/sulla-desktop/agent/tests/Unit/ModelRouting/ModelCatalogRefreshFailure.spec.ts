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

  it('marks Codex unavailable and leaves the saved model lists and choices untouched', async() => {
    const router = new ModelRouter(() => ({
      getAvailableProviders: () => Promise.resolve([{ id: 'codex', connected: true }]),
      getModelsForProvider:  () => Promise.resolve([{ id: 'codex', name: 'Auto (CLI default)' }]),
    }));

    await expect(router.refreshCatalog()).resolves.toMatchObject({ checks: [{ provider: 'codex', status: 'unavailable' }] });
    expect(SullaSettingsModel.set).toHaveBeenCalledWith('modelCatalogCheck', expect.objectContaining({ lists: { codex: ['gpt-saved', 'gpt-saved-fast'] } }), 'json');
    await expect(router.getEditableState()).resolves.toMatchObject({
      classes:    { standard: [{ provider: 'codex', model: 'gpt-saved' }], fast: [{ provider: 'codex', model: 'gpt-saved-fast' }] },
      agentsList: [{ provider: 'codex', class: 'standard', enabled: true }],
    });
  });
});
