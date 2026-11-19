// SPDX-License-Identifier: GPL-2.0-or-later
import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';
import type { AgentModelChoice, ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';
import type { WorkerModelBinding } from '@pkg/agent/languagemodels/workerModelBindings';

/** One editor for the existing definition and its installation-owned execution selection. */
export class AgentModelConfiguration {
  private opened?: WorkerModelBinding;
  /**
   * disabledDefinition: this exact saved, non-archived definition is disabled, so it is absent from the
   * runnable workers list but its owner may still configure its mapping. It does not make it runnable.
   */
  constructor(readonly id: string, readonly slug: string, state: ModelRoutingState | null, private readonly originalChoice?: AgentModelChoice, private readonly disabledDefinition = false) { this.adopt(state) }
  adopt(state: ModelRoutingState | null): void {
    const binding = state?.workerBindings?.[this.slug];
    this.opened = binding?.agentId === this.id ? JSON.parse(JSON.stringify(binding)) : undefined;
  }

  choice(fallback: AgentModelChoice): AgentModelChoice {
    const row = this.opened?.candidates[0];
    return row ? { mode: 'pin', provider: row.provider, model: row.model, ...(row.effort ? { effort: row.effort } : {}) } : fallback;
  }

  fallbacks(): ModelCandidate[] { return JSON.parse(JSON.stringify(this.opened?.candidates.slice(1) ?? [])) }
  usesBinding(choice: AgentModelChoice, state: ModelRoutingState | null): boolean {
    const binding = state?.workerBindings?.[this.slug];
    const sameDefinitionBinding = binding?.agentId === this.id;
    const unboundWorkerDefinition = !binding && (this.disabledDefinition || state?.workers?.some(worker => worker.id === this.id && worker.slug === this.slug));
    return !!(sameDefinitionBinding || unboundWorkerDefinition) && choice.mode === 'pin' && ['codex', 'claude-code', 'grok'].includes(choice.provider);
  }

  private validateCandidates(choice: AgentModelChoice, fallbacks: readonly ModelCandidate[]): void {
    const candidates = choice.mode === 'pin'
      ? [{ provider: choice.provider, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) }, ...fallbacks]
      : fallbacks;
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.provider?.trim() || !candidate.model?.trim()) throw new Error('Every model route needs a provider and model.');
      if (candidate.effort !== undefined && !/^[a-z][a-z0-9_-]{1,31}$/.test(candidate.effort)) throw new Error('A model route has an invalid effort value.');
      const key = `${ candidate.provider }\u0000${ candidate.model }\u0000${ candidate.effort ?? '' }`;
      if (seen.has(key)) throw new Error('Model routes must be unique and keep their saved order.');
      seen.add(key);
    }
  }

  change(choice: AgentModelChoice, fallbacks: ModelCandidate[], state: ModelRoutingState | null) {
    this.validateCandidates(choice, fallbacks);
    const savedChoice = this.opened?.candidates[0]
      ? { mode: 'pin' as const, provider: this.opened.candidates[0].provider, model: this.opened.candidates[0].model, ...(this.opened.candidates[0].effort ? { effort: this.opened.candidates[0].effort } : {}) }
      : this.originalChoice;
    if (JSON.stringify(choice) === JSON.stringify(savedChoice) && JSON.stringify(fallbacks) === JSON.stringify(this.opened?.candidates.slice(1) ?? [])) return undefined;
    if (!this.opened && !fallbacks.length && this.originalChoice && JSON.stringify(choice) === JSON.stringify(this.originalChoice)) return undefined;
    const closed = this.usesBinding(choice, state);
    if (choice.mode === 'pin' && !closed && JSON.stringify(choice) !== JSON.stringify(this.originalChoice)) throw new Error('This exact model cannot be represented by an owner worker mapping. Choose a connected Claude Code, Codex, or Grok OAuth subscription model.');
    if (choice.mode === 'pin' && fallbacks.length && !closed) throw new Error('Fallback models require a saved agent using a Claude Code, Codex, or Grok OAuth subscription. Remove the fallbacks or choose one of those providers.');
    const candidates = closed && choice.mode === 'pin' ? [{ provider: choice.provider, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) }, ...fallbacks.map(row => ({ ...row }))] : null;
    if ((!candidates && !this.opened) || JSON.stringify(candidates) === JSON.stringify(this.opened?.candidates)) return undefined;
    return { slug: this.slug, agentId: this.id, expectedRevision: this.opened?.revision ?? 0, expectedToken: this.opened?.editToken ?? '', candidates };
  }
}
