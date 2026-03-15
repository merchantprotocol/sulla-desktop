import { OpenAICompatibleService } from './OpenAICompatibleService';
import { type LLMServiceConfig } from './BaseLanguageModel';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Kimi (Moonshot AI) LLM provider.
 * OpenAI-compatible API at https://api.moonshot.cn/v1
 */
export class KimiService extends OpenAICompatibleService {
  static async create(): Promise<KimiService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('kimi');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new KimiService({
      id:      'kimi',
      model:   valMap.model || 'moonshot-v1-128k',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

// Factory
let kimiInstance: KimiService | null = null;

export async function getKimiService(): Promise<KimiService> {
  if (!kimiInstance) {
    kimiInstance = await KimiService.create();
  }
  return kimiInstance;
}

export function resetKimiService(): void {
  kimiInstance = null;
}
