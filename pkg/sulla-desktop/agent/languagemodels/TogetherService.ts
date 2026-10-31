// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';
import { resolveFirstChatModel } from './ModelDiscoveryService';

/**
 * Together AI — free credits + large open-model catalog.
 * OpenAI-compatible API at https://api.together.xyz/v1
 */
export class TogetherService extends OpenAICompatibleService {
  static async create(): Promise<TogetherService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('together');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    const model = valMap.model || await resolveFirstChatModel('together', valMap.api_key);
    if (!model) throw new Error('Together returned no chat models; reconnect the account and choose a model');

    return new TogetherService({
      id:      'together',
      model,
      baseUrl: 'https://api.together.xyz/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

let togetherInstance: TogetherService | null = null;

export async function getTogetherService(): Promise<TogetherService> {
  if (!togetherInstance) {
    togetherInstance = await TogetherService.create();
  }
  return togetherInstance;
}

export function resetTogetherService(): void {
  togetherInstance = null;
}
