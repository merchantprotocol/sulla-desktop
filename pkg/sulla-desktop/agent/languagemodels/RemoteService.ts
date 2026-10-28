// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
      accountId: config.accountId,
    });
  }
}

/** @deprecated Use provider-specific service factories */
export function createRemoteModelService(config: RemoteProviderConfig): RemoteModelService {
  return new RemoteModelService(config);
}
