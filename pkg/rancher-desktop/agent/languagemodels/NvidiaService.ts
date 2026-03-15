import { OpenAICompatibleService } from './OpenAICompatibleService';
import { type LLMServiceConfig } from './BaseLanguageModel';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * NVIDIA NIM LLM provider.
 * OpenAI-compatible API at https://integrate.api.nvidia.com/v1
 */
export class NvidiaService extends OpenAICompatibleService {
  static async create(): Promise<NvidiaService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('nvidia');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new NvidiaService({
      id:      'nvidia',
      model:   valMap.model || 'meta/llama-3.1-405b-instruct',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

// Factory
let nvidiaInstance: NvidiaService | null = null;

export async function getNvidiaService(): Promise<NvidiaService> {
  if (!nvidiaInstance) {
    nvidiaInstance = await NvidiaService.create();
  }
  return nvidiaInstance;
}

export function resetNvidiaService(): void {
  nvidiaInstance = null;
}
