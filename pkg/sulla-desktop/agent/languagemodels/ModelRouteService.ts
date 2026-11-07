// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BaseLanguageModel } from './BaseLanguageModel';
import type { ModelDispatchService, RoutedModelService } from './ModelDispatchService';
import type { AgentModelChoice } from './modelRoutingTypes';

/** Owns every production model-choice entry point after candidate resolution. */
export class ModelRouteService {
  private lastSubconsciousResolution = '';

  constructor(
    private readonly dispatch: ModelDispatchService,
    private readonly trace: (category: string, event: string, details: Record<string, unknown>) => void,
  ) {}

  resolve(target: 'agents'|'subconscious', choice: AgentModelChoice): Promise<RoutedModelService | null> {
    return this.dispatch.resolve(target, choice);
  }

  async remote(overrideModel?: string): Promise<BaseLanguageModel | null> {
    const candidates = await this.dispatch.candidates('agents', { mode: 'list' });
    const selected = candidates[0];
    if (!selected) return null;
    return this.dispatch.service({ ...selected, model: overrideModel || selected.model });
  }

  async primary(): Promise<BaseLanguageModel | null> {
    const routed = await this.resolve('agents', { mode: 'list' });
    if (!routed) return null;
    const selected = routed.candidates[0];
    this.trace('models', 'primary service resolved', { providerId: selected.provider, modelOverride: selected.model });
    return routed.service;
  }

  async subconscious(): Promise<BaseLanguageModel | null> {
    const routed = await this.resolve('subconscious', { mode: 'list' });
    if (!routed) return null;
    const selected = routed.candidates[0];
    const signature = `${ selected.provider }|${ selected.model }`;
    if (signature !== this.lastSubconsciousResolution) {
      this.lastSubconsciousResolution = signature;
      console.log(`[SubconsciousLLM] provider=${ selected.provider } effectiveModel=${ selected.model }`);
    }
    return routed.service;
  }
}
