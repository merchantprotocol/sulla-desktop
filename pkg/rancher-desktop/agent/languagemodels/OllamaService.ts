import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Ollama — a user-run Ollama server connected as a custom model provider.
 * Sulla does not bundle, install or manage Ollama; it talks to the server's
 * OpenAI-compatible API at the base_url the user configured.
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
