import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Groq inference platform — fast free-tier LLM inference.
 * OpenAI-compatible API at https://api.groq.com/openai/v1
 */
export class GroqService extends OpenAICompatibleService {
  static async create(): Promise<GroqService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('groq');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new GroqService({
      id:      'groq',
      model:   valMap.model || '',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

let groqInstance: GroqService | null = null;

export async function getGroqService(): Promise<GroqService> {
  if (!groqInstance) {
    groqInstance = await GroqService.create();
  }
  return groqInstance;
}

export function resetGroqService(): void {
  groqInstance = null;
}
