// SPDX-License-Identifier: GPL-2.0-or-later
import { candidateKey, cleanAgentModelTiers, formatModelCandidate, resolveTierEntries, tierEntries } from '../languagemodels/agentModelTiers';
import { modelRouter, type ModelCandidate } from '../languagemodels/modelRouter';
import { effectiveModelChoice, isAgentModelChoice } from '../languagemodels/threadModelChoice';
import { captureWorkerRoute, WorkerCatalogUnavailable, type WorkerModelBinding } from '../languagemodels/workerModelBindings';
import { redactLLMFailureMessage } from '../languagemodels/providerRecovery';
import { agentDefinitionService } from './AgentDefinitionService';
import { isActiveAgent } from './AgentDirectoryService';
import { isWorkerAccountTemporarilyUnavailable, workerModelRouting } from './WorkerModelRouting';

import type { EditableRoutingState, RoutingProviderInfo } from '../languagemodels/modelRoutingTypes';
import type { AgentPreviewRequest, ModelLaunchPreview } from '../../shared/modelLaunchPreview';

interface PreviewContext {
  binding?: WorkerModelBinding;
  source?: string;
  ignoreSaved?: boolean;
  slot?: 'agents' | 'subconscious';
}

/** One settings read and one account check per provider across every step of a plan. */
export class LaunchPreviewSession {
  private readonly accounts = new Map<string, Promise<Record<string, string>>>();
  constructor(private readonly providers: RoutingProviderInfo[], private readonly settings: EditableRoutingState) {}

  private account = (candidate: ModelCandidate) => {
    let read = this.accounts.get(candidate.provider);
    if (!read) {
      read = workerModelRouting.subscriptionConnections([candidate]);
      this.accounts.set(candidate.provider, read);
    }
    return read;
  };

