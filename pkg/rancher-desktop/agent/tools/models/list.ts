import { getModelProviderService } from '../../services/ModelProviderService';
import { BaseTool, ToolResponse } from '../base';
import { getProviderRuntimeStatus, getStaticModels } from './shared';

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
    const staticModels = getStaticModels(providerId);
    const models = liveModels.length > 0
      ? liveModels.map(model => ({ ...model, source: 'provider-or-cli' }))
      : staticModels.map(model => ({ ...model, source: 'static-catalog' }));

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
