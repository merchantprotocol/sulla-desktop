import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

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

    return new CerebasService({
      id:      'cerebras',
      model:   valMap.model || '',
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
