import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

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

    return new CustomService({
      id:      'custom',
      model:   valMap.model || '',
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
