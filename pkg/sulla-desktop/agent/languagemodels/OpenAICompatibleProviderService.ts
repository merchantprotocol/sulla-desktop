// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseLanguageModel, type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';
import { openAICompatibleProvider, providerBaseUrl, type OpenAICompatibleProviderDefinition, type OpenAICompatibleProviderId } from './openAICompatibleProviders';

export class TableOpenAICompatibleService extends OpenAICompatibleService {
  constructor(config: LLMServiceConfig, private readonly definition: OpenAICompatibleProviderDefinition) { super(config); }

  protected override brokerInjections() {
    return this.definition.authHeader === 'api-key'
      ? [{ field: 'api_key', target: 'header' as const, name: 'api-key', scheme: 'raw' as const }]
      : super.brokerInjections();
  }

  protected override healthCheck(): Promise<boolean> {
    if (this.definition.local) return Promise.resolve(!!this.config.baseUrl);
    return super.healthCheck();
  }

  protected override buildFetchOptions(body: any, signal?: AbortSignal): RequestInit {
    const options = super.buildFetchOptions(body, signal);
    options.headers = { ...(options.headers as Record<string, string>), ...(this.definition.extraHeaders || {}) };
    return options;
  }
}

const instances = new Map<string, TableOpenAICompatibleService>();

export async function getOpenAICompatibleProviderService(id: OpenAICompatibleProviderId): Promise<BaseLanguageModel> {
  const existing = instances.get(id);
  if (existing) return existing;
  const definition = openAICompatibleProvider(id)!;
  const values = Object.fromEntries((await getIntegrationService().getFormValues(id)).map(value => [value.property, value.value]));
  const { resolveFirstChatModel } = await import('./ModelDiscoveryService');
  const model = values.model || await resolveFirstChatModel(id, values.api_key, providerBaseUrl(definition, values));
  if (!model) throw new Error(`${ definition.name } returned no chat models; reconnect the account and choose a model`);
  const service = new TableOpenAICompatibleService({ id, model, baseUrl: providerBaseUrl(definition, values), apiKey: values.api_key || '' }, definition);
  instances.set(id, service);
  return service;
}
