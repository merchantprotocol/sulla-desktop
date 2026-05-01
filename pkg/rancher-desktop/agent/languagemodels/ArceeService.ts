import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Arcee AI LLM provider.
 * OpenAI-compatible API at https://api.arcee.ai/api/v1
 *
 * Models: Trinity Large Thinking, Trinity Mini, Trinity Large Preview
 * Supports tool use
 */
export class ArceeService extends OpenAICompatibleService {
  protected override chatEndpoint = '/api/v1/chat/completions';

  static async create(): Promise<ArceeService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('arcee');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new ArceeService({
      id:      'arcee',
      model:   valMap.model || 'trinity-large-thinking',
      baseUrl: 'https://api.arcee.ai',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }

  /**
   * Arcee requires a valid API key for health check.
   */
  protected async healthCheck(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/models`, {
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
let arceeInstance: ArceeService | null = null;

export async function getArceeService(): Promise<ArceeService> {
  if (!arceeInstance) {
    arceeInstance = await ArceeService.create();
  }
  return arceeInstance;
}

export function resetArceeService(): void {
  arceeInstance = null;
}
