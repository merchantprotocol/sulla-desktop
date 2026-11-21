// SPDX-License-Identifier: GPL-2.0-or-later

import { candidateKey, cleanAgentModelTiers, tiersFromCandidates, type AgentModelTiers } from '../languagemodels/agentModelTiers';

import type { ModelCandidate } from '../languagemodels/modelRouter';
import type { WorkerModelBinding } from '../languagemodels/workerModelBindings';

export class WorkerModelBindingComparison {
  static reusableForPublication(
    existing: { pendingPublication?: { fileId: string; versionId: string } },
    requested?: { fileId: string; versionId: string },
  ): boolean {
    const marker = existing.pendingPublication;
    return !marker || (!!requested && marker.fileId === requested.fileId && marker.versionId === requested.versionId);
  }

  static sameStored(binding: WorkerModelBinding, declared: { candidates: ModelCandidate[]; modelTiers?: AgentModelTiers }): boolean {
    return JSON.stringify(binding.candidates.map(candidateKey)) === JSON.stringify(declared.candidates.map(candidateKey)) &&
      JSON.stringify(binding.modelTiers ?? null) === JSON.stringify(declared.modelTiers ?? null);
  }

  static sameEffective(binding: WorkerModelBinding, declared: { candidates: ModelCandidate[]; modelTiers?: AgentModelTiers }): boolean {
    const effective = (value: { candidates: ModelCandidate[]; modelTiers?: AgentModelTiers }) => {
      const { preset: _preset, ...tiers } = cleanAgentModelTiers(value.modelTiers ?? tiersFromCandidates(value.candidates));
      return JSON.stringify(tiers);
    };
    return effective(binding) === effective(declared);
  }
}
