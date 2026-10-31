// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';
import { resolveFirstChatModel } from './ModelDiscoveryService';

/**
 * Custom OpenAI-compatible LLM provider.
 * User-defined base URL with optional API key.
 */
export class CustomService extends OpenAICompatibleService {
  static async create(): Promise<CustomService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('custom');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    const model = valMap.model || await resolveFirstChatModel('custom', valMap.api_key, valMap.base_url);
    if (!model) throw new Error('The custom endpoint returned no chat models; reconnect it and choose a model');

    return new CustomService({
      id:      'custom',
      model,
      baseUrl: valMap.base_url || '',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }

  /**
   * Custom provider only needs a valid baseUrl (API key is optional).
   */
  protected async healthCheck(): Promise<boolean> {
    return !!this.baseUrl;
  }
}

// Factory
let customInstance: CustomService | null = null;

export async function getCustomService(): Promise<CustomService> {
  if (!customInstance) {
    customInstance = await CustomService.create();
  }
  return customInstance;
}

export function resetCustomService(): void {
  customInstance = null;
}
