// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearCodexModelCatalogCache, listCodexModels } from '../../../languagemodels/codexModelCatalog';

const broker = vi.hoisted(() => ({
  clear: vi.fn(),
  list:  vi.fn(),
}));
const settings = vi.hoisted(() => ({ get: vi.fn() }));
const worker = vi.hoisted(() => ({ version: vi.fn() }));

vi.mock('../../../services/brokeredModelList', () => ({
  clearBrokeredModelListCache: broker.clear,
  listProviderModelsBrokered:  broker.list,
}));
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: settings.get } }));
vi.mock('@pkg/backend/providerCliUpdates', () => ({ getWorkerImageCliVersion: worker.version }));

describe('Codex model catalog', () => {
  beforeEach(() => {
    clearCodexModelCatalogCache();
    vi.clearAllMocks();
    settings.get.mockResolvedValue({ codex: '0.170.0' });
    worker.version.mockResolvedValue('0.170.0');
  });

  it('uses the brokered subscription catalog and keeps only bounded selectable metadata', async() => {
    broker.list.mockResolvedValue({
      body: {
        models: [
          {
            slug:                       'gpt-5.6-codex',
            display_name:               'GPT-5.6 Codex',
            description:                'Connected account model\u0000',
            visibility:                 'list',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Fast' },
              { effort: 'high', description: 'Deep\u0007' },
              { effort: 'high; process.env.BAD', description: 'hostile' },
            ],
            default_reasoning_level: 'high',
            upgrade:                 { model: 'gpt-5.7-codex' },
            instructions:            'PRIVATE BASE INSTRUCTIONS MUST NOT REACH THE PICKER',
          },
          { slug: 'internal-review', display_name: 'Internal', visibility: 'hidden' },
          { slug: 'gpt-5.6-codex;bad', display_name: 'Injection', visibility: 'list' },
          { slug: 'gpt-5.6-codex', display_name: 'Duplicate', visibility: 'list' },
        ],
      },
    });

    const models = await listCodexModels();

    expect(broker.list).toHaveBeenCalledWith('codex', undefined, undefined, expect.any(Function));
    expect(models).toEqual([
      { id: 'codex', name: 'Auto (CLI default)', description: 'Let Codex choose the best model automatically' },
      {
        id:            'gpt-5.6-codex',
        name:          'GPT-5.6 Codex',
        description:   'Connected account model',
        efforts:       [{ id: 'low', description: 'Fast' }, { id: 'high', description: 'Deep' }],
        defaultEffort: 'high',
        upgrade:       'gpt-5.7-codex',
      },
    ]);
    expect(JSON.stringify(models)).not.toContain('PRIVATE BASE INSTRUCTIONS');
    expect(JSON.stringify(models)).not.toContain('process.env.BAD');
  });

  it('does not cache a failed or empty response as a live catalog', async() => {
    broker.list.mockRejectedValueOnce(new Error('authorization=secret-token'));
    await expect(listCodexModels()).resolves.toEqual([
      { id: 'codex', name: 'Auto (CLI default)', description: 'Let Codex choose the best model automatically' },
    ]);

    broker.list.mockResolvedValueOnce({ body: { models: [{ slug: 'gpt-5.6-codex', visibility: 'list' }] } });
    await expect(listCodexModels()).resolves.toEqual([
      { id: 'codex', name: 'Auto (CLI default)', description: 'Let Codex choose the best model automatically' },
      { id: 'gpt-5.6-codex', name: 'gpt-5.6-codex' },
    ]);
    expect(broker.list).toHaveBeenCalledTimes(2);
  });

  it('forces a fresh broker request without exporting caller credentials', async() => {
    broker.list.mockResolvedValue({ body: { models: [{ slug: 'gpt-5.6-codex', visibility: 'list' }] } });
    await listCodexModels();
    await listCodexModels({ force: true });

    expect(broker.clear).toHaveBeenCalledTimes(1);
    expect(broker.list).toHaveBeenCalledTimes(2);
    expect(broker.list.mock.calls.every(call => call[0] === 'codex')).toBe(true);
  });

  it('passes the selected immutable CLI version as the only endpoint query', async() => {
    settings.get.mockResolvedValue({ codex: '0.170.0' });
    broker.list.mockImplementation((...args: unknown[]) => {
      const requestUrl = args[3] as ((lane: { url: string }) => string) | undefined;
      expect(requestUrl?.({ url: 'https://chatgpt.com/backend-api/codex/models' })).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.170.0');
      return Promise.resolve({ body: { models: [{ slug: 'gpt-5.6-codex', visibility: 'list' }] } });
    });

    await listCodexModels({ force: true });
    expect(broker.list).toHaveBeenCalledWith('codex', undefined, undefined, expect.any(Function));
  });

  it('uses the actual worker-image version for image-default and never calls the bare route', async() => {
    settings.get.mockResolvedValue({});
    worker.version.mockResolvedValue('0.170.0');
    broker.list.mockImplementation((...args: unknown[]) => {
      const requestUrl = args[3] as ((lane: { url: string }) => string) | undefined;
      expect(requestUrl?.({ url: 'https://chatgpt.com/backend-api/codex/models' })).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.170.0');
      return Promise.resolve({ body: { models: [{ slug: 'gpt-6.2-sol', visibility: 'list' }] } });
    });

    await expect(listCodexModels({ force: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-6.2-sol' }),
    ]));
    expect(worker.version).toHaveBeenCalledWith('codex');
  });

  it('fails closed for invalid selected or image-default versions', async() => {
    settings.get.mockResolvedValue({ codex: '0.170.0;bad' });
    await expect(listCodexModels({ force: true })).resolves.toEqual([
      { id: 'codex', name: 'Auto (CLI default)', description: 'Let Codex choose the best model automatically' },
    ]);
    expect(broker.list).not.toHaveBeenCalled();
    expect(worker.version).not.toHaveBeenCalled();

    settings.get.mockResolvedValue({});
    worker.version.mockResolvedValue('Codex version unavailable');
    await expect(listCodexModels({ force: true })).resolves.toEqual([
      { id: 'codex', name: 'Auto (CLI default)', description: 'Let Codex choose the best model automatically' },
    ]);
    expect(broker.list).not.toHaveBeenCalled();
  });

  it('does not reuse a catalog across selected CLI versions', async() => {
    const requestUrls: string[] = [];
    broker.list.mockImplementation((...args: unknown[]) => {
      const requestUrl = args[3] as ((lane: { url: string }) => string) | undefined;
      requestUrls.push(requestUrl?.({ url: 'https://chatgpt.com/backend-api/codex/models' }) ?? '');
      return Promise.resolve({ body: { models: [{ slug: 'gpt-6.2-sol', visibility: 'list' }] } });
    });

    settings.get.mockResolvedValue({ codex: '0.170.0' });
    await listCodexModels();
    settings.get.mockResolvedValue({ codex: '0.171.0' });
    await listCodexModels();

    expect(requestUrls).toEqual([
      'https://chatgpt.com/backend-api/codex/models?client_version=0.170.0',
      'https://chatgpt.com/backend-api/codex/models?client_version=0.171.0',
    ]);
  });
});
