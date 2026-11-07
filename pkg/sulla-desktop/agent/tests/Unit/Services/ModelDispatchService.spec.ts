// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

// Keep the production registry entry test focused: these collaborators are unrelated to dispatch
// and importing their application graphs would consume the PR suite's hard 60-second budget.
vi.mock('../../../languagemodels/BaseLanguageModel', () => ({ BaseLanguageModel: class {} }));
vi.mock('../../../languagemodels/ModelDiscoveryService', () => ({ modelDiscoveryService: {} }));
vi.mock('../../../../vault-broker', () => ({ usesContainerVaultAuthority: () => false }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {} }));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: () => ({}) }));
vi.mock('../../../../main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));
vi.mock('../../../languagemodels/openAICompatibleProviders', () => ({ OPENAI_COMPATIBLE_PROVIDERS: [] }));
vi.mock('../../../languagemodels/OpenAICompatibleProviderService', () => ({ getOpenAICompatibleProviderService: vi.fn() }));

import type { BaseLanguageModel } from '../../../languagemodels/BaseLanguageModel';
import { ModelDispatchService } from '../../../languagemodels/ModelDispatchService';
import type { AgentModelChoice } from '../../../languagemodels/modelRoutingTypes';

describe('ModelDispatchService', () => {
  it('sends equivalent Auto and pinned candidates through the identical service boundary', async () => {
    // risk: authentication/service drift between Auto and a direct model selection
    const service = {} as BaseLanguageModel;
    const choices: AgentModelChoice[] = [];
    const createService = vi.fn(async() => service);
    const subject = new ModelDispatchService(
      async(_target, choice) => {
        choices.push(choice);
        return [{ provider: 'codex', model: 'gpt-6.1-sol' }];
      },
      createService,
    );

    const automatic = await subject.resolve('agents', { mode: 'list' });
    const pinned = await subject.resolve('agents', { mode: 'pin', provider: 'codex', model: 'gpt-6.1-sol' });

    expect(choices).toEqual([
      { mode: 'list' },
      { mode: 'pin', provider: 'codex', model: 'gpt-6.1-sol' },
    ]);
    expect(createService.mock.calls).toEqual([
      ['codex', 'gpt-6.1-sol'],
      ['codex', 'gpt-6.1-sol'],
    ]);
    expect(automatic?.service).toBe(service);
    expect(pinned?.service).toBe(service);
  });

  it('preserves the complete Auto fallback list while executing only its selected head', async () => {
    // risk: loss or premature execution of configured fallback candidates
    const service = {} as BaseLanguageModel;
    const createService = vi.fn(async() => service);
    const candidates = [
      { provider: 'codex', model: 'gpt-6.1-sol' },
      { provider: 'claude-code', model: 'claude-opus-5-5' },
    ];
    const subject = new ModelDispatchService(async() => candidates, createService);

    const routed = await subject.resolve('agents', { mode: 'list' });

    expect(routed?.candidates).toEqual(candidates);
    expect(createService).toHaveBeenCalledOnce();
    expect(createService).toHaveBeenCalledWith('codex', 'gpt-6.1-sol');
  });
});

// The registry import is intentionally below the service tests: its production entry points are
// exercised with constructor DI, without touching provider credentials or global settings.
import { LLMRegistryImpl } from '../../../languagemodels';

describe('LLMRegistryImpl production dispatch entry', () => {
  it('uses one selected-service construction for an override model', async () => {
    // risk: duplicate credential refresh/auth side effects before an explicit override executes
    const selectedService = {} as BaseLanguageModel;
    const dispatch = {
      candidates: vi.fn(async() => [{ provider: 'codex', model: 'auto-model' }]),
      service: vi.fn(async() => selectedService),
      resolve: vi.fn(),
    } as unknown as ModelDispatchService;
    const registry = new LLMRegistryImpl(() => dispatch);

    const result = await registry.getRemoteService('direct-model');

    expect(result).toBe(selectedService);
    expect(dispatch.candidates).toHaveBeenCalledOnce();
    expect(dispatch.service).toHaveBeenCalledOnce();
    expect(dispatch.service).toHaveBeenCalledWith({ provider: 'codex', model: 'direct-model' });
    expect(dispatch.resolve).not.toHaveBeenCalled();
  });
});
