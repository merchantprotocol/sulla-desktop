import { OpenAICompatibleService } from './OpenAICompatibleService';
import { type LLMServiceConfig } from './BaseLanguageModel';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Alibaba Cloud (DashScope / Model Studio) LLM provider.
 * OpenAI-compatible API at https://coding-intl.dashscope.aliyuncs.com/v1 (Coding Plan)
 * Provides access to MiniMax, Kimi K2.5, Qwen, and other models.
 */
export class AlibabaService extends OpenAICompatibleService {
  static async create(): Promise<AlibabaService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('alibaba');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    return new AlibabaService({
      id:      'alibaba',
      model:   valMap.model || 'qwen-plus',
      baseUrl: valMap.base_url || 'https://coding-intl.dashscope.aliyuncs.com/v1',
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }
}

// Factory
let alibabaInstance: AlibabaService | null = null;

export async function getAlibabaService(): Promise<AlibabaService> {
  if (!alibabaInstance) {
    alibabaInstance = await AlibabaService.create();
  }
  return alibabaInstance;
}

export function resetAlibabaService(): void {
  alibabaInstance = null;
}
