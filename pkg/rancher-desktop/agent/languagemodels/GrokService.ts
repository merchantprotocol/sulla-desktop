import { OpenAICompatibleService } from './OpenAICompatibleService';
import { type LLMServiceConfig } from './BaseLanguageModel';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * xAI Grok LLM provider.
 * OpenAI-compatible API at https://api.x.ai/v1
 */
export class GrokService extends OpenAICompatibleService {
  static async create(): Promise<GrokService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('grok');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new GrokService({
      id: 'grok',
      model: valMap.model || '',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

// Factory
let grokInstance: GrokService | null = null;

export async function getGrokService(): Promise<GrokService> {
  if (!grokInstance) {
    grokInstance = await GrokService.create();
  }
  return grokInstance;
}

export function resetGrokService(): void {
  grokInstance = null;
}
