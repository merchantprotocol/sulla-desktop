// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';
import { resolveFirstChatModel } from './ModelDiscoveryService';

/**
 * Cerebras inference platform — very fast free-tier LLM inference.
 * OpenAI-compatible API at https://api.cerebras.ai/v1
 */
export class CerebasService extends OpenAICompatibleService {
  static async create(): Promise<CerebasService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('cerebras');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    const model = valMap.model || await resolveFirstChatModel('cerebras', valMap.api_key);
    if (!model) throw new Error('Cerebras returned no chat models; reconnect the account and choose a model');

    return new CerebasService({
      id:      'cerebras',
      model,
      baseUrl: 'https://api.cerebras.ai/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

let cerebasInstance: CerebasService | null = null;

export async function getCerebasService(): Promise<CerebasService> {
  if (!cerebasInstance) {
    cerebasInstance = await CerebasService.create();
  }
  return cerebasInstance;
}

export function resetCerebasService(): void {
  cerebasInstance = null;
}
