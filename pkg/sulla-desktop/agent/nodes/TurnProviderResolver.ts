// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { getServiceByProvider, getPrimaryService, getSubconsciousService, modelRouteService } from '../languagemodels';
import { resolveModelSlot } from '../languagemodels/modelSlotRouting';
import { effectiveModelChoice } from '../languagemodels/threadModelChoice';
import type { AgentModelChoice } from '../languagemodels/modelRoutingTypes';
import type { BaseLanguageModel } from '../languagemodels/BaseLanguageModel';
import type { ModelCandidate } from '../languagemodels/modelRouter';
import { agentDefinitionService } from '../services/AgentDefinitionService';
import { resolveAgentIdentity } from '../utils/agentIdentity';
import type { BaseThreadState } from './Graph';
import { turnAgentDefinitionMemo } from './turnAgentDefinitionMemo';
import { turnProviderMemo } from './turnProviderMemo';

export interface ResolvedTurnProvider { provider: BaseLanguageModel; candidates: ModelCandidate[] }

/** Resolves once per user-message turn for prompt construction, middleware, and execution. */
export class TurnProviderResolver {
  async resolve(state: BaseThreadState): Promise<ResolvedTurnProvider> {
    const memoized = turnProviderMemo.get(state);
    if (memoized) return { provider: memoized.provider, candidates: [...memoized.candidates] };

    if (state.metadata.inheritedResumeModel && !(state.metadata as any).workerModelChatOverride) {
      const { modelRouter } = await import('../languagemodels/modelRouter');
      const candidate = await modelRouter.checkInheritedResume(state.metadata.inheritedResumeModel);
      const provider = await getServiceByProvider(candidate.provider, candidate.model, candidate.effort);
      turnProviderMemo.set(state, provider, [candidate]);
      return { provider, candidates: [candidate] };
    }
    const target = resolveModelSlot(state.metadata as any) === 'subconscious' ? 'subconscious' : 'agents';
    const explicitProvider = String((state.metadata as any).agent?.provider || '').trim();
    const explicitModel = String((state.metadata as any).agent?.model || '').trim();
    const agentId = resolveAgentIdentity(state.metadata);
    const definition = agentId ? await turnAgentDefinitionMemo.get(state, agentId, () => agentDefinitionService.findBySlug(agentId)).catch(() => null) : null;
    const choice: AgentModelChoice = effectiveModelChoice({ provider: explicitProvider, model: explicitModel, metadata: state.metadata, agentChoice: definition?.model_choice });
    const routed = await modelRouteService.resolve(target, choice);
    const candidates = routed ? [...routed.candidates] : [];
    const provider = routed?.service ?? (target === 'subconscious' ? await getSubconsciousService() : await getPrimaryService());
    turnProviderMemo.set(state, provider, candidates);
    return { provider, candidates };
  }
}

export const turnProviderResolver = new TurnProviderResolver();
