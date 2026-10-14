import { getUsageSummary } from '../../usage/providerUsage';
import { BaseTool, ToolResponse } from '../base';

export class ModelsUsageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const provider = typeof input.provider === 'string' && input.provider.trim()
      ? input.provider.trim()
      : undefined;
    const model = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : undefined;
    const profileId = typeof input.profile_id === 'string' && input.profile_id.trim()
      ? input.profile_id.trim()
      : 'default';
    const hours = typeof input.hours === 'number' && Number.isFinite(input.hours) && input.hours > 0
      ? input.hours
      : 24;
    const summary = await getUsageSummary(hours, profileId, provider);

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        source: 'Local Sulla usage telemetry and meterable usage ledger',
        note: 'Costs are API-equivalent estimates, not subscription charges or a provider bill. A missing limit snapshot means the provider CLI has not emitted limit data yet.',
        filters: { provider: provider ?? null, model: model ?? null },
        ...summary,
        models: model ? summary.models.filter(row => row.model === model) : summary.models,
      }, null, 2),
    };
  }
}
