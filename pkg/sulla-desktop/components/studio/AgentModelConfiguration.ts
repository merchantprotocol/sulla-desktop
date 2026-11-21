// SPDX-License-Identifier: GPL-2.0-or-later
import { cleanAgentModelTiers, tiersFromCandidates, type AgentModelTiers } from '@pkg/agent/languagemodels/agentModelTiers';
import type { AgentModelChoice, ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';
import type { AgentEditorBindingReceipt } from '@pkg/shared/agentEditor';
import type { WorkerModelBinding } from '@pkg/agent/languagemodels/workerModelBindings';

export function copyModelTiers(tiers: AgentModelTiers | null): AgentModelTiers | null {
  return tiers && { ...tiers, tiers: tiers.tiers.map(tier => ({ ...tier, candidates: tier.candidates.map(row => ({ ...row })) })) };
}

/** One editor for the existing definition and its installation-owned execution selection. */
export class AgentModelConfiguration {
  private opened?: WorkerModelBinding;
  private revision = 0;
  private token = '';

  constructor(readonly id: string, readonly slug: string, state: ModelRoutingState | null, private readonly disabledDefinition = false) {
    this.adopt(state);
  }

  adopt(state: ModelRoutingState | null): void {
    const binding = state?.workerBindings?.[this.slug];
    this.opened = binding?.agentId === this.id ? JSON.parse(JSON.stringify(binding)) : undefined;
    const inheritance = state?.workerInheritance?.[this.slug];
    const version = this.opened ?? (inheritance?.agentId === this.id ? inheritance : undefined);
    this.revision = version?.revision ?? 0;
    this.token = version?.editToken ?? '';
  }

  adoptCreated(tiers: AgentModelTiers, receipt: AgentEditorBindingReceipt): void {
    this.opened = { ...receipt, agentId: this.id, modelTiers: copyModelTiers(tiers)!, candidates: tiers.tiers.flatMap(tier => tier.candidates.map(row => ({ ...row }))) };
    this.revision = receipt.revision;
    this.token = receipt.editToken;
  }

  choice(fallback: AgentModelChoice): AgentModelChoice {
    const row = this.opened?.candidates[0];
    return row ? { mode: 'pin', provider: row.provider, model: row.model, ...(row.effort ? { effort: row.effort } : {}) } : fallback;
  }

  tiers(): AgentModelTiers | null {
    return copyModelTiers(this.opened?.modelTiers ?? tiersFromCandidates(this.opened?.candidates ?? []) ?? null);
  }

  isLegacyFlat(): boolean {
    return !!this.opened && !this.opened.modelTiers;
  }

  change(tiers: AgentModelTiers | null, state: ModelRoutingState | null) {
    if (JSON.stringify(tiers) === JSON.stringify(this.tiers())) return undefined;
    const binding = state?.workerBindings?.[this.slug];
    const canWrite = this.opened || (!binding && (this.disabledDefinition || state?.workers?.some(worker => worker.id === this.id && worker.slug === this.slug)));
    if (tiers && !canWrite) throw new Error('This agent cannot use custom model tiers. Reload the agent and check the assigned worker.');
    const target = { slug: this.slug, agentId: this.id, expectedRevision: this.revision, expectedToken: this.token };
    return tiers ? { ...target, modelTiers: cleanAgentModelTiers(tiers) } : { ...target, candidates: null };
  }
}
