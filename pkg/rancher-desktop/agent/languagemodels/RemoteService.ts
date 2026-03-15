/**
 * @deprecated Use provider-specific services instead:
 *   - GrokService, OpenAIService, AnthropicService, GoogleService,
 *     KimiService, NvidiaService, CustomService
 *
 * This file is kept for backward compatibility only.
 * RemoteModelService is now an alias for OpenAICompatibleService.
 */
import { OpenAICompatibleService } from './OpenAICompatibleService';
import type { RemoteProviderConfig } from './BaseLanguageModel';

/** @deprecated Use provider-specific services */
export class RemoteModelService extends OpenAICompatibleService {
  constructor(config: RemoteProviderConfig) {
    super({
      id:      config.id,
      model:   config.model,
      baseUrl: config.baseUrl,
      apiKey:  config.apiKey,
    });
  }
}

/** @deprecated Use provider-specific service factories */
export function createRemoteModelService(config: RemoteProviderConfig): RemoteModelService {
  return new RemoteModelService(config);
}
