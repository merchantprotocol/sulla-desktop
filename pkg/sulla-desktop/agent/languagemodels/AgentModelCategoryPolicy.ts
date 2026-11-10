// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MODEL_CLASSES, type AgentModelChoice, type ModelClass } from './modelRoutingTypes';

/** Agent requirements describe capability, never an account or an exact model.
 * Exact user chat selections are handled separately by ThreadModelOverridePolicy.
 */
export class AgentModelCategoryPolicy {
  resolve(input: { choice?: AgentModelChoice | null; model?: unknown; slot?: unknown; slug?: string }): { mode: 'class'; class: ModelClass } {
    if (input.choice?.mode === 'class' && MODEL_CLASSES.includes(input.choice.class)) return { mode: 'class', class: input.choice.class };
    const legacy = String(input.choice?.mode === 'pin' ? input.choice.model : input.model ?? '').toLowerCase();
    if (MODEL_CLASSES.includes(legacy as ModelClass)) return { mode: 'class', class: legacy as ModelClass };
    if (/(haiku|mini|flash|nano|lite|luna|fast)/.test(legacy) || input.slot === 'subconscious') return { mode: 'class', class: 'fast' };
    if (/(opus|astra|fable|powerful)/.test(legacy)) return { mode: 'class', class: 'frontier' };
    if (/(codex|coder)/.test(legacy) || /cod(e|ing)|test-implementer|technical-architect/.test(input.slug ?? '')) return { mode: 'class', class: 'coding' };
    if (/(sonnet|sol|turbo|balanced)/.test(legacy)) return { mode: 'class', class: 'standard' };
    if (input.slot === 'primary') return { mode: 'class', class: 'frontier' };
    return { mode: 'class', class: 'standard' };
  }

  config(config: Record<string, unknown>, choice: { mode: 'class'; class: ModelClass }): Record<string, unknown> {
    const { provider: _provider, model: _model, modelSlot: _slot, modelPriority: _priority, model_choice: _snake, ...rest } = config;
    return { ...rest, modelChoice: choice };
  }
}
