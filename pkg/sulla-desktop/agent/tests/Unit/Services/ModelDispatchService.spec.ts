// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import type { BaseLanguageModel } from '../../../languagemodels/BaseLanguageModel';
import { ModelDispatchService } from '../../../languagemodels/ModelDispatchService';
import { ModelRouteService } from '../../../languagemodels/ModelRouteService';
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

describe('ModelRouteService production entry points', () => {
  it('routes Auto and pin through the same selected service boundary', async () => {
    // risk: authentication/service drift between Auto and a direct model selection
    const service = {} as BaseLanguageModel;
    const choices: AgentModelChoice[] = [];
    const createService = vi.fn(async() => service);
    const dispatch = new ModelDispatchService(
      async(_target, choice) => {
        choices.push(choice);
        return [{ provider: 'codex', model: 'gpt-6.1-sol' }];
      },
      createService,
    );
    const routes = new ModelRouteService(dispatch, vi.fn());

    const automatic = await routes.resolve('agents', { mode: 'list' });
    const pinned = await routes.resolve('agents', { mode: 'pin', provider: 'codex', model: 'gpt-6.1-sol' });

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

  it('constructs only the requested override service', async () => {
    // risk: duplicate credential refresh/auth side effects before an explicit override executes
    const selectedService = {} as BaseLanguageModel;
    const createService = vi.fn(async() => selectedService);
    const dispatch = new ModelDispatchService(
      async() => [{ provider: 'codex', model: 'auto-model' }],
      createService,
    );

    const result = await new ModelRouteService(dispatch, vi.fn()).remote('direct-model');

    expect(result).toBe(selectedService);
    expect(createService).toHaveBeenCalledOnce();
    expect(createService).toHaveBeenCalledWith('codex', 'direct-model');
  });
});
