// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type LLMServiceConfig, type ChatMessage } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

/**
 * Alibaba Cloud (DashScope / Model Studio) LLM provider.
 * OpenAI-compatible API at a DashScope regional endpoint.
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

    const plan = valMap.plan || 'payg';
    const region = valMap.region || 'intl';
    const baseUrl = plan === 'coding'
      ? (region === 'cn' ? 'https://coding.dashscope.aliyuncs.com/v1' : 'https://coding-intl.dashscope.aliyuncs.com/v1')
      : ({ intl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', us: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', cn: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } as Record<string, string>)[region] || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

    return new AlibabaService({
      id:      'alibaba',
      model:   valMap.model || 'qwen3.5-plus',
      baseUrl,
      apiKey:  valMap.api_key || '',
    });
  }

  constructor(config: LLMServiceConfig) {
    super(config);
  }

  /**
   * DashScope coding models require strict JSON in function.arguments and
   * reject additionalProperties in tool parameter schemas.  Sanitize the
   * request body before it's sent.
   */
  protected override buildRequestBody(messages: ChatMessage[], options: any): any {
    const body = super.buildRequestBody(messages, options);

    // Strip additionalProperties from tool parameter schemas — some DashScope
    // code models reject it.
    if (body.tools) {
      for (const tool of body.tools) {
        if (tool?.function?.parameters) {
          delete tool.function.parameters.additionalProperties;
        }
      }
    }

    return body;
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
