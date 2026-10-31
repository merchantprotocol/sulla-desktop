// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getModelProviderService } from '../../services/ModelProviderService';
import { BaseTool, ToolResponse } from '../base';
import { getProviderRuntimeStatus } from './shared';

export class ModelsListWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const providerId = String(input.provider ?? '').trim();
    if (!providerId) {
      return { successBoolean: false, responseString: 'provider is required.' };
    }

    const status = await getProviderRuntimeStatus(providerId);
    if (!status) {
      return { successBoolean: false, responseString: `Unknown AI provider: ${ providerId }` };
    }

    const liveModels = await getModelProviderService().getModelsForProvider(providerId);
    const models = liveModels.map(model => ({ ...model, source: 'provider-or-cli' }));

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        provider: {
          id:               status.providerId,
          name:             status.name,
          connected:        status.connected,
          commandLine:      status.commandLine,
          sullaCompatible:  status.sullaCompatible,
          ready:            status.ready,
        },
        modelCount: models.length,
        models,
      }, null, 2),
    };
  }
}
