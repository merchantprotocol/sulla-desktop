import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Cohere LLM provider.
 * OpenAI-compatible API at https://api.cohere.ai/compatibility/v1
 *
 * Free tier: 1,000 API calls/month (non-commercial use)
 * Models: Command A, Command R, Command R+, Command R7B (all support tool use)
 * Note: Aya models do NOT support tool use and are excluded
 */
export class CohereService extends OpenAICompatibleService {
  static async create(): Promise<CohereService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('cohere');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new CohereService({
      id:      'cohere',
      model:   valMap.model || 'command-r',
      baseUrl: 'https://api.cohere.ai/compatibility/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }

  /**
   * Cohere requires a valid API key for health check.
   * Uses v2 API for models endpoint.
   */
  protected async healthCheck(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    try {
      const response = await fetch('https://api.cohere.com/v2/models', {
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
let cohereInstance: CohereService | null = null;

export async function getCohereService(): Promise<CohereService> {
  if (!cohereInstance) {
    cohereInstance = await CohereService.create();
  }
  return cohereInstance;
}

export function resetCohereService(): void {
  cohereInstance = null;
}
