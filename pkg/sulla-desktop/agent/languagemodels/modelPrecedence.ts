// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { effectiveModelChoice, providerForModelId } from './threadModelChoice';

import type { AgentModelChoice } from './modelRoutingTypes';
import type { WorkerModelRoute } from './workerModelBindings';

export type LaunchModelPrecedenceStep = 'override' | 'agent-mapping' | 'agent-pin' | 'category';

export interface ModelDecision {
  requested: { provider: string; model: string; effort?: string } | null;
  ran: { provider: string; model: string } | null;
  step: LaunchModelPrecedenceStep;
  reason?: string;
}

export interface LaunchModelPrecedence {
  step: LaunchModelPrecedenceStep;
  requested: ModelDecision['requested'];
  workerModelRoute?: WorkerModelRoute;
  choice: AgentModelChoice;
  reason?: string;
}

export interface ResolveLaunchModelPrecedenceInput {
  override?: { provider?: unknown; model?: unknown; effort?: unknown };
  workerModelRoute?: WorkerModelRoute;
  agentChoice?: AgentModelChoice | null;
}

const unavailable = (provider: string, model: string): Error => new Error(
  `Requested model ${ provider || 'unknown' }/${ model || 'unspecified' } is not available (not connected or unknown); refusing to run a different model.`,
);

/** Resolve a launch once, in the same order used by hidden jobs, tabs and parked-job recovery. */
export function resolveLaunchModelPrecedence(input: ResolveLaunchModelPrecedenceInput): LaunchModelPrecedence {
  const provider = String(input.override?.provider ?? '').trim();
  const model = String(input.override?.model ?? '').trim();
  const effort = input.override?.effort;
  const hasModelOverride = Boolean(provider || model);

  if (hasModelOverride) {
    const resolvedProvider = provider || providerForModelId(model);
    if (!resolvedProvider || !model) throw unavailable(resolvedProvider || (provider || 'unknown'), model);
    try {
      const choice = effectiveModelChoice({ provider: resolvedProvider, model, effort });
      if (choice.mode !== 'pin' || choice.provider !== resolvedProvider || choice.model !== model) throw unavailable(resolvedProvider, model);
      return {
        step: 'override',
        requested: { provider: resolvedProvider, model, ...(typeof effort === 'string' ? { effort } : {}) },
        choice,
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Requested model ')) throw error;
      throw unavailable(resolvedProvider, model);
    }
  }

  const route = input.workerModelRoute;
  const selected = route?.candidates?.[route.selected];
  if (route && selected) {
    return {
      step: 'agent-mapping',
      requested: { provider: selected.provider, model: selected.model, ...(selected.effort ? { effort: selected.effort } : {}) },
      workerModelRoute: route,
      choice: { mode: 'list' },
      ...(effort !== undefined ? { reason: 'Per-run effort was ignored because the saved agent mapping takes precedence.' } : {}),
    };
  }

  const choice = input.agentChoice ?? { mode: 'list' as const };
  if (choice.mode === 'pin') {
    return {
      step: 'agent-pin',
      requested: { provider: choice.provider, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) },
      choice,
    };
  }
  return { step: 'category', requested: null, choice };
}
