// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * OpenAI LLM provider.
 * Standard OpenAI-compatible API at https://api.openai.com/v1
 */
export class OpenAIService extends OpenAICompatibleService {
  static async create(): Promise<OpenAIService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('openai');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }
    try {
      const { getPendingCredential } = await import('../../main/firstRun/pendingCredentials');
      Object.assign(valMap, getPendingCredential('openai')?.values || {});
    } catch { /* pending credentials exist only in the main process */ }

    return new OpenAIService({
      id:      'openai',
      model:   valMap.model || '',
      baseUrl: 'https://api.openai.com/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

// Factory
let openaiInstance: OpenAIService | null = null;

export async function getOpenAIService(): Promise<OpenAIService> {
  if (!openaiInstance) {
    openaiInstance = await OpenAIService.create();
  }
  return openaiInstance;
}

export function resetOpenAIService(): void {
  openaiInstance = null;
}
