// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';
import { resolveFirstChatModel } from './ModelDiscoveryService';

/**
 * Groq inference platform — fast free-tier LLM inference.
 * OpenAI-compatible API at https://api.groq.com/openai/v1
 */
export class GroqService extends OpenAICompatibleService {
  static async create(): Promise<GroqService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('groq');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    const model = valMap.model || await resolveFirstChatModel('groq', valMap.api_key);
    if (!model) throw new Error('Groq returned no chat models; reconnect the account and choose a model');

    return new GroqService({
      id:      'groq',
      model,
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

let groqInstance: GroqService | null = null;

export async function getGroqService(): Promise<GroqService> {
  if (!groqInstance) {
    groqInstance = await GroqService.create();
  }
  return groqInstance;
}

export function resetGroqService(): void {
  groqInstance = null;
}
