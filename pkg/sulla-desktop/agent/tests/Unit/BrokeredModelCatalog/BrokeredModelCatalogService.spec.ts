// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { BrokeredModelCatalogService } from '../../../app/Services/BrokeredModelCatalogService';
import { ProviderCatalogStrategyRegistry, OpenAiCatalogStrategy } from '../../../app/Services/BrokeredModelCatalogStrategies';
import { ExpiringRequestCache } from '../../../app/Services/ExpiringRequestCache';

class FixedClock { now(): Date { return new Date(0); } }

const account = {
  integration_id: 'synthetic-provider', account_id: 'synthetic-account', label: 'Synthetic',
  connected: true, active: true, created_at: '2026-01-01', updated_at: '2026-01-01',
};

const accounts = {
  list: async() => [account],
  metadata: async() => [],
};

describe('BrokeredModelCatalogService', () => {
  it('routes through the injected provider strategy and strips credential headers', async() => {
    // risk: credentials escaping the vault boundary
    const requests: unknown[] = [];
    const service = new BrokeredModelCatalogService(
      new ProviderCatalogStrategyRegistry([new OpenAiCatalogStrategy()]),
      accounts,
      { execute: async request => { requests.push(request); return { data: ['synthetic-model'] }; } },
      new ExpiringRequestCache(new FixedClock(), 3),
      { warn: () => undefined },
    );

    const result = await service.list('openai', undefined, () => ({ authorization: 'secret', cookie: 'secret', 'x-safe': 'yes' }));
    expect(result.body).toEqual({ data: ['synthetic-model'] });
    expect(requests).toEqual([expect.objectContaining({
      providerId: 'openai', accountId: 'synthetic-account', url: 'https://api.openai.com/v1/models', headers: { 'x-safe': 'yes' },
    })]);
  });

  it('returns null and briefly caches transport failures without throwing', async() => {
    // risk: provider outage hammering the credential broker
    let calls = 0;
    const warnings: string[] = [];
    const service = new BrokeredModelCatalogService(
      new ProviderCatalogStrategyRegistry([new OpenAiCatalogStrategy()]),
      accounts,
      { execute: async() => { calls += 1; throw new Error('synthetic outage'); } },
      new ExpiringRequestCache(new FixedClock(), 3),
      { warn: message => warnings.push(message) },
    );

    expect((await service.list('openai')).body).toBeNull();
    expect((await service.list('openai')).body).toBeNull();
    expect(calls).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});
