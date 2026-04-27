import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

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

    return new TogetherService({
      id:      'together',
      model:   valMap.model || '',
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
