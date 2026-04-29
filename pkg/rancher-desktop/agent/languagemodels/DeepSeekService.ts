import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * DeepSeek LLM provider.
 * OpenAI-compatible API at https://api.deepseek.com
 *
 * Free tier: 500M tokens/day for API usage
 * Models: deepseek-v4-flash, deepseek-v4-pro
 * All models support tool use
 * 
 * Note: deepseek-chat and deepseek-reasoner deprecated 2026/07/24
 */
export class DeepSeekService extends OpenAICompatibleService {
  static async create(): Promise<DeepSeekService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('deepseek');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new DeepSeekService({
      id:      'deepseek',
      model:   valMap.model || 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }

  /**
   * DeepSeek requires a valid API key for health check.
   */
  protected async healthCheck(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    try {
      const response = await fetch('https://api.deepseek.com/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Factory
let deepseekInstance: DeepSeekService | null = null;

export async function getDeepSeekService(): Promise<DeepSeekService> {
  if (!deepseekInstance) {
    deepseekInstance = await DeepSeekService.create();
  }
  return deepseekInstance;
}

export function resetDeepSeekService(): void {
  deepseekInstance = null;
}
