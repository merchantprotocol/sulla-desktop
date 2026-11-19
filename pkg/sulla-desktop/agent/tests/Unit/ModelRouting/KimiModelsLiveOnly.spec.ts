// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../languagemodels/ModelDiscoveryService', () => ({ modelDiscoveryService: { fetchModelsForProvider: f.fetch } }));

import { KimiModels } from '../../../integrations/select_box/KimiModels';

const context = { integrationId: 'kimi', accountId: 'kimi-owner', formValues: { region: 'international' } };

beforeEach(() => f.fetch.mockReset());

describe('Kimi model options in live-only catalogs', () => {
  it('uses the shared discovery service and account/region options, with no local fallback', async() => {
    f.fetch.mockResolvedValue([]);
    await expect(new KimiModels().getOptions({ ...context, liveOnly: true })).resolves.toEqual([]);
    expect(f.fetch).toHaveBeenCalledWith('kimi', '', {
      accountId: 'kimi-owner',
      baseUrl: 'https://api.moonshot.ai/v1',
      region: 'international',
      liveOnly: true,
    });
  });

  it('keeps the ordinary setup fallback separate from live-only refresh results', async() => {
    f.fetch.mockResolvedValue([]);
    expect(await new KimiModels().getOptions(context)).toEqual([
      { value: 'moonshot-v1-128k', label: 'Moonshot v1 128K', description: '128K context window' },
      { value: 'moonshot-v1-32k', label: 'Moonshot v1 32K', description: '32K context window' },
      { value: 'moonshot-v1-8k', label: 'Moonshot v1 8K', description: '8K context window' },
    ]);
  });
});
