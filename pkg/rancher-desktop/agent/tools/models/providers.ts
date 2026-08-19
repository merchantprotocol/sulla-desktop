import { getModelProviderService } from '../../services/ModelProviderService';
import { BaseTool, ToolResponse } from '../base';
import { getAiProviderIntegrations, getProviderRuntimeStatus } from './shared';

export class ModelsProvidersWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const includeDisconnected = input.include_disconnected !== false;
    const providers = getAiProviderIntegrations();
    const modelState = getModelProviderService().getState();

    const statuses = (await Promise.all(
      providers.map(provider => getProviderRuntimeStatus(provider.id)),
    )).filter((status): status is NonNullable<typeof status> => !!status);

    const visible = includeDisconnected
      ? statuses
      : statuses.filter(status => status.connected);

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        active: {
          primaryProvider:      modelState.primaryProvider,
          primaryModelId:       modelState.activeModelId,
          secondaryProvider:    modelState.secondaryProvider,
          secondaryModelId:     modelState.secondaryModelId,
          heartbeatProvider:    modelState.heartbeatProvider,
          heartbeatModelId:     modelState.heartbeatModelId,
          subconsciousProvider: modelState.subconsciousProvider,
          subconsciousModelId:  modelState.subconsciousModelId,
        },
        providers: visible,
      }, null, 2),
    };
  }
}
