import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Ollama — local open-source model runner, fully free.
 * OpenAI-compatible API, default at http://localhost:11434/v1
 * Set base_url to host.lima.internal:11434 if running on the host Mac.
 */
export class OllamaService extends OpenAICompatibleService {
  static async create(): Promise<OllamaService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('ollama');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new OllamaService({
      id:      'ollama',
      model:   valMap.model || '',
      baseUrl: valMap.base_url || 'http://localhost:11434/v1',
      apiKey:  valMap.api_key || 'ollama',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }

  protected async healthCheck(): Promise<boolean> {
    return !!this.baseUrl;
  }
}

let ollamaInstance: OllamaService | null = null;

export async function getOllamaService(): Promise<OllamaService> {
  if (!ollamaInstance) {
    ollamaInstance = await OllamaService.create();
  }
  return ollamaInstance;
}

export function resetOllamaService(): void {
  ollamaInstance = null;
}
