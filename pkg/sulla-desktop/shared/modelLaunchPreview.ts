// SPDX-License-Identifier: GPL-2.0-or-later
import type { ModelCandidate } from '../agent/languagemodels/modelRouter';
import type { AgentModelChoice } from '../agent/languagemodels/modelRoutingTypes';
import type { AgentModelTiers } from '../agent/languagemodels/agentModelTiers';

export interface ModelLaunchPreview {
  status: 'ready' | 'waiting' | 'blocked' | 'deferred';
  agent?: string;
  reason: string;
  candidates: ModelCandidate[];
  skipped?: { candidate: ModelCandidate; reason: string }[];
  launchRequestPolicy?: string;
}

export interface AgentPreviewRequest {
  slug?: string;
  agentId?: string;
  choice?: AgentModelChoice;
  /** Omitted reads the saved binding. Null previews returning to the shared choice. */
  modelTiers?: AgentModelTiers | null;
}

export function previewEffort(candidate: ModelCandidate, providers?: import('../agent/languagemodels/modelRoutingTypes').RoutingProviderInfo[]): string {
  const model = providers?.find(row => row.id === candidate.provider)?.models.find(row => row.id === candidate.model);
  const label = (id: string) => id === 'xhigh' ? 'Extra high' : id[0].toUpperCase() + id.slice(1);
  if (candidate.effort) return label(candidate.effort);
  if (model?.defaultEffort) return 'Default (' + label(model.defaultEffort) + ')';
  if (candidate.provider === 'grok' && !model?.efforts?.length) return 'No effort setting';
  return 'Provider default';
}
