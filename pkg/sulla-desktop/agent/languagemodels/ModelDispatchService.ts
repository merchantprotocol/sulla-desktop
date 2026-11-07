// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BaseLanguageModel } from './BaseLanguageModel';
import type { ModelCandidate } from './modelRouter';
import type { AgentModelChoice } from './modelRoutingTypes';

export interface RoutedModelService {
  candidates: readonly ModelCandidate[];
  service:    BaseLanguageModel;
}

/**
 * The single boundary between candidate selection and provider execution.
 * Auto/class/pin choices differ only in the candidates returned by the router;
 * every chosen candidate enters the same provider service factory afterwards.
 */
export class ModelDispatchService {
  constructor(
    private readonly resolveCandidates: (target: 'agents'|'subconscious', choice: AgentModelChoice) => Promise<ModelCandidate[]>,
    private readonly createService: (provider: string, model: string) => Promise<BaseLanguageModel>,
  ) {}

  candidates(target: 'agents'|'subconscious', choice: AgentModelChoice): Promise<ModelCandidate[]> {
    return this.resolveCandidates(target, choice);
  }

  service(candidate: ModelCandidate): Promise<BaseLanguageModel> {
    return this.createService(candidate.provider, candidate.model);
  }

  async resolve(target: 'agents'|'subconscious', choice: AgentModelChoice): Promise<RoutedModelService | null> {
    const candidates = await this.candidates(target, choice);
    const selected = candidates[0];
    if (!selected) return null;
    return { candidates, service: await this.service(selected) };
  }
}
