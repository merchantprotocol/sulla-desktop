// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';
import { resolveFirstChatModel } from './ModelDiscoveryService';

/**
 * NVIDIA NIM LLM provider.
 * OpenAI-compatible API at https://integrate.api.nvidia.com/v1
 */
export class NvidiaService extends OpenAICompatibleService {
  static async create(): Promise<NvidiaService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('nvidia');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    const model = valMap.model || await resolveFirstChatModel('nvidia', valMap.api_key);
    if (!model) throw new Error('NVIDIA returned no chat models; reconnect the account and choose a model');

    return new NvidiaService({
      id:      'nvidia',
      model,
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

// Factory
let nvidiaInstance: NvidiaService | null = null;

export async function getNvidiaService(): Promise<NvidiaService> {
  if (!nvidiaInstance) {
    nvidiaInstance = await NvidiaService.create();
  }
  return nvidiaInstance;
}

export function resetNvidiaService(): void {
  nvidiaInstance = null;
}
