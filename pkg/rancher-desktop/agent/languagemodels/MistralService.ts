import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Mistral AI — includes free-tier Codestral for coding tasks.
 * OpenAI-compatible API at https://api.mistral.ai/v1
 */
export class MistralService extends OpenAICompatibleService {
  static async create(): Promise<MistralService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('mistral');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new MistralService({
      id:      'mistral',
      model:   valMap.model || '',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

let mistralInstance: MistralService | null = null;

export async function getMistralService(): Promise<MistralService> {
  if (!mistralInstance) {
    mistralInstance = await MistralService.create();
  }
  return mistralInstance;
}

export function resetMistralService(): void {
  mistralInstance = null;
}