  async preview(input: AgentPreviewRequest, context: PreviewContext = {}): Promise<ModelLaunchPreview> {
    const agent = input.slug;
    try {
      const id = input.agentId || 'unsaved';
      const key = agent || 'unsaved';
      const stored = input.agentId && agent ? this.settings.workerBindings?.[agent] : undefined;
      let binding = context.binding ?? (!context.ignoreSaved && stored && stored.agentId === id ? stored : undefined);
      if (input.modelTiers === null) binding = undefined;
      if (input.modelTiers) {
        const modelTiers = cleanAgentModelTiers(input.modelTiers);
        const candidates = tierEntries(modelTiers).map(row => row.candidate);
        // An unsaved draft has no approved account yet. Read the same subscriptions a save would approve.
        const firstByProvider = new Map(candidates.map(row => [row.provider, row]));
        const accounts = await Promise.all([...firstByProvider.values()].map(this.account));
        binding = { agentId: id, revision: 1, modelTiers, candidates, connections: Object.assign({}, ...accounts) };
      }
      if (binding) {
        if (binding.pendingPublication) return { agent, status: 'waiting', reason: 'Waiting for the agent file to finish registering.', candidates: [] };
        const route = captureWorkerRoute(key, id, { [key]: binding });
        if (!route) throw new Error('The assigned agent has changed. Choose the agent again.');
        await workerModelRouting.orderNewRoute(route, undefined, this.providers);
        const candidates = await workerModelRouting.resolveRouteOnce(route, { settings: this.settings, providers: this.providers, account: this.account });
        const source = context.source ?? (input.modelTiers ? 'Unsaved model tiers.' : binding.modelTiers ? 'Uses this agent’s model tiers.' : 'Uses this agent’s saved model order.');
        const eligible = new Set(candidates.map(candidateKey));
        const reasons = route.modelTiers ? resolveTierEntries(route.modelTiers, route.candidates.map((candidate, index) =>
          ({ candidate, tier: route.candidateTiers![index] })), this.providers, this.settings.neverUse).skipped : [];
        const byKey = new Map(reasons.map(row => [candidateKey(row.candidate), row.reason]));
        const skippedChoices = route.candidates.filter(row => !eligible.has(candidateKey(row))).map(candidate => ({
          candidate, reason: byKey.get(candidateKey(candidate)) ?? 'Unavailable for the approved subscription or current policy',
        }));
        const skipped = skippedChoices.length;
        const reordered = route.candidates[0].provider !== binding.candidates[0].provider;
        const reason = [source, ...(reordered ? ['A provider in backoff moves later.'] : []),
          ...(skipped ? [skipped + (skipped === 1 ? ' unavailable or disallowed choice skipped.' : ' unavailable or disallowed choices skipped.')] : [])].join(' ');
        const requestedHead = route.candidates[route.selected];
        const launchRequestPolicy = context.binding ? (eligible.has(candidateKey(requestedHead))
          ? 'An explicit model request must match ' + formatModelCandidate(requestedHead) + '.'
          : 'Omit an explicit model request to use this fallback. The configured first choice ' + formatModelCandidate(requestedHead) + ' is unavailable.') :
          binding.modelTiers ? {
            never: 'The caller cannot request a different model.',
            listed: 'The caller may request an exact model from these tiers.',
            any: 'The caller may request another eligible model on an approved subscription.',
          }[binding.modelTiers.allowLaunchOverride ?? 'listed'] : undefined;
        return { agent, status: 'ready', reason, candidates, launchRequestPolicy, ...(skipped ? { skipped: skippedChoices } : {}) };
      }
      if (input.choice && !isAgentModelChoice(input.choice)) throw new Error('Invalid agent model choice.');
      const choice = effectiveModelChoice({ agentChoice: input.choice });
      const slot = context.slot ?? 'agents';
      const candidates = await modelRouter.resolve(slot, choice, this.settings);
      const reason = context.source ?? (choice.mode === 'class' ? 'Inherits the ' + choice.class + ' class in AI Models.' :
        choice.mode === 'pin' ? 'Uses the model pinned to this agent.' : 'Inherits the ' + (slot === 'agents' ? 'Agents' : 'Subconscious') + ' list in AI Models.');
      if (!candidates.length) {
        // TurnProviderResolver consults the slot default if a class resolves empty. A container
        // must still initialize before the graph can use that service. Only its first model is retained.
        const [fallback] = choice.mode === 'class' ? await modelRouter.resolve(slot, { mode: 'list' }, this.settings) : [];
        if (fallback) return { agent, status: 'deferred', reason: reason + ' No eligible model in this class. On startup the agent can use the shared list’s first model.', candidates: [fallback] };
        return { agent, status: 'blocked', reason: reason + ' No available model in this route.', candidates: [] };
      }
      if (choice.mode === 'pin' && !this.providers.some(row => row.id === candidates[0].provider && row.connected)) {
        return { agent, status: 'waiting', reason: reason + ' Waiting for the pinned provider connection.', candidates };
      }
      return { agent, status: 'ready', reason, candidates };
    } catch (error) {
      return { agent, status: error instanceof WorkerCatalogUnavailable || isWorkerAccountTemporarilyUnavailable(error) ? 'waiting' : 'blocked', reason: redactLLMFailureMessage(error), candidates: [] };
    }
  }
}

export async function previewAgentModel(input: AgentPreviewRequest): Promise<ModelLaunchPreview> {
  if (!input || typeof input !== 'object') throw new Error('Invalid preview.');
  const [providers, settings, definition] = await Promise.all([
    modelRouter.providerInfo(true), modelRouter.getEditableState(true),
    input.agentId && input.slug ? agentDefinitionService.findBySlug(input.slug) : undefined,
  ]);
  if (input.agentId && (!definition || definition.id !== input.agentId || !isActiveAgent(definition))) {
    return { status: 'blocked', agent: input.slug, candidates: [], reason: 'The saved agent is unavailable or has been replaced.' };
  }
  return new LaunchPreviewSession(providers, settings).preview({ ...input, choice: input.choice ?? definition?.model_choice ?? undefined });
}
